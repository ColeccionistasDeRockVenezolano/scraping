// CRV · Etapa 4 del nuevo lote (plan ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md §2.7 y §3):
// géneros de artista. NO escribe en la base.
//
// Convierte los claims `genre` del lote (etapa 1, ya enganchados a sus fichas
// en las etapas 1 y 2) en un libro de evidencia para
// scripts/apply-source-genres.ts --ledger=<libro>, que confirma el primero
// como principal y el resto como secundarios, solo en fichas sin principal
// confirmado, en un run reversible. Se respeta el orden del lote (géneros y
// luego subgéneros); un hijo nombrado después de su familia toma su puesto.
//
// Cada término se resuelve con la taxonomía; si no, con la tabla de
// equivalencias de la etapa 0 (reports/nuevo-lote-2026-10-02/generos.json y
// lote2/generos.json, estados «exacto» y «propuesta»: «Clasica» → Música
// clásica, «romantic ballad» → Balada…), y entonces el libro lleva el nombre
// del género de destino y el término original en `loteTerms`. «Gothic» suelto
// llega ya resuelto por contexto desde la etapa 1 (rock o metal gótico). Los
// «no género» se omiten; los términos sin equivalente NO se crean: van a la
// lista para Brian (decisión 7).
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa4-generos.ts
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";
import { loadTaxonomy } from "../src/genres/store.js";
import { resolveGenreValue } from "../src/genres/taxonomy.js";
import { compareKey } from "../src/ingest/lote-investigacion.js";
import { sourceSlugs, type LedgerRow } from "./genre-source-rows.js";

const SOURCE = "lote-investigacion-2026-10-02";
const LEDGER = "reports/genre-laya-evidence-lote-investigacion-2026-10-03.jsonl";
const LIST = "reports/nuevo-lote-2026-10-02/etapa4-generos-sin-equivalente.md";
const TABLES = ["reports/nuevo-lote-2026-10-02/generos.json", "reports/nuevo-lote-2026-10-02/lote2/generos.json"];

interface Equivalence { termino: string; estado: "exacto" | "propuesta" | "nuevo" | "no_genero"; slug: string | null }

interface ClaimRow { artist_id: string; name: string; raw: string; normalized: { slugs?: string[]; notAGenre?: string[]; unresolved?: string[] } | null; url: string | null; ord: number }

async function main(): Promise<void> {
  const client = await getPool().connect();
  try {
    const taxonomy = await loadTaxonomy(client);
    const table = new Map<string, Equivalence>();
    for (const file of TABLES) for (const row of JSON.parse(readFileSync(file, "utf8")) as Equivalence[]) table.set(compareKey(row.termino), row);
    const nameOf = new Map([...taxonomy.genres.values()].map((genre) => [genre.slug, genre.name]));
    const resolves = (value: string) => sourceSlugs(taxonomy, { caseId: "", kind: "artist", entityId: 0, source: SOURCE, url: "", rawGenres: [value] }).slugs.length > 0;
    const { rows } = await client.query<ClaimRow>(`
      SELECT c.artist_id::text, a.name, c.raw_value #>> '{}' AS raw, c.normalized_value AS normalized,
             (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id=c.id AND e.url ~ '^https?://' ORDER BY e.id LIMIT 1) AS url,
             coalesce(substring(c.notes FROM 'orden (\\d+)')::int, 0) AS ord
        FROM ingest.claims c
        JOIN ingest.sources s ON s.id=c.source_id AND s.slug=$1
        JOIN public.artists a ON a.id=c.artist_id
       WHERE c.field='genre' AND c.entity_kind='artist'
       ORDER BY c.artist_id, ord, c.id`, [SOURCE]);
    const byArtist = new Map<number, { name: string; raw: string[]; terms: Array<{ term: string; as: string; via: string }>; url: string | null }>();
    const unresolved = new Map<string, string[]>();
    const notGenre = new Set<string>();
    const viaTable = new Map<string, string>();
    for (const row of rows) {
      const entry = byArtist.get(Number(row.artist_id)) ?? { name: row.name, raw: [], terms: [], url: null };
      entry.url ??= row.url;
      byArtist.set(Number(row.artist_id), entry);
      let text = row.raw.trim();
      let via = "taxonomía";
      // «Gothic» suelto: la etapa 1 ya lo resolvió por contexto.
      if (/^(gothic|goth|g[oó]tico)$/i.test(text)) {
        text = (row.normalized?.slugs ?? []).includes("metal-gotico") ? "Gothic Metal" : "Gothic Rock";
        via = "regla de contexto de «Gothic» (etapa 1)";
      } else if (!resolves(text)) {
        const equivalence = table.get(compareKey(text));
        if (equivalence?.estado === "no_genero" || (equivalence === undefined && resolveGenreValue(taxonomy, text).items.length === 0)) {
          notGenre.add(text);
          continue;
        }
        const target = equivalence?.slug ? nameOf.get(equivalence.slug) : undefined;
        if (!target) {
          unresolved.set(text, [...(unresolved.get(text) ?? []), entry.name]);
          continue;
        }
        viaTable.set(text, `${equivalence!.slug} (${equivalence!.estado})`);
        via = `tabla de equivalencias de la etapa 0 (${equivalence!.estado})`;
        text = target;
      }
      if (!entry.raw.includes(text)) entry.raw.push(text);
      entry.terms.push({ term: row.raw, as: text, via });
    }
    const ledger: Array<LedgerRow & { loteTerms: Array<{ term: string; as: string; via: string }> }> = [];
    for (const [artistId, entry] of byArtist) {
      if (!entry.raw.length) continue;
      ledger.push({
        caseId: `artist:${artistId}`, kind: "artist", entityId: artistId, title: entry.name, source: SOURCE,
        url: entry.url ?? "file://~/Desktop/Nuevo lote (catálogo de investigación 2026-10-02)", rawGenres: entry.raw, loteTerms: entry.terms,
      });
    }
    writeFileSync(LEDGER, ledger.map((row) => JSON.stringify(row)).join("\n") + "\n");
    const sorted = [...unresolved.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
    writeFileSync(LIST, [
      "# Etapa 4 — términos de género del lote sin equivalente en la taxonomía", "",
      "No se crean (decisión 7 de Brian): quedan para decidir. El resto de los géneros de cada ficha sí entra.", "",
      `${sorted.length} términos en ${new Set(sorted.flatMap(([, names]) => names)).size} fichas.`, "",
      "| Término | Fichas |", "|---|---|",
      ...sorted.map(([term, names]) => `| ${term} | ${names.length}: ${[...new Set(names)].slice(0, 6).join(", ")}${names.length > 6 ? "…" : ""} |`), "",
      "## Resueltos con la tabla de equivalencias de la etapa 0", "",
      ...[...viaTable.entries()].sort().map(([term, as]) => `- ${term} → ${as}`), "",
      "## Omitidos por no ser género", "", [...notGenre].sort().join(", "), "",
    ].join("\n"));
    console.log(`→ ${LEDGER}: ${ledger.length} fichas · ${sorted.length} términos sin equivalente → ${LIST}`);
  } finally {
    client.release();
  }
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
