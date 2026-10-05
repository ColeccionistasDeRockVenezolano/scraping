// CRV · Curaduría 2026-10-05: «Jihad» juntaba dos proyectos: la banda de groove/thrash de Maturín
// (Metal Archives: formada en 2006; Insurrección 2014, el sencillo de 2020 y los Mendoza) y el
// proyecto darkwave/ambient de Wismar Pulido en Caracas (desde 1999; Hymns From The Underworld In
// Flames 2003, Neptune 2004, Psicofonías). Los discos y la biografía de Pulido pasan a «Jihad (Caracas)».
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-split-jihad.ts
import { closeDb } from "../src/db/client.js";
import { mergeAlbums, previewAlbumMerge } from "../src/merge/album-merge.js";
import { createEntity, updateEntity, withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: dos proyectos homónimos en la ficha Jihad (thrash de Maturín 2006 / darkwave de Wismar Pulido 1999)";
const { runId } = await withOperatorRun({ name: "curation:split-jihad", operator: "claude-code", note: NOTE }, async (context) => {
  const q = context.client;
  const { rows: [jihad] } = await q.query<{ biography: string }>("SELECT biography FROM public.artists WHERE id=511");
  const dark = await createEntity(context, "artist", {
    name: "Jihad (Caracas)", artist_type: "project", biography: jihad!.biography, formed_year: 1999, origin_city: "Caracas", origin_country: "Venezuela",
  }, { allowSimilar: true });
  await q.query("UPDATE public.albums SET artist_id=$1, updated_at=now() WHERE id = ANY('{1604,1608,1735,2570}'::bigint[]) AND artist_id=511", [dark.id]);
  await updateEntity(context, "artist", 511, { biography: null, origin_city: "Maturín" });
  const preview = await previewAlbumMerge(q, 2570, 1735);
  await mergeAlbums(context, { keepId: 2570, dropId: 1735, previewHash: preview.previewHash, keepDropNameAsAlias: false });
  console.log(`Jihad (Caracas) = ${dark.id}`);
});
console.log(`run ${runId}`);
await closeDb();
