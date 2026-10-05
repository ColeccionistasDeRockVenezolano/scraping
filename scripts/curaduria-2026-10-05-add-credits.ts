// CRV · Curaduría 2026-10-05: créditos de pista puntuales (y, si hace falta, el título limpio), por el motor.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-add-credits.ts --track=<id> [--title="…"]
//        --persons=<ids> | --artists=<ids>  --type=composer|guest|producer… --role="…" --note="…"
import { closeDb } from "../src/db/client.js";
import { createRelation, updateEntity, withOperatorRun } from "../src/merge/operator.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const trackId = Number(arg("track"));
const ids = (key: string): number[] => (arg(key) ?? "").split(",").filter(Boolean).map(Number);
const note = arg("note") ?? "Curaduría 2026-10-05";
const { runId } = await withOperatorRun({ name: "curation:add-track-credits", operator: "claude-code", note }, async (context) => {
  if (arg("title")) await updateEntity(context, "track", trackId, { title: arg("title") });
  for (const personId of ids("persons")) await createRelation(context, "track_credit", { trackId, personId }, { credit_type: arg("type"), credit_role: arg("role") });
  for (const artistId of ids("artists")) await createRelation(context, "track_credit", { trackId, artistId }, { credit_type: arg("type"), credit_role: arg("role") });
});
console.log(`run ${runId}`);
await closeDb();
