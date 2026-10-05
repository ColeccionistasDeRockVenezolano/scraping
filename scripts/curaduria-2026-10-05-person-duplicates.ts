// CRV · Curaduría 2026-10-05: los dos homónimos que dejó la extracción de integrantes (run 13379).
//  - Betsayda Machado: la cantante de La Parranda El Clavo es la misma voz invitada en Vasallos del Sol,
//    Pomarrosa, Aquiles Báez… (nombre inconfundible, mismo ámbito): se fusionan.
//  - Manuel Guerra: el productor ejecutivo (Desorden Público, Dimensión Latina) y el integrante de
//    Salserín no comparten proyecto ni colegas: quedan separados.
import { closeDb, getPool } from "../src/db/client.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { rejectReview } from "../src/review/operator-review.js";

const NOTE = "Curaduría 2026-10-05: Betsayda Machado es una sola persona (cantante de La Parranda El Clavo, invitada en discos de su ámbito)";
const { runId } = await withOperatorRun({ name: "curation:merge-betsayda", operator: "claude-code", note: NOTE }, async (context) => {
  const preview = await previewEntityMerge(context.client, "person", 22609, 40220);
  console.log(preview.warnings, preview.fieldConflicts);
  console.log(await mergeEntities(context, { kind: "person", keepId: 22609, dropId: 40220, previewHash: preview.previewHash }));
});
console.log(`run ${runId}`);
const open = await getPool().query("SELECT id FROM ingest.review_queue WHERE id=1833538 AND status='open'");
if (open.rowCount) await getPool().query("UPDATE ingest.review_queue SET status='approved', resolved_by='human', resolution_note=$1, resolved_at=now(), updated_at=now() WHERE id=1833538", [`${NOTE} (run ${runId})`]);
console.log(await rejectReview(1833537, { operator: "claude-code", note:
  "Curaduría 2026-10-05: el productor ejecutivo Manuel Guerra (Desorden Público, Dimensión Latina) y el integrante de Salserín no comparten proyecto ni colegas; son fichas distintas" }));
await closeDb();
