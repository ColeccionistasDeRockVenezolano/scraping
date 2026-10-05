// CRV · Curaduría 2026-10-05: fusiones de discos verificadas a mano (pista a pista) + SQL opcional en el mismo run.
//
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-album-pairs.ts --pairs=keep:drop,keep:drop [--sql=<archivo>] --note="…"
import { readFileSync } from "node:fs";
import { closeDb } from "../src/db/client.js";
import { mergeAlbums, previewAlbumMerge } from "../src/merge/album-merge.js";
import { withOperatorRun } from "../src/merge/operator.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const pairs = (arg("pairs") ?? "").split(",").filter(Boolean).map((pair) => pair.split(":").map(Number) as [number, number]);
const { runId } = await withOperatorRun({ name: "curation:album-pairs", operator: "claude-code", note: arg("note")! }, async (context) => {
  for (const [keepId, dropId] of pairs) {
    const preview = await previewAlbumMerge(context.client, keepId, dropId);
    console.log(keepId, "←", dropId, `${preview.matchedTracks.length} pistas emparejadas, ${preview.unmatchedDropTracks.length} sin pareja`);
    await mergeAlbums(context, { keepId, dropId, previewHash: preview.previewHash, keepDropNameAsAlias: true });
  }
  if (arg("sql")) await context.client.query(readFileSync(arg("sql")!, "utf8"));
});
console.log(`run ${runId}`);
await closeDb();
