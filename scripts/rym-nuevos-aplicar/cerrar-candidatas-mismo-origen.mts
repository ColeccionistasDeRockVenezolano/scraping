// RYM «nuevos» · imágenes: al repetir media:localize (2026-10-06) se propusieron como candidatas
// las mismas portadas que la pasada anterior ya había fijado (URL de origen idéntica a la del
// manifiesto de la ficha). Son la MISMA imagen: se descartan y la actual se queda. Un run.
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/rym-nuevos-aplicar/cerrar-candidatas-mismo-origen.mts
import { readFileSync } from "node:fs";
import { closeDb } from "../../src/db/client.js";
import { withOperatorRun } from "../../src/merge/operator.js";

const manifest = JSON.parse(readFileSync("web/public/media/manifest.json", "utf8")) as { entries: Record<string, { sourceUrl: string }> };
const { runId, result } = await withOperatorRun({
  name: "image_choice_bulk (mismo origen)", operator: "claude-code (delegado por Brian)",
  note: "Candidatas con la misma URL de origen que la imagen actual de la ficha: se deja la actual",
}, async (context) => {
  const open = await context.client.query<{ id: string; kind: string; eid: string; url: string }>(
    "SELECT id::text, entity_kind AS kind, coalesce(album_id, artist_id)::text AS eid, candidate_url AS url FROM ingest.image_candidates WHERE status='open'");
  const ids = open.rows.filter((r) => manifest.entries[`${r.kind}:${r.eid}`]?.sourceUrl === r.url).map((r) => Number(r.id));
  await context.client.query(`
    UPDATE ingest.image_candidates SET status='rejected', decided_by=$2, decided_at=now(), decision_run_id=$3
     WHERE id = ANY($1::bigint[]) AND status='open'`, [ids, context.operator, context.runId]);
  return ids.length;
});
console.log(JSON.stringify({ runId, descartadas: result }));
await closeDb();
