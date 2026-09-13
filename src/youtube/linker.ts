import { getPool } from "../db/client.js";

/** A proposed or applied video-to-album relation. */
export interface YouTubeAlbumLink {
  albumId: number;
  artist: string;
  album: string;
  videoId: string;
  videoTitle: string | null;
  score: number;
}

export interface YouTubeLinkResult {
  dryRun: boolean;
  albums: number;
  linked: YouTubeAlbumLink[];
  ambiguous: Array<{ albumId: number; artist: string; album: string; candidates: YouTubeAlbumLink[] }>;
  unmatched: Array<{ albumId: number; artist: string; album: string }>;
  reviewsCreated: number;
}

/**
 * Comparison key for a release identity.  It deliberately keeps numbers and
 * letters only, so e.g. `D'Art`, `D Art` and `d-art` compare consistently,
 * without weakening an artist/title match into a token match.
 */
export function youtubeLinkKey(value: string): string {
  return value.normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

interface AlbumRow { album_id: string; artist: string; album: string; }
interface CandidateRow extends AlbumRow { video_db_id: string; video_id: string; video_title: string | null; seed_artist: string; seed_album: string; }

/**
 * Finds the unambiguous releases already evidenced by the imported master
 * sheet.  This command does not use a loose title search: a false primary
 * link is materially worse than an open review.
 */
export async function linkYouTubeAlbums(options: { dryRun?: boolean } = {}): Promise<YouTubeLinkResult> {
  const dryRun = options.dryRun ?? false;
  const pool = getPool();
  const { rows: albums } = await pool.query<AlbumRow>(`
    SELECT a.id::text AS album_id, ar.name AS artist, a.title AS album
      FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id
     WHERE NOT EXISTS (
       SELECT 1 FROM media.video_albums va
        WHERE va.album_id=a.id AND va.is_primary_link
     )
     ORDER BY a.id`);
  const { rows: candidates } = await pool.query<CandidateRow>(`
    SELECT a.id::text AS album_id, ar.name AS artist, a.title AS album,
           v.id::text AS video_db_id, v.video_id, v.title AS video_title,
           s.artist_name_raw AS seed_artist, s.album_name_raw AS seed_album
      FROM public.albums a
      JOIN public.artists ar ON ar.id=a.artist_id
      JOIN ingest.seed_uploads s ON s.content_kind='release'
      JOIN media.youtube_videos v ON v.seed_upload_id=s.id
     WHERE NOT EXISTS (
       SELECT 1 FROM media.video_albums va
        WHERE va.album_id=a.id AND va.is_primary_link
     )`);

  const byAlbum = new Map<number, YouTubeAlbumLink[]>();
  for (const row of candidates) {
    if (youtubeLinkKey(row.artist) !== youtubeLinkKey(row.seed_artist)
      || youtubeLinkKey(row.album) !== youtubeLinkKey(row.seed_album)) continue;
    const item: YouTubeAlbumLink = {
      albumId: Number(row.album_id), artist: row.artist, album: row.album,
      videoId: row.video_id, videoTitle: row.video_title, score: 1,
    };
    const list = byAlbum.get(item.albumId) ?? [];
    list.push(item); byAlbum.set(item.albumId, list);
  }

  const result: YouTubeLinkResult = {
    dryRun, albums: albums.length, linked: [], ambiguous: [], unmatched: [], reviewsCreated: 0,
  };
  for (const album of albums) {
    const albumId = Number(album.album_id);
    const matches = byAlbum.get(albumId) ?? [];
    if (matches.length === 1) result.linked.push(matches[0]!);
    else if (matches.length > 1) result.ambiguous.push({ albumId, artist: album.artist, album: album.album, candidates: matches });
    else result.unmatched.push({ albumId, artist: album.artist, album: album.album });
  }
  if (dryRun) return result;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const source = await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug='yt-master-seed'");
    const sourceId = source.rows[0] ? Number(source.rows[0].id) : null;
    if (!sourceId) throw new Error("falta la fuente yt-master-seed; ejecute primero youtube import-sheet");
    for (const link of result.linked) {
      await client.query(`
        INSERT INTO media.video_albums(video_id,album_id,album_kind,is_primary_link,confidence,source_id)
        SELECT v.id,$2,'full_album',true,'high',$3
          FROM media.youtube_videos v WHERE v.video_id=$1
        ON CONFLICT(video_id,album_id) DO UPDATE SET
          album_kind='full_album',is_primary_link=true,confidence='high',source_id=EXCLUDED.source_id`,
      [link.videoId, link.albumId, sourceId]);
    }
    // A review makes the absence/ambiguity visible and deduplicates on the
    // album, rather than silently creating a potentially wrong relation.
    // A dismissed one stays dismissed: "this album is not on the channel" is
    // an owner decision (2026-09-13), not something to ask again every run.
    for (const item of [...result.unmatched, ...result.ambiguous]) {
      const inserted = await client.query(`
        INSERT INTO ingest.review_queue(kind,priority,payload,notes)
        SELECT 'youtube_match',4,$1::jsonb,$2
         WHERE NOT EXISTS (
           SELECT 1 FROM ingest.review_queue
            WHERE kind='youtube_match' AND status IN ('open','in_progress','dismissed')
              AND payload->>'albumId'=$3)
      `, [JSON.stringify({ albumId: item.albumId, artist: item.artist, album: item.album, candidates: "candidates" in item ? item.candidates : [] }),
        "No hay un único video de álbum confirmado; requiere selección humana", String(item.albumId)]);
      result.reviewsCreated += inserted.rowCount ?? 0;
    }
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

/** Explicit, auditable confirmation for a video selected outside the seed. */
export async function confirmYouTubeAlbumLink(albumId: number, videoId: string, note: string): Promise<YouTubeAlbumLink> {
  if (!Number.isSafeInteger(albumId) || albumId <= 0) throw new Error("album-id inválido");
  if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) throw new Error("video-id de YouTube inválido");
  if (!note.trim()) throw new Error("--note es obligatorio al confirmar un enlace manual");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const found = await client.query<{ artist: string; album: string; video_title: string | null }>(`
      SELECT ar.name AS artist,a.title AS album,v.title AS video_title
        FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id
        JOIN media.youtube_videos v ON v.video_id=$2 WHERE a.id=$1 FOR UPDATE`, [albumId, videoId]);
    const row = found.rows[0];
    if (!row) throw new Error("el álbum o el video no existe localmente; sincronice el video antes de enlazarlo");
    const source = await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug='youtube-data-api'");
    if (!source.rows[0]) throw new Error("falta la fuente youtube-data-api");
    await client.query("UPDATE media.video_albums SET is_primary_link=false WHERE album_id=$1 AND is_primary_link", [albumId]);
    await client.query(`
      INSERT INTO media.video_albums(video_id,album_id,album_kind,is_primary_link,confidence,source_id)
      SELECT id,$2,'full_album',true,'high',$3 FROM media.youtube_videos WHERE video_id=$1
      ON CONFLICT(video_id,album_id) DO UPDATE SET album_kind='full_album',is_primary_link=true,confidence='high',source_id=EXCLUDED.source_id`,
    [videoId, albumId, Number(source.rows[0].id)]);
    await client.query(`
      INSERT INTO ingest.merge_audit(entity_kind,album_id,field,old_value,new_value,reason,confidence,performed_by)
      VALUES('album',$1,'youtube_primary_link',NULL,$2::jsonb,$3,'high','human')`,
    [albumId, JSON.stringify({ videoId, note }), note]);
    await client.query("COMMIT");
    return { albumId, artist: row.artist, album: row.album, videoId, videoTitle: row.video_title, score: 1 };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
