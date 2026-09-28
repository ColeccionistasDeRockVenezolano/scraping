import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixture from "../fixtures/youtube-video-Q-pRpO2sYSI.json" with { type: "json" };
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { importYouTubeMasterSheet, persistVideoPayload } from "../../src/youtube/pipeline.js";
import { YouTubeDataApi, type YouTubeVideoPayload } from "../../src/youtube/api.js";
import { enrichArtistFromYouTube, youtubeQuotaUsedToday } from "../../src/youtube/enrich.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";

async function writeSheet(file: string, rows: Array<[number | null, string, string, string, string]>): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("YT");
  sheet.addRow(["Upload Order", "Artist Name", "Album Name", "Album Year", "Type of Album", "URL", "Status"]);
  for (const [order, artist, album, type, video] of rows) {
    sheet.addRow([order, artist, album, 2000, type, `https://www.youtube.com/watch?v=${video}`, "Listed"]);
  }
  await workbook.xlsx.writeFile(file);
}

describe("pipeline de seed y metadatos oficiales de YouTube", () => {
  let container: PgContainer;
  beforeAll(async () => {
    container = await startPgContainer();
    process.env["DATABASE_URL"] = container.databaseUrl;
    delete process.env["YOUTUBE_API_KEY"];
    resetEnvCache();
    await applyCore(container.name);
    await migrateUp();
  }, 120_000);
  afterAll(async () => { await closeDb(); await container?.stop(); }, 60_000);

  it("imports the actual XLSX twice without duplicate seed rows", async () => {
    const first = await importYouTubeMasterSheet();
    const second = await importYouTubeMasterSheet();
    const pool = getPool();
    const seeds = await pool.query<{ count: string; distinct_video_ids: string }>("SELECT count(*)::text, count(DISTINCT video_id)::text AS distinct_video_ids FROM ingest.seed_uploads");
    expect(first.inserted).toBeGreaterThan(0);
    expect(second.inserted).toBe(0);
    expect(second.unchanged).toBe(first.inserted);
    expect(Number(seeds.rows[0]!.count)).toBe(first.inserted);
    expect(Number(seeds.rows[0]!.distinct_video_ids)).toBeGreaterThan(0);
    const mediaReviews = await pool.query("SELECT count(*)::int AS count FROM ingest.review_queue WHERE kind='media_type_no_album'");
    expect(mediaReviews.rows[0]!.count).toBeGreaterThan(0);
    // Las filas EMPTY (órdenes 97 y 440) son huecos de la hoja, no discos sin video: van a
    // seed_incomplete y nunca a missing_url (PHASES F2: 86 missing_url + 2 seed_incomplete).
    const empty = await pool.query<{ kind: string; upload_order: number }>(`
      SELECT q.kind::text, s.upload_order FROM ingest.review_queue q
        JOIN ingest.seed_uploads s ON s.id=(q.payload->>'seedUploadId')::bigint
       WHERE s.artist_name_raw='EMPTY' ORDER BY s.upload_order`);
    expect(empty.rows).toEqual([{ kind: "seed_incomplete", upload_order: 97 }, { kind: "seed_incomplete", upload_order: 440 }]);
  });

  it("persists the Q-pRpO2sYSI fixture and its structured description without a key", async () => {
    const client = await getPool().connect();
    try {
      await client.query("BEGIN");
      const id = await persistVideoPayload(client, fixture as YouTubeVideoPayload);
      await client.query("COMMIT");
      const video = await getPool().query("SELECT video_id,duration_seconds,publication_status,tags,metadata->'snippet'->>'title' AS title FROM media.youtube_videos WHERE id=$1", [id]);
      expect(video.rows[0]).toMatchObject({ video_id: "Q-pRpO2sYSI", duration_seconds: 3906, publication_status: "unlisted", title: "Prueba - Álbum completo" });
      const entries = await getPool().query("SELECT title,start_seconds FROM media.youtube_tracklist_entries WHERE video_id=$1 ORDER BY position", [id]);
      expect(entries.rows).toEqual([{ title: "Apertura", start_seconds: 0 }, { title: "Segunda canción", start_seconds: 247 }, { title: "Final", start_seconds: 3734 }]);
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  });

  it("yt:enrich-artist respeta el presupuesto diario de cuota y su dry-run no llama a la API", async () => {
    process.env["YOUTUBE_DAILY_QUOTA_UNITS"] = "10000";
    resetEnvCache();
    const pool = getPool();
    const enrichRuns = async () => Number((await pool.query<{ count: string }>(
      "SELECT count(*)::text FROM ingest.scrape_runs WHERE kind='enrich_artist'")).rows[0]!.count);
    const artist = await pool.query<{ id: string }>("INSERT INTO public.artists(name, artist_type) VALUES ('Banda De Prueba De Cuota', 'band') RETURNING id::text");
    await pool.query("INSERT INTO public.albums(artist_id, title, album_type, release_year) VALUES ($1, 'Disco Sin Video', 'studio_album', 1999)", [artist.rows[0]!.id]);
    let calls = 0;
    const api = new YouTubeDataApi("clave-de-prueba", async () => {
      calls += 1;
      return new Response(JSON.stringify({ items: [] }), { status: 200 });
    });
    const channelId = "UCtYlrz6GyvRahlhHjocWQYQ";
    const runsBefore = await enrichRuns();

    const dry = await enrichArtistFromYouTube("Banda De Prueba De Cuota", { api, channelId, dryRun: true });
    expect(dry.skippedReason).toMatch(/^dry-run: .*\(100 unidades\)/);

    // Un run de hoy que ya gastó 9.950 unidades deja menos de lo que cuesta buscar (100) e hidratar (1).
    const usedBefore = await youtubeQuotaUsedToday();
    await pool.query("INSERT INTO ingest.scrape_runs(kind, status, counters) VALUES ('enrich_artist', 'ok', $1::jsonb)", [JSON.stringify({ quotaSpent: 9_950 })]);
    expect(await youtubeQuotaUsedToday()).toBe(usedBefore + 9_950);
    const blocked = await enrichArtistFromYouTube("Banda De Prueba De Cuota", { api, channelId });
    expect(blocked.skippedReason).toMatch(/presupuesto de cuota agotado/);
    expect(blocked.searched).toBe(false);
    expect(calls).toBe(0);
    // Solo el run sembrado: ni el dry-run ni la búsqueda bloqueada abren un run.
    expect(await enrichRuns()).toBe(runsBefore + 1);
  });

  // Brian, 2026-09-22: Shorts e Interview van sin Upload Order. La fila se
  // casa por video, no por número: si no, un cambio de orden haría que cada
  // disco heredara los datos del vecino.
  it("casa las filas por video y acepta Shorts e Interview sin número", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "crv-sheet-"));
    try {
      const pool = getPool();
      await pool.query("DELETE FROM ingest.review_queue; UPDATE media.youtube_videos SET seed_upload_id=NULL; DELETE FROM ingest.seed_uploads");
      const before = path.join(dir, "antes.xlsx");
      await writeSheet(before, [[1, "Dermis Tatú", "La Violó", "Studio Album", "AwEF9RimQm4"], [2, "PAN", "En Vivo", "Live Album", "RpmXYPW7qMs"]]);
      await importYouTubeMasterSheet(before);
      const ids = async () => new Map((await pool.query<{ video_id: string; id: string; upload_order: number | null; content_kind: string }>(
        "SELECT video_id, id::text, upload_order, content_kind FROM ingest.seed_uploads")).rows.map((row) => [row.video_id, row]));
      const first = await ids();

      const after = path.join(dir, "despues.xlsx");
      await writeSheet(after, [
        [null, "Coleccionistas De Rock Venezolano", "Primera Entrevista Radial", "Interview", "6D5RhoPLotE"],
        [1, "Dermis Tatú", "La Violó", "Studio Album", "AwEF9RimQm4"],
        [2, "PAN", "En Vivo", "Live Album", "RpmXYPW7qMs"],
        [null, "Babylon Motorhome", "Interesante reseña", "Shorts", "zNdcRR1rBZE"],
        [null, "", "Jorge Spiteri: vida, obra y legado", "Shorts", "SSwmX3ZZPi4"],
      ]);
      const result = await importYouTubeMasterSheet(after);
      expect(result).toMatchObject({ inserted: 3, updated: 2, unlisted: 0 });
      const second = await ids();
      expect(second.get("AwEF9RimQm4")).toMatchObject({ id: first.get("AwEF9RimQm4")!.id, upload_order: 1 });
      expect(second.get("RpmXYPW7qMs")).toMatchObject({ id: first.get("RpmXYPW7qMs")!.id, upload_order: 2 });
      expect(second.get("zNdcRR1rBZE")).toMatchObject({ upload_order: null, content_kind: "media" });
      expect(second.get("SSwmX3ZZPi4")).toMatchObject({ upload_order: null, content_kind: "media" });
      expect(second.get("6D5RhoPLotE")).toMatchObject({ upload_order: null, content_kind: "media" });

      // Un disco sin Upload Order sigue siendo un error de la hoja.
      const broken = path.join(dir, "rota.xlsx");
      await writeSheet(broken, [[null, "PAN", "En Vivo", "Live Album", "RpmXYPW7qMs"]]);
      await expect(importYouTubeMasterSheet(broken)).rejects.toThrow(/Upload Order inválido/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
