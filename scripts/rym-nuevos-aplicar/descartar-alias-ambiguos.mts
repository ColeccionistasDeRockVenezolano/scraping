// RYM «nuevos» · cola: descarta los avisos de alias ambiguo que dejaron las altas del 2026-10-05/06
// (Brian: «descartarlos en bloque»). Medido antes: 364 de discos, todos de OTRO artista (homónimos
// legítimos); 5.922 de pistas, 73 dentro del mismo disco (la misma canción repetida en el tracklist:
// bonus, demo, otra versión). No aplicar el alias es lo correcto; la ficha conserva su título.
// Mismo efecto que rejectReview (resolveReview «dismissed», sin tocar el core), pero en UN run:
// una a una iba a ~50/min (2 h para 6.000).
//   ./scripts/with-node22.sh node_modules/.bin/tsx scripts/rym-nuevos-aplicar/descartar-alias-ambiguos.mts
import { closeDb } from "../../src/db/client.js";
import { withOperatorRun } from "../../src/merge/operator.js";

const note = "RYM «nuevos» 2026-10-06: el alias pertenece con razón a otra ficha (mismo título en otro disco, otro artista o repetido en el tracklist); no se aplica";
const { runId, result } = await withOperatorRun({
  name: "review:reject (ambiguous_alias en bloque)", operator: "claude-code (delegado por Brian)", note,
}, async (context) => {
  const r = await context.client.query<{ id: string }>(`
    UPDATE ingest.review_queue SET status='dismissed', resolved_by='human', resolution_note=$1, resolved_at=now(), updated_at=now()
     WHERE kind='ambiguous_alias' AND status IN ('open','in_progress') RETURNING id::text`, [`${note} [run ${context.runId}]`]);
  return r.rows.length;
});
console.log(JSON.stringify({ runId, descartadas: result }));
await closeDb();
