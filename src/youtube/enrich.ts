// Enriquecimiento dirigido por artista (PHASES F3, ARCHITECTURE §4.12).
//
// Es el último recurso, no un barrido: solo se usa para los discos de un
// artista que siguen sin video después de la hoja, el canal y yt:link. Tres
// límites lo mantienen acotado:
//
//   1. SOLO EL CANAL. `search.list` va con `channelId`: un video de otro canal
//      no puede proponerse como enlace de un disco (regla 1: el canal manda).
//   2. PRESUPUESTO. Cada búsqueda cuesta 100 unidades. Antes de gastar se suma
//      lo consumido hoy por los runs de YouTube; si no alcanza, no se llama.
//   3. NUNCA ENLAZA NI CREA. Una coincidencia exacta artista+título abre una
//      revisión `youtube_match` con el candidato; la selección la confirma una
//      persona con `yt:link --album --video --confirm`. Nunca crea álbumes.
import { getPool } from "../db/client.js";
import { getEnv } from "../config/env.js";
import { QUOTA_COST, YouTubeDataApi, type YouTubeSearchItem } from "./api.js";
import { youtubeLinkKey } from "./linker.js";
import { parseYouTubeTitle } from "./parsers.js";
import { hydrateYouTubeVideos } from "./pipeline.js";

export interface EnrichmentAlbum { albumId: number; title: string; year: number | null; }
export interface EnrichmentVideo { videoId: string; title: string; }
export interface EnrichmentMatch { albumId: number; album: string; videoId: string; videoTitle: string; }

export interface EnrichmentResult {
  artist: string;
  artistId?: number;
  dryRun: boolean;
  runId?: number;
  albumsWithoutVideo: number;
  quotaUsedToday: number;
  quotaBudget: number;
  quotaSpent: number;
  searched: boolean;
  found: number;
  hydrated: number;
  matches: EnrichmentMatch[];
  reviewsCreated: number;
  skippedReason?: string;
}

/**
 * Empareja videos encontrados con discos sin video. Solo cuenta una identidad
 * exacta: mismo artista y mismo título (clave sin tildes ni signos). Un disco
 * con dos videos candidatos no se elige: queda con ambos en la revisión.
 */
export function matchEnrichmentCandidates(artist: string, albums: EnrichmentAlbum[], videos: EnrichmentVideo[]): EnrichmentMatch[] {
  const artistKey = youtubeLinkKey(artist);
  const matches: EnrichmentMatch[] = [];
  for (const video of videos) {
    const parsed = parseYouTubeTitle(video.title);
    if (!parsed.artist || youtubeLinkKey(parsed.artist) !== artistKey) continue;
    const titleKey = youtubeLinkKey(parsed.title);
    for (const album of albums) {
      if (youtubeLinkKey(album.title) !== titleKey) continue;
      if (album.year !== null && parsed.year !== null && album.year !== parsed.year) continue;
      matches.push({ albumId: album.albumId, album: album.title, videoId: video.videoId, videoTitle: video.title });
    }
  }
  return matches;
}

/** Unidades gastadas hoy por los runs que llaman a la API de YouTube. */
export async function youtubeQuotaUsedToday(): Promise<number> {
  const { rows } = await getPool().query<{ units: string | null }>(`
    SELECT coalesce(sum(
      CASE WHEN kind='enrich_artist' THEN coalesce((counters->>'quotaSpent')::int, 0)
           WHEN kind='yt_api_sync' THEN coalesce((counters->>'batches')::int, (counters->>'pages')::int, 0) * ${QUOTA_COST.videos}
           ELSE 0 END), 0)::text AS units
      FROM ingest.scrape_runs
     WHERE kind IN ('enrich_artist','yt_api_sync')
       AND (started_at AT TIME ZONE 'America/Los_Angeles')::date = (now() AT TIME ZONE 'America/Los_Angeles')::date`);
  // La cuota de YouTube se reinicia a medianoche del Pacífico.
  return Number(rows[0]?.units ?? 0);
}

