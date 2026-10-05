// CRV · Curaduría 2026-10-05: «Tonadas Favoritas» (Simón Díaz, 1982, Palacio) estaba fundido en
// «Tonadas» (1974, disco 14610): sus claims de disco y 7 pistas propias colgaban de 14610, que así
// tenía 17 pistas y huecos. Tonadas 1974 son 10 pistas (Deezer y la ficha simondiaz_tonadas.htm).
// Se crea el disco «Tonadas Favoritas» con las 14 pistas de su ficha (simondiaz_tonadasfavoritas.htm);
// los claims de «Tonadas y Llanerías» (15375) que colgaban de 14610 vuelven a sus pistas.
import { closeDb } from "../src/db/client.js";
import { withOperatorRun } from "../src/merge/operator.js";
import { mergeInto } from "../src/review/duplicates.js";

const NOTE = "Curaduría 2026-10-05: «Tonadas Favoritas» (1982) separado de «Tonadas» (1974), según sus fichas de Sincopa";
const PAGE = 7512;
const { runId } = await withOperatorRun({ name: "curation:split-tonadas-favoritas", operator: "claude-code", note: NOTE }, async ({ client, runId: run }) => {
  const { rows: [album] } = await client.query<{ id: string }>(`INSERT INTO public.albums(artist_id, title, release_year, album_type, genre, label_id, media_format)
    SELECT artist_id, 'Tonadas Favoritas', 1982, album_type, genre, 1171, 'LP' FROM public.albums WHERE id=14610 RETURNING id::text`);
  const newAlbum = Number(album!.id);
  await client.query("UPDATE ingest.claims SET album_id=$1, status=CASE WHEN status='superseded' THEN 'accepted'::ingest.claim_status ELSE status END, updated_at=now() WHERE raw_page_id=$2 AND entity_kind='album' AND album_id=14610", [newAlbum, PAGE]);
  // Entradas de la ficha (posición → número 1..14).
  const { rows: entries } = await client.query<{ position: number; title: string; track_id: string | null }>(`
    SELECT e.position, c.raw_value #>> '{}' AS title, c.track_id::text FROM ingest.claims c JOIN ingest.claim_evidence e ON e.claim_id=c.id
     WHERE c.raw_page_id=$1 AND c.entity_kind='track' AND c.field='title' ORDER BY e.position`, [PAGE]);
  let k = 0;
  for (const entry of entries) {
    k += 1;
    const trackId = Number(entry.track_id);
    const { rows: pages } = await client.query<{ raw_page_id: string }>("SELECT DISTINCT raw_page_id::text FROM ingest.claims WHERE track_id=$1 AND raw_page_id IS NOT NULL", [trackId]);
    const exclusive = pages.every((page) => Number(page.raw_page_id) === PAGE || Number(page.raw_page_id) === 7509);
    let destination: number;
    if (exclusive && trackId !== 157488) {
      await client.query("UPDATE public.tracks SET album_id=$1, track_number=$2+1000 WHERE id=$3", [newAlbum, k, trackId]);
      destination = trackId;
    } else {
      const { rows: [created] } = await client.query<{ id: string }>(
        "INSERT INTO public.tracks(album_id, disc_number, track_number, title, duration_seconds) VALUES ($1,1,$2+1000,$3,NULL) RETURNING id::text", [newAlbum, k, entry.title]);
      destination = Number(created!.id);
    }
    await client.query(`UPDATE ingest.claims c SET track_id=$1, status=CASE WHEN c.status IN ('superseded','candidate','rejected') AND c.field<>'track_number' THEN 'accepted'::ingest.claim_status ELSE c.status END, updated_at=now()
      FROM ingest.claim_evidence e WHERE e.claim_id=c.id AND c.raw_page_id=$2 AND c.entity_kind='track' AND e.position=$3 AND c.track_id IS NOT DISTINCT FROM $4`,
      [destination, PAGE, entry.position, trackId]);
  }
  await client.query("UPDATE public.tracks SET track_number=track_number-1000 WHERE album_id=$1", [newAlbum]);
  // «Tonada De Las Espigas» (157488): no es de Tonadas 1974; lo que queda (Tonadas y Llanerías) se funde en su pista 157959.
  await mergeInto(client, "track", 157959, 157488, NOTE, run, { alias: false });
  // Claims de Tonadas y Llanerías (página 7509) en pistas de 14610 → sus pistas de 15375.
  for (const [from, to] of [[84588, 157962], [84589, 157963], [84592, 157958]]) {
    await client.query("UPDATE ingest.claims SET track_id=$2, updated_at=now() WHERE track_id=$1 AND raw_page_id=7509", [from, to]);
  }
  console.log(`disco nuevo ${newAlbum}`);
});
console.log(`run ${runId}`);
await closeDb();
