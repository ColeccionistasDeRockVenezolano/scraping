import { createHash } from "node:crypto";
import path from "node:path";
import ExcelJS from "exceljs";
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { YT_MASTER_XLSX_PATH } from "../ingest/sources.js";
import { YouTubeDataApi, iso8601DurationToSeconds, youtubePublicationStatus, type YouTubeChannelPayload, type YouTubePlaylistItemPayload, type YouTubeVideoPayload } from "./api.js";
import { canonicalVideoUrl, classifyContentType, extractYouTubeVideoId } from "./normalization.js";
import { parseYouTubeDescription, parseYouTubeTitle } from "./parsers.js";

type Json = Record<string, unknown>;
export interface SeedImportResult { inserted: number; updated: number; unchanged: number; videos: number; reviews: number; }
interface SeedRow { uploadOrder: number; artistName: string | null; albumName: string | null; albumYear: number | null; type: string | null; url: string | null; status: string | null; rowNumber: number; }

function asText(value: ExcelJS.CellValue): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && "text" in value && typeof value.text === "string") return value.text.trim() || null;
  const text = String(value).trim();
  return text || null;
}
function sourceUrl(cell: ExcelJS.Cell): string | null {
  const value = cell.value;
  if (typeof value === "object" && value !== null && "hyperlink" in value && typeof value.hyperlink === "string") return value.hyperlink;
  return asText(value);
}
function normalizedHeader(value: string): string { return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]/g, ""); }
function seedHash(row: SeedRow, videoId: string | null): string { return createHash("sha256").update(JSON.stringify({ ...row, videoId })).digest("hex"); }
function validYear(value: string | null): number | null { const year = Number(value); return Number.isInteger(year) && year >= 1000 && year <= 3000 ? year : null; }

export async function readYouTubeMasterSheet(filePath = YT_MASTER_XLSX_PATH): Promise<SeedRow[]> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error(`${filePath}: el XLSX no contiene una hoja`);
  const columns = new Map<string, number>();
  sheet.getRow(1).eachCell((cell, index) => columns.set(normalizedHeader(cell.text), index));
  const required = ["uploadorder", "artistname", "albumname", "albumyear", "typeofalbum", "url", "status"];
  const missing = required.filter((name) => !columns.has(name));
  if (missing.length) throw new Error(`${filePath}: faltan columnas conocidas: ${missing.join(", ")}`);
  const get = (row: ExcelJS.Row, header: string) => asText(row.getCell(columns.get(header)!).value);
  const result: SeedRow[] = [];
  sheet.eachRow((row, number) => {
    if (number === 1) return;
    const order = Number(get(row, "uploadorder"));
    // Completely blank trailing/formatted rows are not records.
    if (!Number.isInteger(order) && !get(row, "artistname") && !get(row, "albumname") && !sourceUrl(row.getCell(columns.get("url")!))) return;
    if (!Number.isInteger(order) || order < 0 || order > 32767) throw new Error(`${filePath}: Upload Order inválido en fila ${number}`);
    result.push({
      uploadOrder: order, artistName: get(row, "artistname"), albumName: get(row, "albumname"),
      albumYear: validYear(get(row, "albumyear")), type: get(row, "typeofalbum"),
      url: sourceUrl(row.getCell(columns.get("url")!)), status: get(row, "status"), rowNumber: number,
    });
  });
  return result;
}

async function ensureSources(client: PoolClient): Promise<{ seed: number; api: number }> {
  const rows = await client.query<{ id: string; slug: string }>(`
    INSERT INTO ingest.sources(slug,name,url,site_type,access_strategy,trust_level,enabled,public_display,notes)
    VALUES
      ('yt-master-seed','YT Master Spreadsheet (seed interno)',NULL,'spreadsheet','Importación XLSX directa; no HTTP','high',false,false,'Seed audiovisual'),
      ('youtube-data-api','YouTube Data API v3','https://developers.google.com/youtube/v3','youtube_api','videos.list, channels.list y playlistItems.list; sin scraping HTML','api',true,false,'Fuente oficial de metadatos')
    ON CONFLICT (slug) DO UPDATE SET name=EXCLUDED.name, url=EXCLUDED.url, access_strategy=EXCLUDED.access_strategy, updated_at=now()
    RETURNING id,slug`);
  const current = await client.query<{ id: string; slug: string }>("SELECT id,slug FROM ingest.sources WHERE slug IN ('yt-master-seed','youtube-data-api')");
  const bySlug = new Map(current.rows.map((row) => [row.slug, Number(row.id)]));
  void rows;
  const seed = bySlug.get("yt-master-seed"); const api = bySlug.get("youtube-data-api");
  if (!seed || !api) throw new Error("no se pudieron asegurar las fuentes de YouTube");
  return { seed, api };
}

