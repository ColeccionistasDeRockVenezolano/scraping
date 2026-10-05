// CRV · Curaduría 2026-10-05: «Rock & Gol! [Jamas Entenderas] - La 24» (Compilado Punk Union & Valentia):
// en la fuente cada pista es «Título - Banda»; La 24 es la banda y el título queda con la aclaración entre paréntesis.
import { closeDb } from "../src/db/client.js";
import { createEntity, createRelation, updateEntity, withOperatorRun } from "../src/merge/operator.js";
const note = "Curaduría 2026-10-05: pista de recopilación «Título - Banda»; La 24 pasa a intérprete";
const { runId } = await withOperatorRun({ name: "curation:la-24", operator: "claude-code", note }, async (context) => {
  const artist = await createEntity(context, "artist", { name: "La 24" }, { allowSimilar: true });
  await createRelation(context, "track_credit", { trackId: 41200, artistId: artist.id }, { credit_type: "musician", credit_role: "Intérprete" });
  await updateEntity(context, "track", 41200, { title: "Rock & Gol! (Jamas Entenderas)" });
});
console.log(`run ${runId}`);
await closeDb();
