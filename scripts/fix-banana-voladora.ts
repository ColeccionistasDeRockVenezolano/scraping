// La Banda de la Banana Voladora (Brian, 2026-10-03). Sincopa partió el nombre en
// la ficha banana_voladora1 («La Banda de» / «La Banana Voladora») y creó el
// artista 1798 con el disco 3413, que además tenía las pistas de «Tan Solo Una
// Sonrisa» (1997, disco 2170). El debut de 1994 estaba tres veces: 2160 (blogs),
// 3826 (Sincopa) y 3413.
//
//  1. Las pistas del 3413 que están en el 2170 se fusionan con su gemela.
//  2. El 3413 se fusiona en el 3826; el 2160 también, con el título de Sincopa
//     «La Banana Voladora» (el otro queda como alias).
//  3. El artista 1798 se fusiona en el 1212 sin dejar «La Banda de» como alias.
//
//   tsx scripts/fix-banana-voladora.ts [--confirm]
import { closeDb, getPool } from "../src/db/client.js";
import { mergeAlbums, previewAlbumMerge } from "../src/merge/album-merge.js";
import { mergeEntities, previewEntityMerge } from "../src/merge/entity-merge.js";
import { mergeEquivalentCreditsOnParent } from "../src/merge/equivalent-relations.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { mergeInto } from "../src/review/duplicates.js";

const DEBUT = 3826, MIXED = 3413, BLOGS = 2160, SONRISA = 2170, BAND = 1212, BROKEN = 1798;
const fold = (text: string) => text.normalize("NFD").replace(/\p{Mn}/gu, "").toLowerCase().replace(/[^\p{L}\d]+/gu, " ").trim();

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const pool = getPool();
  const { rows: tracks } = await pool.query<{ id: string; album_id: string; title: string }>(
    "SELECT id::text, album_id::text, title FROM public.tracks WHERE album_id IN ($1, $2)", [MIXED, SONRISA]);
  const twins = new Map(tracks.filter((row) => Number(row.album_id) === SONRISA).map((row) => [fold(row.title), Number(row.id)]));
  const toSonrisa = tracks.filter((row) => Number(row.album_id) === MIXED && twins.has(fold(row.title)))
    .map((row) => ({ drop: Number(row.id), keep: twins.get(fold(row.title))!, title: row.title }));
  console.log(`pistas del ${MIXED} a su gemela del ${SONRISA}: ${toSonrisa.length} (${toSonrisa.map((item) => item.title).join(" | ")})`);
  const client = await pool.connect();
  try {
    for (const drop of [MIXED, BLOGS]) {
      const preview = await previewAlbumMerge(client, DEBUT, drop);
      console.log(`disco ${drop} → ${DEBUT}:`, JSON.stringify({ conflicts: (preview as { fieldConflicts?: unknown }).fieldConflicts, matches: (preview as { trackMatches?: unknown[] }).trackMatches?.length }));
    }
    const artist = await previewEntityMerge(client, "artist", BAND, BROKEN);
    console.log(`artista ${BROKEN} → ${BAND}:`, JSON.stringify((artist as { fieldConflicts?: unknown }).fieldConflicts ?? {}));
  } finally {
    client.release();
  }
  if (!confirm) { await closeDb(); return; }

  const note = "La Banda de la Banana Voladora: «La Banda de» era el nombre partido por Sincopa; el debut de 1994 estaba tres veces (Brian, 2026-10-03)";
  const result = await withOperatorRun({ name: "fix-banana-voladora", operator: "brian", note, params: { DEBUT, MIXED, BLOGS, SONRISA, BAND, BROKEN } }, async (context) => {
    for (const item of toSonrisa) {
      await mergeInto(context.client, "track", item.keep, item.drop, context.note, context.runId, { alias: false });
      await mergeEquivalentCreditsOnParent(context.client, { kind: "track", id: item.keep }, context.note, context.runId);
    }
    const mixed = await mergeAlbums(context, { keepId: DEBUT, dropId: MIXED, previewHash: (await previewAlbumMerge(context.client, DEBUT, MIXED, { lock: true })).previewHash, keepDropNameAsAlias: false });
    const blogs = await mergeAlbums(context, { keepId: DEBUT, dropId: BLOGS, previewHash: (await previewAlbumMerge(context.client, DEBUT, BLOGS, { lock: true })).previewHash, keepDropNameAsAlias: true });
    const artist = await mergeEntities(context, { kind: "artist", keepId: BAND, dropId: BROKEN, previewHash: (await previewEntityMerge(context.client, "artist", BAND, BROKEN, { lock: true })).previewHash,
      // La biografía de 1798 («La Banda de fue una agrupación…») sale del nombre partido: no aporta nada.
      fieldChoices: { biography: "keep" }, keepDropNameAsAlias: false });
    return { tracksToSonrisa: toSonrisa.length, mixed: { tracksMerged: mixed.tracksMerged, tracksMoved: mixed.tracksMoved }, blogs: { tracksMerged: blogs.tracksMerged, tracksMoved: blogs.tracksMoved }, artist: { moved: artist.moved, preserved: artist.preserved } };
  });
  console.log(JSON.stringify(result));
  await closeDb();
}

await main();
