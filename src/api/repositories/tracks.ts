// CRV · Lectura de pistas (auditoría del sistema, hallazgo de CRUD #7).
//
// El CRUD de pistas era asimétrico: se creaban, corregían, borraban y hasta
// tenían alias por API, pero no había forma de leerlas — la interfaz siempre
// navegaba al disco. El listado filtra por disco o por texto (título y alias,
// ILIKE simple: la base es SQL_ASCII y no sabe plegar tildes) y la ficha
// agrega lo que la vista del disco no muestra: alias propios, créditos y el
// contexto de álbum/artista.
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";

export interface TrackListItem {
  id: number;
  title: string;
  albumId: number;
  albumTitle: string;
  artistId: number;
  artistName: string;
  discNumber: number;
  trackNumber: number;
  durationSeconds: number | null;
  creditCount: number;
}

export interface TrackCreditRow {
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

export interface TrackAliasRow {
  id: number;
  alias: string;
  aliasType: string;
  isPrimary: boolean;
}

export interface TrackDetail extends TrackListItem {
  youtubeStartSeconds: number | null;
  notes: string | null;
  aliases: TrackAliasRow[];
  credits: TrackCreditRow[];
}

const LIST_COLUMNS = `t.id, t.title, t.album_id, a.title AS album_title, a.artist_id, ar.name AS artist_name,
       t.disc_number, t.track_number, t.duration_seconds,
       (SELECT count(*)::int FROM public.track_credits tc WHERE tc.track_id = t.id) AS credit_count`;

const LIST_FROM = `FROM public.tracks t
       JOIN public.albums a ON a.id = t.album_id
       JOIN public.artists ar ON ar.id = a.artist_id`;

interface ListRow {
  id: string; title: string; album_id: string; album_title: string; artist_id: string; artist_name: string;
  disc_number: number; track_number: number; duration_seconds: number | null; credit_count: number;
}

function toListItem(row: ListRow): TrackListItem {
  return {
    id: Number(row.id), title: row.title, albumId: Number(row.album_id), albumTitle: row.album_title,
    artistId: Number(row.artist_id), artistName: row.artist_name, discNumber: row.disc_number,
    trackNumber: row.track_number, durationSeconds: row.duration_seconds, creditCount: row.credit_count,
  };
}

export async function listTracks(
  query: PaginationQuery & { q?: string | undefined; albumId?: number | undefined },
): Promise<{ rows: TrackListItem[]; total: number }> {
  const pattern = query.q ? `%${query.q}%` : null;
  const albumId = query.albumId ?? null;
  const [rows, count] = await Promise.all([
    getPool().query<ListRow>(
      `SELECT ${LIST_COLUMNS} ${LIST_FROM}
        WHERE ($1::text IS NULL OR t.title ILIKE $1 OR EXISTS (
                SELECT 1 FROM ingest.track_aliases ta WHERE ta.track_id = t.id AND ta.alias ILIKE $1))
          AND ($4::bigint IS NULL OR t.album_id = $4)
        ORDER BY a.title, t.disc_number, t.track_number, t.id
        LIMIT $2 OFFSET $3`,
      [pattern, query.limit, query.offset, albumId],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count ${LIST_FROM}
        WHERE ($1::text IS NULL OR t.title ILIKE $1 OR EXISTS (
                SELECT 1 FROM ingest.track_aliases ta WHERE ta.track_id = t.id AND ta.alias ILIKE $1))
          AND ($2::bigint IS NULL OR t.album_id = $2)`,
      [pattern, albumId],
    ),
  ]);
  return { rows: rows.rows.map(toListItem), total: Number(count.rows[0]?.count ?? 0) };
}

interface DetailRow extends ListRow {
  youtube_start_seconds: number | null;
  notes: string | null;
  aliases: TrackAliasRow[];
  credits: TrackCreditRow[];
}

export async function getTrackDetail(id: number): Promise<TrackDetail | null> {
  const rows = await getPool().query<DetailRow>(
    `SELECT ${LIST_COLUMNS}, t.youtube_start_seconds, t.notes,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object('id', x.id, 'alias', x.alias, 'aliasType', x.alias_type, 'isPrimary', x.is_primary) ORDER BY x.id)
                FROM ingest.track_aliases x WHERE x.track_id = t.id
            ), '[]'::jsonb) AS aliases,
            COALESCE((
              SELECT jsonb_agg(jsonb_build_object(
                       'id', tc.id, 'creditType', tc.credit_type, 'role', tc.role,
                       'personId', tc.person_id, 'personName', pe.name,
                       'artistId', tc.artist_id, 'artistName', cr.name,
                       'organizationId', tc.organization_id, 'organizationName', og.name) ORDER BY tc.id)
                FROM public.track_credits tc
                LEFT JOIN public.persons pe ON pe.id = tc.person_id
                LEFT JOIN public.artists cr ON cr.id = tc.artist_id
                LEFT JOIN public.organizations og ON og.id = tc.organization_id
               WHERE tc.track_id = t.id
            ), '[]'::jsonb) AS credits
       ${LIST_FROM}
      WHERE t.id = $1`,
    [id],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return {
    ...toListItem(row),
    youtubeStartSeconds: row.youtube_start_seconds,
    notes: row.notes,
    aliases: row.aliases,
    credits: row.credits,
  };
}
