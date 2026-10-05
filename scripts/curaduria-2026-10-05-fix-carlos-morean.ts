// CRV · Curaduría 2026-10-05: «Carlos Moreán» (disco 3498). La pista 6 (#24626) es «Sigue De Largo
// (Walk On By)», B1 de la ficha de Sincopa (sus claims de la posición 9 ya decían número 6), pero
// arrastraba el título de A1 «Regresa A Mí», que vive en la pista 1 (#159364).
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: pista 6 = «Sigue De Largo (Walk On By)» según Sincopa (carlosmorean_1carlosmorean.htm); A1 queda solo en la pista 1";
const { runId } = await withOperatorRun({ name: "curation:fix-carlos-morean", operator: "claude-code", note: NOTE }, async ({ client }) => {
  // Claims de A1 (posición 1) que colgaban de la pista 6 → pista 1.
  await client.query(`UPDATE ingest.claims c SET track_id=159364, updated_at=now() FROM ingest.claim_evidence e
     WHERE e.claim_id=c.id AND c.track_id=24626 AND e.position=1`);
  // Título de B1 (posición 9), huérfano, → pista 6.
  await client.query(`UPDATE ingest.claims c SET track_id=24626, status='accepted', updated_at=now() FROM ingest.claim_evidence e
     WHERE e.claim_id=c.id AND c.track_id IS NULL AND c.field='title' AND e.position=9
       AND c.raw_page_id=(SELECT DISTINCT raw_page_id FROM ingest.claims WHERE track_id=159364 AND source_id=7)`);
  await client.query("UPDATE public.tracks SET title='Sigue De Largo (Walk On By)' WHERE id=24626");
  await client.query("UPDATE ingest.track_aliases SET track_id=159364 WHERE id IN (20102,84738)");
});
console.log(`run ${runId}`);
await closeDb();
