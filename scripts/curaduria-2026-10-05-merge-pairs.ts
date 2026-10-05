// CRV · Curaduría 2026-10-05: fusiones puntuales revisadas a mano (persona, organización, artista o pista).
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-merge-pairs.ts --kind=organization --pairs=keep:drop,… --note="…" [--alias]
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { mergeInto, type MergeKind } from "../src/review/duplicates.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const kind = arg("kind") as MergeKind;
const pairs = arg("pairs")!.split(",").map((pair) => pair.split(":").map(Number) as [number, number]);
const note = arg("note") ?? "Curaduría 2026-10-05";
const { runId } = await withOperatorRun({ name: `curation:merge-${kind}`, operator: "claude-code", note }, async ({ client, runId }) => {
  for (const [keep, drop] of pairs) await mergeInto(client, kind, keep, drop, note, runId, { alias: process.argv.includes("--alias") });
});
console.log(`run ${runId}: ${pairs.length} fusiones de ${kind}`);
await closeDb();
