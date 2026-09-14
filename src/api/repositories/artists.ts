// CRV · Consultas de lectura para artistas (PHASES §E7A). SQL parametrizado
// directo (mismo estilo que src/er/repository.ts): agregaciones jsonb para
// devolver la ficha completa en una sola consulta.
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";

export interface ArtistListRow {
  id: number;
  name: string;
  artistType: string;
  originCity: string | null;
  originCountry: string;
  formedYear: number | null;
  disbandedYear: number | null;
  pictureUrl: string | null;
}

export async function listArtists(
  query: PaginationQuery & { q?: string | undefined },
): Promise<{ rows: ArtistListRow[]; total: number }> {
  const pattern = query.q ? `%${query.q}%` : null;
  const [rows, count] = await Promise.all([
    getPool().query<{
      id: string; name: string; artist_type: string; origin_city: string | null;
      origin_country: string; formed_year: number | null; disbanded_year: number | null;
      picture_url: string | null;
    }>(
      `SELECT id, name, artist_type, origin_city, origin_country, formed_year, disbanded_year, picture_url
         FROM public.artists
        WHERE $1::text IS NULL OR name ILIKE $1
        ORDER BY name
        LIMIT $2 OFFSET $3`,
      [pattern, query.limit, query.offset],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM public.artists WHERE $1::text IS NULL OR name ILIKE $1`,
      [pattern],
    ),
  ]);
  return {
    rows: rows.rows.map((row) => ({
      id: Number(row.id),
      name: row.name,
      artistType: row.artist_type,
      originCity: row.origin_city,
      originCountry: row.origin_country,
      formedYear: row.formed_year,
      disbandedYear: row.disbanded_year,
      pictureUrl: row.picture_url,
    })),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export interface ArtistDetail {
  id: number;
  name: string;
  artistType: string;
  biography: string | null;
  pictureUrl: string | null;
  originCity: string | null;
  originCountry: string;
  formedYear: number | null;
  disbandedYear: number | null;
  notes: string | null;
  members: Array<{ id: number; personId: number; personName: string; role: string; fromYear: number | null; toYear: number | null; isCurrent: boolean }>;
  discography: Array<{ albumId: number; title: string; releaseYear: number | null; albumType: string; coverUrl: string | null }>;
  aliases: Array<{ id: number; alias: string; aliasType: string; isPrimary: boolean }>;
}

export async function getArtistDetail(id: number): Promise<ArtistDetail | null> {
  const { rows } = await getPool().query<Record<string, unknown>>(
    `SELECT a.id, a.name, a.artist_type, a.biography, a.picture_url, a.origin_city,
            a.origin_country, a.formed_year, a.disbanded_year, a.notes,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'id', am.id, 'personId', p.id, 'personName', p.name, 'role', am.role,
           'fromYear', am.from_year, 'toYear', am.to_year, 'isCurrent', am.is_current
         ) ORDER BY am.from_year NULLS LAST, p.name)
         FROM public.artist_members am JOIN public.persons p ON p.id = am.person_id
         WHERE am.artist_id = a.id
       ), '[]'::jsonb) AS members,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object(
           'albumId', al.id, 'title', al.title, 'releaseYear', al.release_year,
           'albumType', al.album_type, 'coverUrl', al.cover_url
         ) ORDER BY al.release_year NULLS LAST, al.title)
         FROM public.albums al WHERE al.artist_id = a.id
       ), '[]'::jsonb) AS discography,
       COALESCE((
         SELECT jsonb_agg(jsonb_build_object('id', x.id, 'alias', x.alias, 'aliasType', x.alias_type, 'isPrimary', x.is_primary))
         FROM ingest.artist_aliases x WHERE x.artist_id = a.id
       ), '[]'::jsonb) AS aliases
     FROM public.artists a
     WHERE a.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row["id"]),
    name: row["name"] as string,
    artistType: row["artist_type"] as string,
    biography: row["biography"] as string | null,
    pictureUrl: row["picture_url"] as string | null,
    originCity: row["origin_city"] as string | null,
    originCountry: row["origin_country"] as string,
    formedYear: row["formed_year"] as number | null,
    disbandedYear: row["disbanded_year"] as number | null,
    notes: row["notes"] as string | null,
    members: row["members"] as ArtistDetail["members"],
    discography: row["discography"] as ArtistDetail["discography"],
    aliases: row["aliases"] as ArtistDetail["aliases"],
  };
}
