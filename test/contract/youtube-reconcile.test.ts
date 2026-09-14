import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { reconcileYouTubeChannel } from "../../src/youtube/reconcile.js";

// Etapa 6: yt:reconcile sobre una base desechable. Los datos son los del caso
// de aceptación (Las Paticas De La Abuela, video Q-pRpO2sYSI) más un videoclip
// y una pieza editorial; se insertan como los dejaría el pipeline, no se
// fabrican las relaciones que el comando debe derivar.
describe("yt:reconcile contra PostgreSQL", () => {
  let container: PgContainer;
  let reportDir: string;
  const counts = async () => (await getPool().query<{ artists: number; tracks: number; reviews: number; albums: number; core_tracks: number }>(`
    SELECT (SELECT count(*)::int FROM media.video_artists) AS artists,
           (SELECT count(*)::int FROM media.video_tracks) AS tracks,
           (SELECT count(*)::int FROM ingest.review_queue WHERE kind='youtube_match') AS reviews,
           (SELECT count(*)::int FROM public.albums) AS albums,
           (SELECT count(*)::int FROM public.tracks) AS core_tracks`)).rows[0]!;

  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
    reportDir = await mkdtemp(path.join(os.tmpdir(), "crv-reconcile-"));
    const pool = getPool();
    await pool.query(`
      INSERT INTO ingest.sources(slug, name, site_type, trust_level)
      VALUES ('yt-master-seed','YT Master Spreadsheet','spreadsheet','high'), ('youtube-data-api','YouTube Data API v3','youtube_api','api')
      ON CONFLICT (slug) DO NOTHING`);
    const artist = (await pool.query<{ id: string }>("INSERT INTO public.artists(name) VALUES ('Caramelos De Cianuro') RETURNING id")).rows[0]!.id;
    const salpachino = (await pool.query<{ id: string }>("INSERT INTO public.artists(name) VALUES ('Salpachino') RETURNING id")).rows[0]!.id;
    const album = (await pool.query<{ id: string }>("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'Las Paticas De La Abuela',1992,'ep') RETURNING id", [artist])).rows[0]!.id;
    const reina = (await pool.query<{ id: string }>("INSERT INTO public.albums(artist_id,title,release_year,album_type) VALUES ($1,'Reina Contra La Máquina',2011,'studio_album') RETURNING id", [salpachino])).rows[0]!.id;
    await pool.query(`
      INSERT INTO public.tracks(album_id, track_number, title, youtube_start_seconds)
      VALUES ($1,1,'Chan², Chaca², Chan²',0), ($1,2,'Tu Mamá Te Va a Pegar',247), ($1,3,'La Bruja',475), ($1,4,'Nadando a Través De La Galaxia',615),
             ($2,1,'Nosferatu',NULL)`, [album, reina]);
    const paticas = (await pool.query<{ id: string }>(`
      INSERT INTO media.youtube_videos(video_id, title, duration_seconds)
      VALUES ('Q-pRpO2sYSI','Caramelos De Cianuro - Las Paticas De La Abuela (1992) || Full Album ||',940) RETURNING id`)).rows[0]!.id;
    await pool.query(`
      INSERT INTO media.youtube_videos(video_id, title, duration_seconds)
      VALUES ('uwTM_olKdj0','Salpachino - Nosferatu (Official 4K Video)',161),
             ('zNdcRR1rBZE','Babylon Motorhome, disponible mañana en el canal. Reseña por @nuevasbandas',41)`);
    await pool.query(`
      INSERT INTO media.youtube_tracklist_entries(video_id, position, title, start_seconds)
      VALUES ($1,0,'Chan², Chaca², Chan²',0), ($1,1,'Tu Mamá Te Va a Pegar',247), ($1,2,'La Bruja',475), ($1,3,'Nadando a Través De La Galaxia',615)`, [paticas]);
    await pool.query(`
      INSERT INTO media.video_albums(video_id, album_id, album_kind, is_primary_link, confidence, source_id)
      VALUES ($1,$2,'full_album',true,'high',(SELECT id FROM ingest.sources WHERE slug='yt-master-seed'))`, [paticas, album]);
  }, 120_000);
  afterAll(async () => { await closeDb(); await container.stop(); }, 60_000);

  it("--dry-run calcula el plan sin escribir nada", async () => {
    const result = await reconcileYouTubeChannel({ dryRun: true, reportDir });
    expect(result.summary.videoTracks.planned).toBe(5);
    expect(result.reportFiles).toEqual([]);
    expect(await counts()).toMatchObject({ artists: 0, tracks: 0, reviews: 0 });
  });

  it("relaciona artista y pistas con sus timestamps, y la segunda corrida no duplica nada", async () => {
    const before = await counts();
    const first = await reconcileYouTubeChannel({ reportDir });
    expect(first.summary.byCategory).toMatchObject({ MATCHED_HIGH: 2, UNMATCHED_VIDEO: 1, CONFLICT: 0 });
    expect(first.summary.videoArtists.inserted).toBe(2);
    expect(first.summary.videoTracks.inserted).toBe(5);

    const occurrences = await getPool().query(`
      SELECT t.track_number, t.title, vt.start_seconds, vt.end_seconds, vt.confidence::text, vt.notes
        FROM media.video_tracks vt JOIN public.tracks t ON t.id=vt.track_id
        JOIN media.youtube_videos v ON v.id=vt.video_id
       WHERE v.video_id='Q-pRpO2sYSI' ORDER BY vt.start_seconds`);
    expect(occurrences.rows.map((row) => [row.track_number, row.start_seconds, row.end_seconds])).toEqual([[1, 0, 247], [2, 247, 475], [3, 475, 615], [4, 615, 940]]);
    expect(occurrences.rows.every((row) => row.confidence === "high" && row.notes === "yt:reconcile")).toBe(true);

    const second = await reconcileYouTubeChannel({ reportDir });
    expect(second.summary.videoArtists.inserted).toBe(0);
    expect(second.summary.videoTracks.inserted).toBe(0);
    expect(second.summary.reviewsCreated).toBe(0);
    const after = await counts();
    expect(after).toEqual({ ...before, artists: 2, tracks: 5 });
    // El core no se toca: ni discos ni pistas nuevas.
    expect(after.albums).toBe(before.albums);
    expect(after.core_tracks).toBe(before.core_tracks);

    const report = await readFile(path.join(reportDir, "youtube-reconciliation.md"), "utf8");
    expect(report).toContain("| UNMATCHED_VIDEO | 1");
    expect(report).toContain("zNdcRR1rBZE");
  });
});
