// CRV · Lectura de videos de YouTube y sus enlaces (PHASES §E7A: "lectura
// de... videos y enlaces").
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";

export interface VideoListRow {
  id: number;
  videoId: string;
  title: string | null;
  channelTitle: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  publicationStatus: string;
}

export async function listVideos(
  query: PaginationQuery & { q?: string | undefined },
): Promise<{ rows: VideoListRow[]; total: number }> {
  const pattern = query.q ? `%${query.q}%` : null;
  const [rows, count] = await Promise.all([
    getPool().query<{
      id: string; video_id: string; title: string | null; channel_title: string | null;
      published_at: string | null; duration_seconds: number | null; publication_status: string;
    }>(
      `SELECT id, video_id, title, channel_title, published_at::text AS published_at, duration_seconds, publication_status
         FROM media.youtube_videos
        WHERE $1::text IS NULL OR title ILIKE $1
        ORDER BY published_at DESC NULLS LAST
        LIMIT $2 OFFSET $3`,
      [pattern, query.limit, query.offset],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM media.youtube_videos WHERE $1::text IS NULL OR title ILIKE $1`,
      [pattern],
    ),
  ]);
  return {
    rows: rows.rows.map((row) => ({
      id: Number(row.id), videoId: row.video_id, title: row.title, channelTitle: row.channel_title,
      publishedAt: row.published_at, durationSeconds: row.duration_seconds, publicationStatus: row.publication_status,
    })),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export interface VideoDetail {
  id: number;
  videoId: string;
  url: string | null;
  title: string | null;
  description: string | null;
  channelId: string | null;
  channelTitle: string | null;
  publishedAt: string | null;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  publicationStatus: string;
  artists: Array<{ artistId: number; artistName: string; relationKind: string; confidence: string }>;
  albums: Array<{ albumId: number; title: string; albumKind: string; isPrimaryLink: boolean; confidence: string }>;
  tracks: Array<{ trackId: number; title: string; albumId: number; albumTitle: string; startSeconds: number; endSeconds: number | null; confidence: string }>;
}

export async function getVideoDetail(id: number): Promise<VideoDetail | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT v.id, v.video_id, v.url, v.title, v.description, v.channel_id, v.channel_title,
            v.published_at::text AS published_at, v.duration_seconds, v.thumbnail_url, v.publication_status,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'artistId', ar.id, 'artistName', ar.name, 'relationKind', va.relation_kind, 'confidence', va.confidence
         ))
         FROM media.video_artists va JOIN public.artists ar ON ar.id = va.artist_id
         WHERE va.video_id = v.id
       ), '[]'::jsonb) AS artists,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'albumId', al.id, 'title', al.title, 'albumKind', vab.album_kind,
           'isPrimaryLink', vab.is_primary_link, 'confidence', vab.confidence
         ))
         FROM media.video_albums vab JOIN public.albums al ON al.id = vab.album_id
         WHERE vab.video_id = v.id
       ), '[]'::jsonb) AS albums,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'trackId', t.id, 'title', t.title, 'albumId', al2.id, 'albumTitle', al2.title,
           'startSeconds', vt.start_seconds, 'endSeconds', vt.end_seconds, 'confidence', vt.confidence
         ) ORDER BY vt.start_seconds)
         FROM media.video_tracks vt
         JOIN public.tracks t ON t.id = vt.track_id
         JOIN public.albums al2 ON al2.id = t.album_id
         WHERE vt.video_id = v.id
       ), '[]'::jsonb) AS tracks
     FROM media.youtube_videos v
     WHERE v.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row["id"]),
    videoId: row["video_id"] as string,
    url: row["url"] as string | null,
    title: row["title"] as string | null,
    description: row["description"] as string | null,
    channelId: row["channel_id"] as string | null,
    channelTitle: row["channel_title"] as string | null,
    publishedAt: row["published_at"] as string | null,
    durationSeconds: row["duration_seconds"] as number | null,
    thumbnailUrl: row["thumbnail_url"] as string | null,
    publicationStatus: row["publication_status"] as string,
    artists: row["artists"] as VideoDetail["artists"],
    albums: row["albums"] as VideoDetail["albums"],
    tracks: row["tracks"] as VideoDetail["tracks"],
  };
}
