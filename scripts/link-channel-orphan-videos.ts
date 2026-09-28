// CRV · Enlaza a su disco los videos del canal que no tenían ninguno (2026-09-27).
//
// La radio (`albumsForVideos`) y la ficha pública solo ven `media.video_albums`,
// así que un video sin esa fila sale sin disco y sin género aunque su pista sí
// lo tenga. Dos casos, sin crear ningún disco (la hoja dice «contenido
// audiovisual; no crea álbum»):
//
//   * Videoclip oficial: su pista ya está en `media.video_tracks`; se enlaza al
//     disco de esa pista como `music_video`, nunca como enlace principal.
//   * Concierto o sesión: se enlaza como `live_concert` (el precedente de los
//     seis que ya lo estaban) solo al disco que reúne la mayoría de sus
//     canciones, medido contra el tracklist de la descripción.
//
// Documentales, reseñas, entrevistas y conciertos sin disco dominante quedan
// sin enlace. Sin --confirm corre entero y se deshace.
import { closeDb, getPool } from "../src/db/client.js";

/** Video → disco, medidos el 2026-09-27 (canciones del tracklist que son de ese disco). */
const LIVE: Array<{ videoDbId: number; albumId: number; why: string }> = [
  { videoDbId: 1028, albumId: 3456, why: "16/16 canciones: el mismo concierto" },
  { videoDbId: 4, albumId: 101, why: "5/5 canciones de «1986»" },
  { videoDbId: 321, albumId: 474, why: "EÚS31 2004, mismo evento; 19/30 canciones" },
  { videoDbId: 289, albumId: 273, why: "9/13 canciones de «Caracas»" },
  { videoDbId: 69, albumId: 137, why: "3/3 canciones de «Caramelos De Cianuro»" },
  { videoDbId: 363, albumId: 317, why: "3/5 canciones de «Reina Contra La Máquina»" },
  { videoDbId: 351, albumId: 313, why: "2/3 canciones de «RawayanaLand»" },
  { videoDbId: 213, albumId: 228, why: "la sesión lleva el nombre del disco «Nuestra»" },
];

async function main(): Promise<void> {
  const confirm = process.argv.includes("--confirm");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const source = (await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug='youtube-data-api'")).rows[0]!.id;
    // Crear el run en esta transacción liga cada fila al diario (`crv_bind_run`).
    const run = (await client.query<{ id: string }>(
      `INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('manual','running',$1::jsonb) RETURNING id::text`,
      [JSON.stringify({ action: "link_channel_orphan_videos", confirm, live: LIVE })])).rows[0]!.id;

    const clips = await client.query<{ title: string; album: string }>(`
      INSERT INTO media.video_albums(video_id, album_id, album_kind, is_primary_link, confidence, source_id)
      SELECT DISTINCT ON (v.id) v.id, t.album_id, 'music_video', false, 'high', $1
        FROM media.youtube_channel_uploads u
        JOIN media.youtube_videos v ON v.video_id = u.video_id
        JOIN media.video_tracks vt ON vt.video_id = v.id
        JOIN public.tracks t ON t.id = vt.track_id
       WHERE NOT EXISTS (SELECT 1 FROM media.video_albums va WHERE va.video_id = v.id)
       ORDER BY v.id, vt.start_seconds
      RETURNING (SELECT yv.title FROM media.youtube_videos yv WHERE yv.id = video_albums.video_id) AS title,
                (SELECT al.title FROM public.albums al WHERE al.id = video_albums.album_id) AS album`, [source]);
    for (const row of clips.rows) console.log(`videoclip  ${row.title} → ${row.album}`);

    for (const link of LIVE) {
      const saved = await client.query<{ title: string; album: string }>(`
        INSERT INTO media.video_albums(video_id, album_id, album_kind, is_primary_link, confidence, source_id)
        SELECT $1, $2, 'live_concert', false, 'high', $3
         WHERE NOT EXISTS (SELECT 1 FROM media.video_albums WHERE video_id = $1)
        ON CONFLICT (video_id, album_id) DO NOTHING
        RETURNING (SELECT yv.title FROM media.youtube_videos yv WHERE yv.id = video_albums.video_id) AS title,
                  (SELECT al.title FROM public.albums al WHERE al.id = video_albums.album_id) AS album`, [link.videoDbId, link.albumId, source]);
      for (const row of saved.rows) console.log(`concierto  ${row.title} → ${row.album} (${link.why})`);
    }

    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now() WHERE id=$1", [run]);
    await client.query(confirm ? "COMMIT" : "ROLLBACK");
    console.log(`\n${confirm ? "confirmado" : "dry-run (deshecho)"}, run ${run}: ${clips.rowCount} videoclips + ${LIVE.length} conciertos`);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await closeDb();
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
