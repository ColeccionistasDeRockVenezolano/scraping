// Vuelca como libro de evidencia los claims de género ya extraídos (Sincopa,
// Descargas Metal…) de fichas que siguen sin principal, para que
// scripts/apply-source-genres.ts los confirme con la regla «una fuente basta».
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";

const { rows } = await getPool().query<{ kind: string; entity_id: string; slug: string; raw_value: string; url: string | null }>(`
  SELECT CASE WHEN c.album_id IS NOT NULL THEN 'album' ELSE 'artist' END AS kind,
         COALESCE(c.album_id, c.artist_id)::text AS entity_id, s.slug, c.raw_value,
         (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id=c.id ORDER BY e.id LIMIT 1) AS url
    FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
   WHERE c.field='genre' AND c.status='accepted' AND (c.album_id IS NOT NULL OR c.artist_id IS NOT NULL)
     AND NOT EXISTS (SELECT 1 FROM ingest.album_genres g WHERE c.album_id IS NOT NULL AND g.album_id=c.album_id AND g.role='primary' AND g.status='confirmed')
     AND NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE c.album_id IS NULL AND g.artist_id=c.artist_id AND g.role='primary' AND g.status='confirmed')
   ORDER BY c.id`);
const lines = rows.map((row) => JSON.stringify({
  caseId: `${row.kind}:${row.entity_id}`, kind: row.kind, entityId: Number(row.entity_id),
  source: row.slug, rawGenre: row.raw_value, url: row.url,
}));
writeFileSync("reports/genre-laya-evidence-claims-pending-2026-09-26.jsonl", lines.join("\n") + (lines.length ? "\n" : ""));
console.log(`${lines.length} claims`);
await closeDb();
