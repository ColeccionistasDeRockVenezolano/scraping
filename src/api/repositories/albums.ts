// CRV · Consultas de lectura para discos (PHASES §E7A: "ALBUM DETAIL... una
// de las páginas más importantes"). La ficha agregada trae tracklist,
// créditos (planos y agrupados por credit_type), formatos, alias y enlaces
// de YouTube en una sola consulta.
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";

export interface AlbumListRow {
  id: number;
  title: string;
  releaseYear: number | null;
  albumType: string;
  artistId: number;
  artistName: string;
  coverUrl: string | null;
}

export async function listAlbums(
  query: PaginationQuery & { q?: string | undefined; artistId?: number | undefined },
): Promise<{ rows: AlbumListRow[]; total: number }> {
  const pattern = query.q ? `%${query.q}%` : null;
  const artistId = query.artistId ?? null;
  const [rows, count] = await Promise.all([
    getPool().query<{
      id: string; title: string; release_year: number | null; album_type: string;
      artist_id: string; artist_name: string; cover_url: string | null;
    }>(
      `SELECT al.id, al.title, al.release_year, al.album_type, ar.id AS artist_id, ar.name AS artist_name, al.cover_url
         FROM public.albums al
         JOIN public.artists ar ON ar.id = al.artist_id
        WHERE ($1::text IS NULL OR al.title ILIKE $1)
          AND ($4::bigint IS NULL OR al.artist_id = $4)
        ORDER BY al.title
        LIMIT $2 OFFSET $3`,
      [pattern, query.limit, query.offset, artistId],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM public.albums al
        WHERE ($1::text IS NULL OR al.title ILIKE $1)
          AND ($2::bigint IS NULL OR al.artist_id = $2)`,
      [pattern, artistId],
    ),
  ]);
  return {
    rows: rows.rows.map((row) => ({
      id: Number(row.id), title: row.title, releaseYear: row.release_year, albumType: row.album_type,
      artistId: Number(row.artist_id), artistName: row.artist_name, coverUrl: row.cover_url,
    })),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export interface AlbumCreditRow {
  id: number;
  creditType: string;
  role: string;
  personId: number | null;
  personName: string | null;
  artistId: number | null;
  artistName: string | null;
  organizationId: number | null;
  organizationName: string | null;
}

export interface AlbumTrackRow {
  id: number;
  discNumber: number;
  trackNumber: number;
  title: string;
  durationSeconds: number | null;
  youtubeStartSeconds: number | null;
  credits: AlbumCreditRow[];
}

export interface AlbumDetail {
  id: number;
  title: string;
  releaseYear: number | null;
  albumType: string;
  genre: string | null;
  coverUrl: string | null;
  description: string | null;
  notes: string | null;
  youtubeUrl: string | null;
  youtubeStatus: string;
  instagramUrl: string | null;
  instagramStatus: string;
  wordpressUrl: string | null;
  wordpressStatus: string;
  artist: { id: number; name: string };
  label: { id: number; name: string } | null;
  tracklist: AlbumTrackRow[];
  credits: AlbumCreditRow[];
  creditsByType: Record<string, AlbumCreditRow[]>;
  formats: Array<{ id: number; format: string; quality: string | null; archiveStatus: string }>;
  aliases: Array<{ id: number; alias: string; aliasType: string; isPrimary: boolean }>;
  youtubeLinks: Array<{ videoId: string; title: string | null; kind: string; isPrimaryLink: boolean }>;
}

const CREDIT_FIELDS = `jsonb_build_object(
    'id', id, 'creditType', credit_type, 'role', role,
    'personId', person_id, 'personName', person_name,
    'artistId', artist_id, 'artistName', artist_name,
    'organizationId', organization_id, 'organizationName', organization_name
  )`;

export async function getAlbumDetail(id: number): Promise<AlbumDetail | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT al.id, al.title, al.release_year, al.album_type, al.genre, al.cover_url,
            al.description, al.notes, al.youtube_url, al.youtube_status,
            al.instagram_url, al.instagram_status, al.wordpress_url, al.wordpress_status,
            ar.id AS artist_id, ar.name AS artist_name,
            lbl.id AS label_id, lbl.name AS label_name,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', t.id, 'discNumber', t.disc_number, 'trackNumber', t.track_number,
           'title', t.title, 'durationSeconds', t.duration_seconds,
           'youtubeStartSeconds', t.youtube_start_seconds,
           'credits', COALESCE((
             SELECT jsonb_agg(${CREDIT_FIELDS})
             FROM (
               SELECT tc.id, tc.credit_type, tc.role, tc.person_id, tcp.name AS person_name,
                      tc.artist_id, tca.name AS artist_name, tc.organization_id, tco.name AS organization_name
                 FROM public.track_credits tc
                 LEFT JOIN public.persons tcp ON tcp.id = tc.person_id
                 LEFT JOIN public.artists tca ON tca.id = tc.artist_id
                 LEFT JOIN public.organizations tco ON tco.id = tc.organization_id
                WHERE tc.track_id = t.id
             ) credit_rows
           ), '[]'::jsonb)
         ) ORDER BY t.disc_number, t.track_number)
         FROM public.tracks t WHERE t.album_id = al.id
       ), '[]'::jsonb) AS tracklist,
       COALESCE((
         SELECT jsonb_agg(${CREDIT_FIELDS})
         FROM (
           SELECT ac.id, ac.credit_type, ac.role, ac.person_id, acp.name AS person_name,
                  ac.artist_id, aca.name AS artist_name, ac.organization_id, aco.name AS organization_name
             FROM public.album_credits ac
             LEFT JOIN public.persons acp ON acp.id = ac.person_id
             LEFT JOIN public.artists aca ON aca.id = ac.artist_id
             LEFT JOIN public.organizations aco ON aco.id = ac.organization_id
            WHERE ac.album_id = al.id
         ) credit_rows
       ), '[]'::jsonb) AS credits,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object('id', f.id, 'format', f.format, 'quality', f.quality, 'archiveStatus', f.archive_status))
         FROM public.album_formats f WHERE f.album_id = al.id
       ), '[]'::jsonb) AS formats,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object('id', x.id, 'alias', x.alias, 'aliasType', x.alias_type, 'isPrimary', x.is_primary))
         FROM ingest.album_aliases x WHERE x.album_id = al.id
       ), '[]'::jsonb) AS aliases,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'videoId', v.video_id, 'title', v.title, 'kind', va.album_kind, 'isPrimaryLink', va.is_primary_link
         ) ORDER BY va.is_primary_link DESC, v.published_at)
         FROM media.video_albums va JOIN media.youtube_videos v ON v.id = va.video_id
         WHERE va.album_id = al.id
       ), '[]'::jsonb) AS youtube_links
     FROM public.albums al
     JOIN public.artists ar ON ar.id = al.artist_id
     LEFT JOIN public.organizations lbl ON lbl.id = al.label_id
     WHERE al.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const credits = row["credits"] as AlbumCreditRow[];
  const creditsByType: Record<string, AlbumCreditRow[]> = {};
  for (const credit of credits) {
    (creditsByType[credit.creditType] ??= []).push(credit);
  }
  return {
    id: Number(row["id"]),
    title: row["title"] as string,
    releaseYear: row["release_year"] as number | null,
    albumType: row["album_type"] as string,
    genre: row["genre"] as string | null,
    coverUrl: row["cover_url"] as string | null,
    description: row["description"] as string | null,
    notes: row["notes"] as string | null,
    youtubeUrl: row["youtube_url"] as string | null,
    youtubeStatus: row["youtube_status"] as string,
    instagramUrl: row["instagram_url"] as string | null,
    instagramStatus: row["instagram_status"] as string,
    wordpressUrl: row["wordpress_url"] as string | null,
    wordpressStatus: row["wordpress_status"] as string,
    artist: { id: Number(row["artist_id"]), name: row["artist_name"] as string },
    label: row["label_id"] != null ? { id: Number(row["label_id"]), name: row["label_name"] as string } : null,
    tracklist: row["tracklist"] as AlbumTrackRow[],
    credits,
    creditsByType,
    formats: row["formats"] as AlbumDetail["formats"],
    aliases: row["aliases"] as AlbumDetail["aliases"],
    youtubeLinks: row["youtube_links"] as AlbumDetail["youtubeLinks"],
  };
}
