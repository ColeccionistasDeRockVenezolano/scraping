// CRV · Curaduría 2026-10-05: «Frank Quintero & Los Balzehaguados» (273, hoja YT Master) es la misma
// ficha que «… Los Balzehaguaos» (293, canal de YouTube y Sincopa). Manda el canal; el otro nombre
// queda como alias. Su único disco (528, sin pistas) es el mismo «Después De La Tormenta» (666, 1976).
import { closeDb, getPool } from "../src/db/client.js";
import { mergeAlbums, previewAlbumMerge } from "../src/merge/album-merge.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: artista y disco duplicados por una errata del nombre; manda el nombre del canal (Balzehaguaos)";
const pool = getPool();
const albumPreview = await previewAlbumMerge(pool, 666, 528);
console.log(albumPreview.warnings ?? "", (albumPreview as { fieldConflicts?: unknown }).fieldConflicts ?? "");
const { runId } = await withOperatorRun({ name: "curation:merge-balzehaguaos", operator: "claude-code", note: NOTE }, async (context) => {
  console.log(await mergeAlbums(context, { keepId: 666, dropId: 528, previewHash: albumPreview.previewHash, keepDropNameAsAlias: false }));
  const artistPreview = await previewEntityMerge(context.client, "artist", 293, 273);
  console.log(artistPreview.warnings, artistPreview.fieldConflicts);
  console.log(await mergeEntities(context, { kind: "artist", keepId: 293, dropId: 273, previewHash: artistPreview.previewHash }));
});
console.log(`run ${runId}`);
await closeDb();
