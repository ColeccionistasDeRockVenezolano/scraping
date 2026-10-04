// CRV · Etapa 4 del nuevo lote: los términos de género que no tenían
// equivalente y Brian aprobó el 2026-10-03 (lista en
// reports/nuevo-lote-2026-10-02/etapa4-generos-sin-equivalente.md).
//
// Las fichas que los nombran ya tienen principal (apply-source-genres no las
// toca), así que entran como secundarios, con el mismo camino que la Mesa
// (confirmGenre) y en UN run de operador. Solo estos términos: el resto de
// los géneros del lote sigue la regla «solo fichas sin principal».
// Sin --confirm corre entero y se deshace.
//
//   ./scripts/with-node22.sh npx tsx scripts/lote-etapa4-generos-secundarios.ts [--confirm]
import { readFileSync, writeFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { confirmGenre } from "../src/genres/human.js";
import { lockGenres } from "../src/genres/store.js";
import { compareKey } from "../src/ingest/lote-investigacion.js";
import { withOperatorRun } from "../src/merge/operator.js";

const LEDGER = "reports/genre-laya-evidence-lote-investigacion-2026-10-03.jsonl";
const REASON = "Etapa 4 del nuevo lote: término de género sin equivalente, aprobado por Brian el 2026-10-03";
// Término del lote → género (propuesta aprobada).
const APPROVED: Record<string, string> = {
  "jota": "jota-oriental", "música de cámara popular": "musica-de-camara-popular", "ritmo orquídea": "ritmo-orquidea",
  "gabán": "gaban", "Motivo Guaiquerí": "motivo-guaiqueri", "calipso tradicional callaoense": "calipso",
  "salsa fusión": "salsa", "fusión con salsa": "salsa", "fusión con merengue": "merengue-venezolano",
  "fusión con vallenato": "vallenato", "freestyle": "hip-hop", "ghost-wave": "darkwave",
  "música profana": "musica-coral", "Música académica regional": "musica-clasica",
};
const BY_KEY = new Map(Object.entries(APPROVED).map(([term, slug]) => [compareKey(term), slug]));

interface Row { entityId: number; title: string; loteTerms: Array<{ term: string }> }
interface Outcome { artistId: number; name: string; term: string; slug: string; result: "añadido" | "ya lo tenía" | "error"; detail?: string }

class DryRun extends Error {
  constructor(readonly outcomes: Outcome[]) { super("dry-run"); }
}

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const wanted: Array<{ artistId: number; name: string; term: string; slug: string }> = [];
  for (const line of readFileSync(LEDGER, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as Row;
    const seen = new Set<string>();
    for (const { term } of row.loteTerms) {
      const slug = BY_KEY.get(compareKey(term));
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      wanted.push({ artistId: row.entityId, name: row.title, term, slug });
    }
  }
  let runId: number | null = null;
  let outcomes: Outcome[];
  try {
    const done = await withOperatorRun({
      name: "genre_decision", operator: "brian", note: REASON, params: { genreAction: "add_secondary", lote: "nuevo-lote-2026-10-02", etapa: 4 },
    }, async ({ client, runId: run }) => {
      await lockGenres(client);
      const list: Outcome[] = [];
      for (const item of wanted) {
        const has = await client.query(
          `SELECT 1 FROM ingest.artist_genres ag JOIN ingest.genres g ON g.id=ag.genre_id
            WHERE ag.artist_id=$1 AND g.slug=$2 AND ag.status='confirmed'`, [item.artistId, item.slug]);
        if (has.rowCount) { list.push({ ...item, result: "ya lo tenía" }); continue; }
        await client.query("SAVEPOINT item");
        try {
          await confirmGenre(client, { kind: "artist", entityId: item.artistId, genreSlug: item.slug, role: "secondary", actor: "brian", reason: REASON, runId: run });
          await client.query("RELEASE SAVEPOINT item");
          list.push({ ...item, result: "añadido" });
        } catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT item");
          list.push({ ...item, result: "error", detail: (error as Error).message.slice(0, 200) });
        }
      }
      if (!confirm) throw new DryRun(list);
      return list;
    });
    runId = done.runId;
    outcomes = done.result;
  } catch (error) {
    if (!(error instanceof DryRun)) throw error;
    outcomes = error.outcomes;
  }
  const mode = confirm ? "confirm" : "dry-run";
  const lines = [
    `# Etapa 4 — géneros aprobados sin equivalente (${mode}${runId ? `, run ${runId}` : ""})`, "",
    `${outcomes.filter((o) => o.result === "añadido").length} añadidos como secundarios · ${outcomes.filter((o) => o.result === "ya lo tenía").length} ya estaban · ${outcomes.filter((o) => o.result === "error").length} errores`, "",
    "| Ficha | Término del lote | Género | Resultado |", "|---|---|---|---|",
    ...outcomes.map((o) => `| ${o.name} (${o.artistId}) | ${o.term} | ${o.slug} | ${o.result}${o.detail ? `: ${o.detail}` : ""} |`), "",
  ];
  const file = `reports/nuevo-lote-2026-10-02/etapa4-generos-aprobados-${mode}${runId ? `-run${runId}` : ""}.md`;
  writeFileSync(file, lines.join("\n"));
  console.log(`${lines[2]} → ${file}`);
}

main().finally(() => closeDb()).catch((error) => { console.error(error); process.exitCode = 1; });
