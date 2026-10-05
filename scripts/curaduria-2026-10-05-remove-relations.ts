// CRV · Curaduría 2026-10-05: retira relaciones concretas (p. ej. el segundo de dos créditos idénticos).
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-remove-relations.ts --kind=track_credit --ids=1,2 --note="…"
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { removeRelation } from "../src/merge/removals.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const kind = arg("kind") as Parameters<typeof removeRelation>[1];
const ids = arg("ids")!.split(",").map(Number);
const note = arg("note")!;
const { runId, result } = await withOperatorRun({ name: "curation:remove-relations", operator: "claude-code", note }, async (context) => {
  let removed = 0;
  for (const id of ids) if (await removeRelation(context.client, kind, id, { note, runId: context.runId })) removed += 1;
  return removed;
});
console.log(`run ${runId}: ${result} relaciones retiradas`);
await closeDb();
