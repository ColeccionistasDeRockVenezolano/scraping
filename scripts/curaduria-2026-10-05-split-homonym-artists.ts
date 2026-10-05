// CRV · Curaduría 2026-10-05: bandas homónimas mezcladas en una ficha (disco publicado antes de la
// formación). El disco ajeno pasa a una ficha nueva con sufijo de año, como «Pan (1970)».
//   Antares 1509: banda de thrash de Mérida (2009, Metal Archives y Rock de Vzla) ≠ Antares, rock
//   sinfónico de Caracas (1981–1985), cuyo disco de 1982 (Hippito) y cuya biografía sintetizada
//   habían caído en la ficha del thrash; la ficha del thrash recupera la bio de Rock de Vzla.
//   Tepuy 3097: banda de heavy metal (2005) ≠ el conjunto de música tradicional del disco «Tepuy» (1982, Sincopa).
//   ./scripts/with-node22.sh npx tsx scripts/curaduria-2026-10-05-split-homonym-artists.ts
import { closeDb } from "../src/db/client.js";
import { createEntity, updateEntity, withOperatorRun } from "../src/merge/operator.js";

const NOTE = "Curaduría 2026-10-05: bandas homónimas en una ficha; el disco anterior a la formación es de la otra banda";
const { runId } = await withOperatorRun({ name: "curation:split-homonym-artists", operator: "claude-code", note: NOTE }, async (context) => {
  const q = context.client;
  const { rows: [antares] } = await q.query<{ biography: string; artist_type: string }>("SELECT biography, artist_type FROM public.artists WHERE id=1509");
  const { rows: [thrash] } = await q.query<{ bio: string }>(`SELECT c.raw_value #>> '{}' AS bio FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE c.artist_id=1509 AND c.field='biography' AND s.slug='rock-de-vzla' LIMIT 1`);
  const prog = await createEntity(context, "artist", {
    name: "Antares (1981)", artist_type: antares!.artist_type, biography: antares!.biography,
    formed_year: 1981, disbanded_year: 1985, origin_city: "Caracas", origin_country: "Venezuela",
  }, { allowSimilar: true });
  await q.query("UPDATE public.albums SET artist_id=$1, updated_at=now() WHERE id=5042 AND artist_id=1509", [prog.id]);
  await updateEntity(context, "artist", 1509, { biography: thrash!.bio });
  const folk = await createEntity(context, "artist", { name: "Tepuy (1982)", artist_type: "group", origin_country: "Venezuela" }, { allowSimilar: true });
  await q.query("UPDATE public.albums SET artist_id=$1, updated_at=now() WHERE id=9069 AND artist_id=3097", [folk.id]);
  console.log(`Antares (1981) = ${prog.id} · Tepuy (1982) = ${folk.id}`);
});
console.log(`run ${runId}`);
await closeDb();