export async function enrichArtistFromYouTube(
  artistName: string,
  options: { maxResults?: number; dryRun?: boolean; api?: YouTubeDataApi; channelId?: string } = {},
): Promise<EnrichmentResult> {
  const pool = getPool();
  const env = getEnv();
  const dryRun = options.dryRun ?? false;
  const result: EnrichmentResult = {
    artist: artistName, dryRun, albumsWithoutVideo: 0, quotaUsedToday: 0,
    quotaBudget: env.YOUTUBE_DAILY_QUOTA_UNITS, quotaSpent: 0, searched: false,
    found: 0, hydrated: 0, matches: [], reviewsCreated: 0,
  };

  const artist = (await pool.query<{ id: string; name: string }>(`
    SELECT a.id::text, a.name FROM public.artists a
     WHERE lower(a.name)=lower($1)
        OR EXISTS (SELECT 1 FROM ingest.artist_aliases x WHERE x.artist_id=a.id AND lower(x.alias)=lower($1))
     ORDER BY a.id LIMIT 1`, [artistName])).rows[0];
  if (!artist) { result.skippedReason = "el artista no existe en el catálogo"; return result; }
  result.artistId = Number(artist.id); result.artist = artist.name;

  const albums = (await pool.query<{ id: string; title: string; release_year: number | null }>(`
    SELECT a.id::text, a.title, a.release_year FROM public.albums a
     WHERE a.artist_id=$1 AND NOT EXISTS (SELECT 1 FROM media.video_albums va WHERE va.album_id=a.id)
     ORDER BY a.id`, [result.artistId])).rows.map((row) => ({ albumId: Number(row.id), title: row.title, year: row.release_year }));
  result.albumsWithoutVideo = albums.length;
  if (albums.length === 0) { result.skippedReason = "todos sus discos ya tienen video"; return result; }

  result.quotaUsedToday = await youtubeQuotaUsedToday();
  if (result.quotaUsedToday + QUOTA_COST.search + QUOTA_COST.videos > result.quotaBudget) {
    result.skippedReason = `presupuesto de cuota agotado hoy (${result.quotaUsedToday}/${result.quotaBudget} unidades)`;
    return result;
  }
  const channelId = options.channelId
    ?? (await pool.query<{ channel_id: string }>("SELECT channel_id FROM media.youtube_channels ORDER BY id LIMIT 1")).rows[0]?.channel_id;
  if (!channelId) { result.skippedReason = "no hay canal registrado; ejecute youtube discover-channel"; return result; }
  if (dryRun) { result.skippedReason = `dry-run: buscaría «${artist.name}» en ${channelId} (${QUOTA_COST.search} unidades)`; return result; }

  const run = await pool.query<{ id: string }>(`
    INSERT INTO ingest.scrape_runs(kind, source_id, status, params)
    VALUES ('enrich_artist', (SELECT id FROM ingest.sources WHERE slug='youtube-data-api'), 'running', $1::jsonb) RETURNING id::text`,
  [JSON.stringify({ artist: artist.name, artistId: result.artistId, channelId, maxResults: options.maxResults ?? 10 })]);
  result.runId = Number(run.rows[0]!.id);
  const api = options.api ?? new YouTubeDataApi();
  try {
    const found = await api.searchChannelVideos(channelId, artist.name, options.maxResults ?? 10);
    result.searched = true; result.quotaSpent += QUOTA_COST.search;
    const ids = [...new Set((found.items ?? []).map((item: YouTubeSearchItem) => item.id?.videoId).filter((id): id is string => typeof id === "string"))];
    result.found = ids.length;
    const known = new Set((await pool.query<{ video_id: string }>(
      "SELECT video_id FROM media.youtube_videos WHERE video_id = ANY($1::text[]) AND last_fetched_at IS NOT NULL", [ids])).rows.map((row) => row.video_id));
    const pending = ids.filter((id) => !known.has(id));
    if (pending.length) {
      const hydration = await hydrateYouTubeVideos(pending, { api });
      result.hydrated = hydration.hydrated; result.quotaSpent += hydration.batches * QUOTA_COST.videos;
    }
    const videos = (await pool.query<{ video_id: string; title: string | null }>(
      "SELECT video_id, title FROM media.youtube_videos WHERE video_id = ANY($1::text[]) AND channel_id=$2", [ids, channelId]))
      .rows.filter((row) => row.title).map((row) => ({ videoId: row.video_id, title: row.title! }));
    result.matches = matchEnrichmentCandidates(artist.name, albums, videos);

    const byAlbum = new Map<number, EnrichmentMatch[]>();
    for (const match of result.matches) byAlbum.set(match.albumId, [...(byAlbum.get(match.albumId) ?? []), match]);
    for (const [albumId, candidates] of byAlbum) {
      const inserted = await pool.query(`
        INSERT INTO ingest.review_queue(kind, priority, album_id, payload, notes)
        SELECT 'youtube_match', 4, $1, $2::jsonb, $3
         WHERE NOT EXISTS (SELECT 1 FROM ingest.review_queue WHERE kind='youtube_match' AND status IN ('open','in_progress') AND payload->>'albumId'=$4)`,
      [albumId, JSON.stringify({ albumId, artist: artist.name, album: candidates[0]!.album, candidates, via: "yt:enrich-artist", runId: result.runId }),
        candidates.length === 1
          ? "Búsqueda dirigida en el canal: un video coincide en artista y título; confirmar con yt:link --album --video --confirm"
          : "Búsqueda dirigida en el canal: varios videos coinciden; requiere selección humana",
        String(albumId)]);
      result.reviewsCreated += inserted.rowCount ?? 0;
    }
    await pool.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1",
      [result.runId, JSON.stringify({ quotaSpent: result.quotaSpent, found: result.found, hydrated: result.hydrated, matches: result.matches.length, reviewsCreated: result.reviewsCreated })]);
    return result;
  } catch (error) {
    await pool.query("UPDATE ingest.scrape_runs SET status='failed', finished_at=now(), counters=$2::jsonb, error_log=$3 WHERE id=$1",
      [result.runId, JSON.stringify({ quotaSpent: result.quotaSpent }), String(error)]);
    throw error;
  }
}
