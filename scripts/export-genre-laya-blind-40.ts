// Lote reproducible de referencia: 20 álbumes y 20 artistas con principal
// confirmado por reglas del catálogo. El archivo de entrada nunca contiene el
// género confirmado; las etiquetas se guardan aparte y se consultan después.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { closeDb, getPool } from "../src/db/client.js";
import { genreEntityDetail } from "../src/genres/curation.js";
import { buildLayaPilotCase, type PilotBiography, type PilotCase, type PilotSource } from "../src/genres/laya-pilot.js";
import { loadTaxonomy } from "../src/genres/store.js";

const DATE = "2026-09-26";
const ROOT = path.resolve("reports");
const INPUT = path.join(ROOT, `genre-laya-blind-40-cases-${DATE}.jsonl`);
const GOLD = path.join(ROOT, `genre-laya-blind-40-reference-${DATE}.jsonl`);
const PREVIOUS = [
  `genre-laya-reviewed-cases-${DATE}.jsonl`,
  `genre-laya-holdout-cases-${DATE}.jsonl`,
];

type Kind = "album" | "artist";
type Row = { kind: Kind; entity_id: string; title: string; slug: string; assignment_id: string; claim_ids: string[]; source_kind: string };

async function biographies(client: PoolClient, artistId: number): Promise<PilotBiography[]> {
  const { rows } = await client.query<{ id: string; value: string | null; source_slug: string; url: string | null }>(`
    SELECT c.id::text, c.raw_value #>> '{}' AS value, s.slug AS source_slug, ev.url
      FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
      LEFT JOIN LATERAL (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id = c.id ORDER BY e.id LIMIT 1) ev ON true
     WHERE c.entity_kind = 'artist' AND c.artist_id = $1 AND c.field = 'biography' AND c.status::text = 'accepted'
     ORDER BY c.id DESC LIMIT 3`, [artistId]);
  return rows.filter((row) => row.value?.trim()).map((row) => ({
    claimId: Number(row.id), sourceSlug: row.source_slug, text: row.value!, url: row.url,
  }));
}

async function excludedIds(): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const filename of PREVIOUS) {
    const body = await readFile(path.join(ROOT, filename), "utf8");
    for (const line of body.split(/\r?\n/u)) {
      if (line.trim()) ids.add((JSON.parse(line) as { caseId: string }).caseId);
    }
  }
  return ids;
}

async function main(): Promise<void> {
  const excluded = await excludedIds();
  const client = await getPool().connect();
  const cases: PilotCase[] = [];
  const reference: Array<Record<string, unknown>> = [];
  try {
    const taxonomy = await loadTaxonomy(client);
    // Una entidad por género antes de tomar una segunda: variedad sin mirar
    // la salida de Laya ni filtrar por si su respuesta está entre las opciones.
    const { rows } = await client.query<Row>(`
      WITH known AS (
        SELECT 'album'::text AS kind, g.album_id::text AS entity_id, a.title, t.slug,
               g.id::text AS assignment_id, g.claim_ids::text[] AS claim_ids, g.source_kind
          FROM ingest.album_genres g JOIN public.albums a ON a.id = g.album_id JOIN ingest.genres t ON t.id = g.genre_id
         WHERE g.role = 'primary' AND g.status = 'confirmed' AND g.decision_kind = 'rule'
           AND g.source_kind = 'catalog_source' AND t.active
        UNION ALL
        SELECT 'artist', g.artist_id::text, a.name, t.slug, g.id::text, g.claim_ids::text[], g.source_kind
          FROM ingest.artist_genres g JOIN public.artists a ON a.id = g.artist_id JOIN ingest.genres t ON t.id = g.genre_id
         WHERE g.role = 'primary' AND g.status = 'confirmed' AND g.decision_kind = 'rule'
           AND g.source_kind = 'catalog_source' AND t.active
           AND EXISTS (SELECT 1 FROM ingest.claims c WHERE c.entity_kind = 'artist' AND c.artist_id = g.artist_id
                         AND c.field = 'biography' AND c.status::text = 'accepted')
      ), ranked AS (
        SELECT *, row_number() OVER (PARTITION BY kind, slug ORDER BY md5(entity_id)) AS genre_rank FROM known
      )
      SELECT * FROM ranked ORDER BY kind, genre_rank, slug, md5(entity_id)`);
    for (const kind of ["album", "artist"] as const) {
      for (const row of rows) {
        if (row.kind !== kind || excluded.has(`${kind}:${row.entity_id}`)) continue;
        if (cases.filter((item) => item.kind === kind).length >= 20) break;
        const entityId = Number(row.entity_id);
        const detail = await genreEntityDetail(client, kind, entityId);
        if (!detail) continue;
        const sources = kind === "album"
          ? ((detail["sources"] ?? []) as PilotSource[]).filter((item) => item.status === "accepted") : [];
        const bio = kind === "artist" ? await biographies(client, entityId) : [];
        const built = buildLayaPilotCase({
          kind, entityId, title: row.title, categories: ["confirmed_rule_reference"],
          sources, assignments: [], biographies: bio, taxonomy, allowConfirmedForEvaluation: true,
        });
        if (!built) continue;
        cases.push(built);
        reference.push({
          caseId: built.caseId, kind, title: row.title, primaryGenre: row.slug,
          referenceKind: "rule_confirmed", sourceKind: row.source_kind,
          assignmentId: Number(row.assignment_id), sourceClaimIds: row.claim_ids.map(Number),
          // Para álbumes, el mismo claim de género puede sustentar la regla y
          // estar en la entrada. Para artistas solo entra la biografía.
          evidenceMode: kind === "album" ? "album_genre_claim" : "artist_biography_only",
        });
      }
      const count = cases.filter((item) => item.kind === kind).length;
      if (count !== 20) throw new Error(`solo se encontraron ${count} ${kind}s elegibles`);
    }
  } finally {
    client.release();
    await closeDb();
  }
  await writeFile(INPUT, `${cases.map((item) => JSON.stringify(item)).join("\n")}\n`, { flag: "wx" });
  await writeFile(GOLD, `${reference.map((item) => JSON.stringify(item)).join("\n")}\n`, { flag: "wx" });
  console.log(`40 casos ciegos: ${INPUT}`);
  console.log(`Referencia separada: ${GOLD}`);
}

main().catch(async (error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  await closeDb();
  process.exitCode = 1;
});
