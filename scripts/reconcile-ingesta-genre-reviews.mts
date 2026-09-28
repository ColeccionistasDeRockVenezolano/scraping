// Reconciliación de casos que ya tienen una resolución verificable en la base.
// Ensayo por omisión; --confirm registra la operación en un run auditable.
import { getPool, closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const matchedSql = `
  SELECT q.id::text AS id
    FROM ingest.review_queue q
   WHERE q.kind = 'genre_unknown' AND q.status IN ('open','in_progress')
     AND q.payload->>'origin' = 'genres-external'
     AND q.payload->>'genreCase' = 'external_ambiguous_identity'
     AND EXISTS (
       SELECT 1 FROM ingest.genre_external_identities i
        WHERE i.entity_kind = q.payload->>'entityKind'
          AND i.entity_id = (q.payload->>'entityId')::bigint
          AND i.source_id = (q.payload->>'externalSourceId')::bigint
          AND i.status = 'matched'
     )`;

const retiredSql = `
  SELECT q.id::text AS id
    FROM ingest.review_queue q
   WHERE q.kind = 'genre_unknown' AND q.status IN ('open','in_progress')
     AND q.payload->>'origin' = 'genres-taxonomy'
     AND q.payload->>'kind' = 'genre_deactivated'
     AND NOT EXISTS (
       SELECT 1 FROM ingest.album_genres ag
        WHERE ag.id = (q.payload->>'humanAssignmentId')::bigint
     )
     AND EXISTS (
       SELECT 1 FROM ingest.album_genres ag
        WHERE ag.album_id = (q.payload->>'entityId')::bigint
          AND ag.genre_id = (q.payload->>'proposedReplacementId')::bigint
          AND ag.status = 'confirmed'
     )`;

async function main(): Promise<void> {
  const preview = await getPool().query(`${matchedSql} UNION ALL ${retiredSql} ORDER BY id`);
  const ids = preview.rows.map((row: { id: string }) => Number(row.id));
  console.log(`Casos ya resueltos: ${ids.length} (${ids.join(",")})`);
  if (!process.argv.includes("--confirm") || ids.length === 0) return;
  const { runId, result } = await withOperatorRun({
    name: "reconcile_ingesta_genre_reviews",
    operator: "codex",
    note: "Cerrar revisiones de identidad con enlace matched y taxonomía ya sustituida",
    params: { reviewIds: ids },
  }, async ({ client, runId }) => {
    const rows = await client.query<{ id: string }>(`
      UPDATE ingest.review_queue q
         SET status = 'approved', resolved_by = 'system', resolved_at = now(), updated_at = now(),
             resolution_note = $2
       WHERE q.id = ANY($1::bigint[]) AND q.status IN ('open','in_progress')
       RETURNING q.id::text`,
      [ids, `run ${runId}: identidad Discogs enlazada o género retirado ya sustituido`]);
    if (rows.rowCount !== ids.length) throw new Error(`se esperaban ${ids.length} cierres y se aplicaron ${rows.rowCount}`);
    return rows.rowCount;
  });
  console.log(`run ${runId}: ${result} revisiones cerradas`);
}

try {
  await main();
} finally {
  await closeDb();
}
