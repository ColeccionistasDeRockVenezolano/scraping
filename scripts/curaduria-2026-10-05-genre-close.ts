// CRV · Curaduría 2026-10-05: confirma el género principal de un disco y cierra sus revisiones de género.
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-genre-close.ts --album=<id> --slug=<slug> --reviews=<ids> --reason="…"
import { closeDb } from "../src/db/client.js";
import { decideGenre } from "../src/genres/curation.js";

const arg = (name: string): string | undefined => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const result = await decideGenre({
  action: "confirm_primary", kind: "album", entityId: Number(arg("album")), genreSlug: arg("slug")!, actor: "claude-code",
  reason: arg("reason")!, closeCases: true, reviewIds: arg("reviews")!.split(",").map(Number),
});
console.log(`run ${result.runId}: cerradas ${JSON.stringify((result as { closedReviewIds?: number[] }).closedReviewIds ?? [])}`);
await closeDb();
