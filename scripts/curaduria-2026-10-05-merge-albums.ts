// CRV · Curaduría 2026-10-05: fusión de discos repetidos verificados a mano (con o sin pistas).
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-merge-albums.ts --pairs=keep:drop,… [--alias] --note="…"
import { closeDb } from "../src/db/client.js";
import { mergeAlbums, previewAlbumMerge } from "../src/merge/album-merge.js";
import { withOperatorRun } from "../src/merge/operator.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const pairs = arg("pairs")!.split(",").map((pair) => pair.split(":").map(Number) as [number, number]);
const note = arg("note")!;
const { runId } = await withOperatorRun({ name: "curation:merge-albums", operator: "claude-code", note }, async (context) => {
  for (const [keepId, dropId] of pairs) {
    const preview = await previewAlbumMerge(context.client, keepId, dropId);
    await mergeAlbums(context, { keepId, dropId, previewHash: preview.previewHash, keepDropNameAsAlias: process.argv.includes("--alias") });
  }
});
console.log(`run ${runId}: ${pairs.length} fusiones de disco`);
await closeDb();