async function addReview(client: PoolClient, kind: string, seedUploadId: number, payload: Json, notes: string, videoId?: number): Promise<boolean> {
  const result = await client.query(`
    INSERT INTO ingest.review_queue(kind, video_id, priority, payload, notes)
    SELECT $1::ingest.review_kind, $3, 5, $4::jsonb, $5
    WHERE NOT EXISTS (
      SELECT 1 FROM ingest.review_queue
       WHERE kind=$1::ingest.review_kind AND status IN ('open','in_progress')
         AND payload->>'seedUploadId'=$2::text
    )`, [kind, seedUploadId, videoId ?? null, JSON.stringify({ seedUploadId, ...payload }), notes]);
  return result.rowCount === 1;
}

async function linkExistingRelease(client: PoolClient, seedUploadId: number, videoDbId: number, artist: string | null, album: string | null, sourceId: number): Promise<boolean> {
  if (!artist || !album) return false;
  const found = await client.query<{ id: string }>(`
    SELECT al.id FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id
     WHERE lower(ar.name)=lower($1) AND lower(al.title)=lower($2) ORDER BY al.id LIMIT 1`, [artist, album]);
  const albumId = found.rows[0]?.id;
  if (!albumId) return false;
  await client.query(`
    INSERT INTO media.video_albums(video_id,album_id,album_kind,is_primary_link,confidence,source_id)
    VALUES ($1,$2,'full_album',false,'high',$3)
    ON CONFLICT(video_id,album_id) DO UPDATE SET confidence='high', source_id=EXCLUDED.source_id`, [videoDbId, albumId, sourceId]);
  return true;
}

