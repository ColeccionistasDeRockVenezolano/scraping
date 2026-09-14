import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fixture from "../fixtures/youtube-video-Q-pRpO2sYSI.json" with { type: "json" };
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { closeDb, getPool } from "../../src/db/client.js";
import { resetEnvCache } from "../../src/config/env.js";
import { migrateUp } from "../../src/db/migrate.js";
import { importYouTubeMasterSheet, persistVideoPayload } from "../../src/youtube/pipeline.js";
import type { YouTubeVideoPayload } from "../../src/youtube/api.js";

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
  afterAll(async () => { await closeDb(); await container.stop(); }, 60_000);

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
});
