// CRV · Curaduría 2026-10-05: los dos últimos conflictos de título (pistas 33612 y 33647, disco 4610),
// cuya revisión apuntaba a una ficha de pista ya fusionada.
import { closeDb } from "../src/db/client.js";
import { resolveFieldConflict } from "../src/merge/engine.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: título sin errata («Dspués», «Ala» son erratas)";
const { runId } = await withOperatorRun({ name: "curation:last-title-conflicts", operator: "claude-code", note: NOTE }, async (context) => {
  for (const id of [16587, 16588]) await resolveFieldConflict(id, "resolved_b", { actor: "human", note: NOTE, runId: context.runId, client: context.client });
  await context.client.query("UPDATE public.tracks SET title='Después De La Lluvia' WHERE id=33612");
  await context.client.query(`UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolution_note=$1, resolved_at=now(), updated_at=now()
    WHERE id IN (1807657,1807658) AND status='open'`, [NOTE]);
});
console.log(`run ${runId}`);
await closeDb();