export async function importYouTubeMasterSheet(filePath = YT_MASTER_XLSX_PATH): Promise<SeedImportResult> {
  const rows = await readYouTubeMasterSheet(filePath);
  const orders = new Set<number>();
  for (const row of rows) { if (orders.has(row.uploadOrder)) throw new Error(`${filePath}: Upload Order duplicado: ${row.uploadOrder}`); orders.add(row.uploadOrder); }
  const client = await getPool().connect();
  const result: SeedImportResult = { inserted: 0, updated: 0, unchanged: 0, videos: 0, reviews: 0 };
  try {
    await client.query("BEGIN");
    const source = await ensureSources(client);
    const run = await client.query<{ id: string }>(`INSERT INTO ingest.scrape_runs(kind,source_id,status,params) VALUES ('seed_yt',$1,'running',$2::jsonb) RETURNING id`, [source.seed, JSON.stringify({ action: "youtube_import_sheet", file: path.basename(filePath), rows: rows.length })]);
    const runId = Number(run.rows[0]!.id);
    for (const row of rows) {
      const videoId = extractYouTubeVideoId(row.url);
      const classification = classifyContentType(row.type);
      const hash = seedHash(row, videoId);
      const old = await client.query<{ id: string; row_hash: string }>("SELECT id,row_hash FROM ingest.seed_uploads WHERE upload_order=$1 FOR UPDATE", [row.uploadOrder]);
      let seedUploadId: number;
      if (!old.rows[0]) result.inserted += 1;
      else if (old.rows[0].row_hash === hash) result.unchanged += 1;
      else result.updated += 1;
      const saved = await client.query<{ id: string }>(`
        INSERT INTO ingest.seed_uploads(upload_order,artist_name_raw,album_name_raw,album_year_raw,type_raw,url_raw,status_raw,video_id,row_number,row_hash,content_kind,normalized_type,classification_reason,run_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(upload_order) DO UPDATE SET artist_name_raw=EXCLUDED.artist_name_raw,album_name_raw=EXCLUDED.album_name_raw,album_year_raw=EXCLUDED.album_year_raw,type_raw=EXCLUDED.type_raw,url_raw=EXCLUDED.url_raw,status_raw=EXCLUDED.status_raw,video_id=EXCLUDED.video_id,row_number=EXCLUDED.row_number,row_hash=EXCLUDED.row_hash,content_kind=EXCLUDED.content_kind,normalized_type=EXCLUDED.normalized_type,classification_reason=EXCLUDED.classification_reason,run_id=EXCLUDED.run_id,imported_at=now()
        RETURNING id`, [row.uploadOrder,row.artistName,row.albumName,row.albumYear,row.type,row.url, row.status, videoId,row.rowNumber,hash,classification.kind,classification.normalizedType,classification.reason,runId]);
      seedUploadId = Number(saved.rows[0]!.id);
      if (!videoId) { if (await addReview(client, "missing_url", seedUploadId, { rawUrl: row.url }, "Fila seed sin URL de YouTube canónica")) result.reviews += 1; continue; }
      const savedVideo = await client.query<{ id: string }>(`
        INSERT INTO media.youtube_videos(video_id,url,seed_upload_id,publication_status)
        VALUES($1,$2,$3,'unknown')
        ON CONFLICT(video_id) DO UPDATE SET url=EXCLUDED.url, seed_upload_id=COALESCE(media.youtube_videos.seed_upload_id, EXCLUDED.seed_upload_id), updated_at=now()
        RETURNING id`, [videoId, canonicalVideoUrl(videoId), seedUploadId]);
      const videoDbId = Number(savedVideo.rows[0]!.id); result.videos += 1;
      if (classification.kind === "release") {
        if (!await linkExistingRelease(client, seedUploadId, videoDbId, row.artistName, row.albumName, source.seed)) {
          if (await addReview(client, "album_match", seedUploadId, { artist: row.artistName, album: row.albumName, type: row.type }, "Release seed sin álbum canónico existente; no se crea automáticamente" , videoDbId)) result.reviews += 1;
        }
      } else if (classification.kind === "media") {
        if (await addReview(client, "media_type_no_album", seedUploadId, { type: row.type }, "Contenido audiovisual conservado como video; no crea álbum", videoDbId)) result.reviews += 1;
      } else if (await addReview(client, "manual_review", seedUploadId, { type: row.type, reason: classification.reason }, classification.reason, videoDbId)) result.reviews += 1;
    }
    await client.query("UPDATE ingest.scrape_runs SET status='ok',finished_at=now(),counters=$2::jsonb WHERE id=$1", [runId, JSON.stringify(result)]);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

function text(value: unknown): string | null { return typeof value === "string" && value.trim() ? value : null; }
function thumbnail(snippet: Record<string, unknown> | undefined): string | null {
  const all = snippet?.["thumbnails"] as Record<string, { url?: unknown }> | undefined;
  for (const key of ["maxres", "standard", "high", "medium", "default"]) { const url = all?.[key]?.url; if (typeof url === "string") return url; }
  return null;
}

export async function persistVideoPayload(client: PoolClient, payload: YouTubeVideoPayload, sourceId?: number): Promise<number> {
  const snippet = payload.snippet; const details = payload.contentDetails; const status = payload.status;
  const videoId = payload.id;
  if (!extractYouTubeVideoId(videoId)) throw new Error(`videos.list devolvió un ID inválido: ${videoId}`);
  const persisted = await client.query<{ id: string }>(`
    INSERT INTO media.youtube_videos(video_id,url,title,description,channel_id,channel_title,published_at,duration_seconds,thumbnail_url,tags,publication_status,metadata,last_fetched_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,now(),now())
    ON CONFLICT(video_id) DO UPDATE SET url=EXCLUDED.url,title=EXCLUDED.title,description=EXCLUDED.description,channel_id=EXCLUDED.channel_id,channel_title=EXCLUDED.channel_title,published_at=EXCLUDED.published_at,duration_seconds=EXCLUDED.duration_seconds,thumbnail_url=EXCLUDED.thumbnail_url,tags=EXCLUDED.tags,publication_status=EXCLUDED.publication_status,metadata=EXCLUDED.metadata,last_fetched_at=now(),updated_at=now()
    RETURNING id`, [videoId, canonicalVideoUrl(videoId),text(snippet?.["title"]),text(snippet?.["description"]),text(snippet?.["channelId"]),text(snippet?.["channelTitle"]),text(snippet?.["publishedAt"]),iso8601DurationToSeconds(text(details?.["duration"]) ?? undefined),thumbnail(snippet),JSON.stringify(Array.isArray(snippet?.["tags"]) ? snippet!["tags"] : []),youtubePublicationStatus(status),JSON.stringify(payload)]);
  const id = Number(persisted.rows[0]!.id);
  const parsed = parseYouTubeDescription(text(snippet?.["description"]));
  await client.query("DELETE FROM media.youtube_description_sections WHERE video_id=$1", [id]);
  await client.query("DELETE FROM media.youtube_tracklist_entries WHERE video_id=$1", [id]);
  for (const section of parsed.sections) await client.query("INSERT INTO media.youtube_description_sections(video_id,position,section_kind,heading,content) VALUES($1,$2,$3,$4,$5)", [id, section.position, section.kind, section.heading, section.content]);
  for (const entry of parsed.tracklist) await client.query("INSERT INTO media.youtube_tracklist_entries(video_id,position,title,start_seconds) VALUES($1,$2,$3,$4)", [id, entry.position, entry.title, entry.startSeconds]);
  void sourceId; // relation rows use the source; raw API payload identifies the official source.
  return id;
}

export async function syncYouTubeVideo(videoId: string, api = new YouTubeDataApi()): Promise<{ synced: boolean; videoId: string }> {
  if (!extractYouTubeVideoId(videoId)) throw new Error(`video ID inválido: ${videoId}`);
  const response = await api.listVideos([videoId]);
  const payload = response.items?.[0];
  if (!payload) return { synced: false, videoId };
  const client = await getPool().connect();
  try { await client.query("BEGIN"); await persistVideoPayload(client, payload); await client.query("COMMIT"); return { synced: true, videoId }; }
  catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

async function persistChannel(client: PoolClient, payload: YouTubeChannelPayload): Promise<{ id: number; uploadsPlaylistId: string | null }> {
  const snippet = payload.snippet; const details = payload.contentDetails;
  const uploads = (details?.["relatedPlaylists"] as Record<string, unknown> | undefined)?.["uploads"];
  const saved = await client.query<{ id: string }>(`
    INSERT INTO media.youtube_channels(channel_id,title,description,uploads_playlist_id,thumbnail_url,publication_status,metadata,last_fetched_at,updated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())
    ON CONFLICT(channel_id) DO UPDATE SET title=EXCLUDED.title,description=EXCLUDED.description,uploads_playlist_id=EXCLUDED.uploads_playlist_id,thumbnail_url=EXCLUDED.thumbnail_url,publication_status=EXCLUDED.publication_status,metadata=EXCLUDED.metadata,last_fetched_at=now(),updated_at=now()
    RETURNING id`, [payload.id,text(snippet?.["title"]),text(snippet?.["description"]),text(uploads),thumbnail(snippet),youtubePublicationStatus(payload.status),JSON.stringify(payload)]);
  return { id: Number(saved.rows[0]!.id), uploadsPlaylistId: text(uploads) };
}

function playlistVideoId(item: YouTubePlaylistItemPayload): string | null {
  const details = item.contentDetails as Record<string, unknown> | undefined;
  const resource = item.snippet?.["resourceId"] as Record<string, unknown> | undefined;
  const id = text(details?.["videoId"]) ?? text(resource?.["videoId"]);
  return extractYouTubeVideoId(id);
}

export interface HydrationResult { requested: number; hydrated: number; missing: string[]; batches: number; errors: number; runId: number; }

/**
 * Paso 2: hidratación por lotes de 50. Igual que el descubrimiento, la red
 * queda fuera de toda transacción y cada lote se confirma solo, así que un
 * lote que falla no arrastra a los anteriores ni impide los siguientes.
 *
 * Un ID pedido que `videos.list` no devuelve **es un dato**: el video fue
 * borrado o pasó a privado. Se anota en `ingest.scrape_errors` y vuelve en
 * `missing` en vez de desaparecer en silencio.
 */
export async function hydrateYouTubeVideos(videoIds: string[], options: { api?: YouTubeDataApi; runId?: number } = {}): Promise<HydrationResult> {
  const api = options.api ?? new YouTubeDataApi();
  const pool = getPool();
  const ids = [...new Set(videoIds)].filter((id) => extractYouTubeVideoId(id));
  const pending = new Set(ids);
  let runId = options.runId ?? 0; let ownRun = false;
  if (!runId) {
    const setup = await pool.connect();
    try {
      await setup.query("BEGIN");
      const source = await ensureSources(setup);
      const run = await setup.query<{ id: string }>(`INSERT INTO ingest.scrape_runs(kind,source_id,status,params) VALUES('yt_api_sync',$1,'running',$2::jsonb) RETURNING id`,
        [source.api, JSON.stringify({ action: "hydrate_videos", requested: ids.length })]);
      runId = Number(run.rows[0]!.id); ownRun = true;
      await setup.query("COMMIT");
    } catch (error) { await setup.query("ROLLBACK"); throw error; } finally { setup.release(); }
  }

  let hydrated = 0, batches = 0, errors = 0;
  for (let offset = 0; offset < ids.length; offset += 50) {
    const batch = ids.slice(offset, offset + 50);
    let response;
    try {
      response = await api.listVideos(batch);
    } catch (error) {
      errors += 1;
      const client = await pool.connect();
      try { await recordSweepError(client, runId, "https://www.googleapis.com/youtube/v3/videos", "http_error", `lote ${batches + 1} (${batch.length} IDs): ${String(error)}`); } finally { client.release(); }
      continue;
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      for (const video of response.items ?? []) { await persistVideoPayload(client, video); pending.delete(video.id); hydrated += 1; }
      batches += 1;
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }

  const missing = [...pending];
  if (missing.length) {
    const client = await pool.connect();
    try {
      for (const id of missing) await recordSweepError(client, runId, canonicalVideoUrl(id), "validation", "videos.list no devolvió el video: borrado o privado");
    } finally { client.release(); }
  }
  if (ownRun) {
    const closing = await pool.connect();
    try {
      await closing.query("UPDATE ingest.scrape_runs SET status=$2,finished_at=now(),counters=$3::jsonb,error_log=$4 WHERE id=$1",
        [runId, errors > 0 ? "partial" : "ok", JSON.stringify({ requested: ids.length, hydrated, missing: missing.length, batches, errors }),
         errors > 0 ? `${errors} lote(s) con error; ver ingest.scrape_errors` : null]);
    } finally { closing.release(); }
  }
  return { requested: ids.length, hydrated, missing, batches, errors, runId };
}

/**
 * Descubrimiento + hidratación. Antes esto abría una transacción y hacía
 * dentro todas las llamadas HTTP del canal: un fallo en la página doce
 * borraba las once anteriores. Ahora se apoya en las dos piezas que sí
 * confirman por tramos.
 */
export async function syncYouTubeChannel(channelId: string, api = new YouTubeDataApi()): Promise<{ channelId: string; uploads: number; syncedVideos: number; missing: string[] }> {
  const discovery = await discoverChannelUploads(channelId, { api });
  const rows = await getPool().query<{ video_id: string }>(`
    SELECT u.video_id FROM media.youtube_channel_uploads u
      JOIN media.youtube_channels c ON c.id = u.channel_id
     WHERE c.channel_id = $1`, [channelId]);
  const hydration = await hydrateYouTubeVideos(rows.rows.map((row) => row.video_id), { api });
  return { channelId, uploads: discovery.items, syncedVideos: hydration.hydrated, missing: hydration.missing };
}

export interface ChannelDiscoveryResult {
  channelId: string; runId: number; declaredVideoCount: number | null;
  pages: number; items: number; inserted: number; updated: number; errors: number;
  status: "ok" | "partial";
}

async function recordSweepError(client: PoolClient, runId: number, url: string, kind: string, message: string): Promise<void> {
  await client.query("INSERT INTO ingest.scrape_errors(run_id,url,error_kind,message) VALUES($1,$2,$3,$4)", [runId, url, kind, message.slice(0, 4000)]);
}

/**
 * Paso 1 del barrido del canal: **descubrimiento puro**. Recorre el playlist
 * de uploads y anota qué videos existen, sin pedir un solo metadato de video
 * (eso es `videos.list`, y va en su propio paso). Tres diferencias
 * deliberadas frente a `syncYouTubeChannel`:
 *
 *  1. La red nunca ocurre dentro de una transacción abierta. Cada página se
 *     confirma sola, así que un fallo en la página doce conserva las once
 *     anteriores en vez de borrarlas.
 *  2. El progreso vive en `ingest.scrape_runs.counters.nextPageToken`, de
 *     modo que `--resume` continúa donde quedó el último run parcial.
 *  3. Un error no aborta: se persiste en `ingest.scrape_errors` y el run
 *     queda `partial`.
 */
export async function discoverChannelUploads(
  channelId: string,
  options: { api?: YouTubeDataApi; resume?: boolean } = {},
): Promise<ChannelDiscoveryResult> {
  const api = options.api ?? new YouTubeDataApi();
  const pool = getPool();
  const channel = (await api.getChannel(channelId)).items?.[0];
  if (!channel) throw new Error(`channels.list no encontró el canal ${channelId}`);
  const declared = Number(channel.statistics?.["videoCount"]);
  const declaredVideoCount = Number.isFinite(declared) ? declared : null;

  const setup = await pool.connect();
  let channelRowId: number; let uploadsPlaylistId: string | null; let runId: number; let resumeToken: string | undefined;
  try {
    await setup.query("BEGIN");
    const source = await ensureSources(setup);
    const saved = await persistChannel(setup, channel);
    channelRowId = saved.id; uploadsPlaylistId = saved.uploadsPlaylistId;
    if (options.resume) {
      const prior = await setup.query<{ id: string; token: string | null }>(`
        SELECT id, counters->>'nextPageToken' AS token FROM ingest.scrape_runs
         WHERE kind='yt_api_sync' AND status='partial'
           AND params->>'action'='discover_channel_uploads' AND params->>'channelId'=$1
         ORDER BY started_at DESC LIMIT 1`, [channelId]);
      resumeToken = prior.rows[0]?.token ?? undefined;
    }
    const run = await setup.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind,source_id,status,params)
      VALUES('yt_api_sync',$1,'running',$2::jsonb) RETURNING id`,
      [source.api, JSON.stringify({ action: "discover_channel_uploads", channelId, uploadsPlaylistId, declaredVideoCount, resumedFromToken: resumeToken ?? null })]);
    runId = Number(run.rows[0]!.id);
    await setup.query("COMMIT");
  } catch (error) { await setup.query("ROLLBACK"); throw error; } finally { setup.release(); }

  const playlistUrl = `https://www.googleapis.com/youtube/v3/playlistItems?playlistId=${uploadsPlaylistId ?? ""}`;
  let pages = 0, items = 0, inserted = 0, updated = 0, errors = 0;
  let pageToken = resumeToken;

  if (uploadsPlaylistId) {
    for (;;) {
      let page;
      try {
        page = await api.listPlaylistItems(uploadsPlaylistId, pageToken);
      } catch (error) {
        errors += 1;
        const client = await pool.connect();
        try { await recordSweepError(client, runId, playlistUrl, "http_error", `página ${pages + 1} (token=${pageToken ?? "inicial"}): ${String(error)}`); } finally { client.release(); }
        break;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        for (const item of page.items ?? []) {
          const videoId = playlistVideoId(item);
          if (!videoId) {
            errors += 1;
            await recordSweepError(client, runId, playlistUrl, "extraction", `entrada del playlist sin videoId utilizable: ${JSON.stringify(item).slice(0, 500)}`);
            continue;
          }
          items += 1;
          const row = await client.query<{ inserted: boolean }>(`
            INSERT INTO media.youtube_channel_uploads(channel_id,video_id,playlist_position,published_at,title,payload,updated_at)
            VALUES($1,$2,$3,$4,$5,$6::jsonb,now())
            ON CONFLICT(channel_id,video_id) DO UPDATE SET playlist_position=EXCLUDED.playlist_position,published_at=EXCLUDED.published_at,title=EXCLUDED.title,payload=EXCLUDED.payload,updated_at=now()
            RETURNING (xmax = 0) AS inserted`,
            [channelRowId, videoId, Number(item.snippet?.["position"] ?? 0), text(item.contentDetails?.["videoPublishedAt"]) ?? text(item.snippet?.["publishedAt"]), text(item.snippet?.["title"]), JSON.stringify(item)]);
          if (row.rows[0]?.inserted) inserted += 1; else updated += 1;
        }
        pages += 1;
        pageToken = page.nextPageToken;
        await client.query("UPDATE ingest.scrape_runs SET counters=$2::jsonb WHERE id=$1",
          [runId, JSON.stringify({ pages, items, inserted, updated, errors, nextPageToken: pageToken ?? null })]);
        await client.query("COMMIT");
      } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
      if (!pageToken) break;
    }
  } else {
    errors += 1;
    const client = await pool.connect();
    try { await recordSweepError(client, runId, `https://www.youtube.com/channel/${channelId}`, "validation", "channels.list no expuso relatedPlaylists.uploads"); } finally { client.release(); }
  }

  const status: "ok" | "partial" = errors > 0 ? "partial" : "ok";
  const closing = await pool.connect();
  try {
    await closing.query("UPDATE ingest.scrape_runs SET status=$2,finished_at=now(),counters=$3::jsonb,error_log=$4 WHERE id=$1",
      [runId, status, JSON.stringify({ pages, items, inserted, updated, errors, declaredVideoCount, nextPageToken: pageToken ?? null }),
       errors > 0 ? `${errors} incidencia(s); ver ingest.scrape_errors` : null]);
  } finally { closing.release(); }

  return { channelId, runId, declaredVideoCount, pages, items, inserted, updated, errors, status };
}

/**
 * El universo de videos a hidratar: la unión de lo que la hoja registra con
 * lo que el canal expone. No son el mismo conjunto —518 coinciden, 128 solo
 * están en el canal y 2 solo en la hoja (SOURCES.md §2.1)— y las dos
 * diferencias importan. Los del canal ausentes de la hoja son discos que la
 * discografía curada no anotó; los de la hoja ausentes del canal son
 * justamente los que hay que interrogar por ID, porque `videos.list`
 * devuelve los no listados y omite los borrados.
 */
export async function knownYouTubeVideoIds(options: { pendingOnly?: boolean } = {}): Promise<string[]> {
  const result = await getPool().query<{ video_id: string }>(`
    WITH universo AS (
      SELECT video_id FROM ingest.seed_uploads WHERE video_id IS NOT NULL
      UNION
      SELECT video_id FROM media.youtube_channel_uploads
    )
    SELECT u.video_id FROM universo u
      LEFT JOIN media.youtube_videos v ON v.video_id = u.video_id
     WHERE $1::boolean IS NOT TRUE OR v.last_fetched_at IS NULL
     ORDER BY u.video_id`, [options.pendingOnly ?? false]);
  return result.rows.map((row) => row.video_id);
}

export async function unmatchedYouTubeRows(): Promise<Array<{ uploadOrder: number; artist: string | null; album: string | null; videoId: string | null; contentKind: string | null }>> {
  const result = await getPool().query(`
    SELECT s.upload_order,s.artist_name_raw,s.album_name_raw,s.video_id,s.content_kind
      FROM ingest.seed_uploads s
      LEFT JOIN media.youtube_videos v ON v.video_id=s.video_id
      LEFT JOIN media.video_albums va ON va.video_id=v.id
     WHERE s.video_id IS NULL OR s.content_kind='review' OR (s.content_kind='release' AND va.album_id IS NULL)
     ORDER BY s.upload_order`);
  return result.rows.map((row) => ({ uploadOrder: Number(row.upload_order), artist: row.artist_name_raw, album: row.album_name_raw, videoId: row.video_id, contentKind: row.content_kind }));
}

export { parseYouTubeTitle };
