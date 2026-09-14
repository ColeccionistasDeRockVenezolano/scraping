// CRV · Búsqueda global (PHASES §E7A: "búsqueda global... los alias
// participan"). Una consulta por tipo de entidad; el nombre/título propio
// o cualquiera de sus alias (ingest.*_aliases) puede matchear.
import { getPool } from "../../db/client.js";
import { ALL_SEARCH_TYPES, type SearchEntityType } from "../schemas.js";

export interface SearchHit {
  type: SearchEntityType;
  id: number;
  label: string;
  context: string | null;
  /** Solo `track`: el disco al que pertenece (no tiene ficha propia; se navega al álbum). */
  albumId: number | null;
}

async function searchArtists(pattern: string, limit: number): Promise<SearchHit[]> {
  const { rows } = await getPool().query<{ id: string; name: string; origin_city: string | null }>(
    `SELECT a.id, a.name, a.origin_city
       FROM public.artists a
      WHERE a.name ILIKE $1
         OR EXISTS (SELECT 1 FROM ingest.artist_aliases x WHERE x.artist_id = a.id AND x.alias ILIKE $1)
      ORDER BY a.name
      LIMIT $2`,
    [pattern, limit],
  );
  return rows.map((row) => ({ type: "artist", id: Number(row.id), label: row.name, context: row.origin_city, albumId: null }));
}

async function searchPersons(pattern: string, limit: number): Promise<SearchHit[]> {
  const { rows } = await getPool().query<{ id: string; name: string; nationality: string | null }>(
    `SELECT p.id, p.name, p.nationality
       FROM public.persons p
      WHERE p.name ILIKE $1
         OR EXISTS (SELECT 1 FROM ingest.person_aliases x WHERE x.person_id = p.id AND x.alias ILIKE $1)
      ORDER BY p.name
      LIMIT $2`,
    [pattern, limit],
  );
  return rows.map((row) => ({ type: "person", id: Number(row.id), label: row.name, context: row.nationality, albumId: null }));
}

async function searchAlbums(pattern: string, limit: number): Promise<SearchHit[]> {
  const { rows } = await getPool().query<{ id: string; title: string; artist_name: string }>(
    `SELECT al.id, al.title, ar.name AS artist_name
       FROM public.albums al
       JOIN public.artists ar ON ar.id = al.artist_id
      WHERE al.title ILIKE $1
         OR EXISTS (SELECT 1 FROM ingest.album_aliases x WHERE x.album_id = al.id AND x.alias ILIKE $1)
      ORDER BY al.title
      LIMIT $2`,
    [pattern, limit],
  );
  return rows.map((row) => ({ type: "album", id: Number(row.id), label: row.title, context: row.artist_name, albumId: null }));
}

async function searchTracks(pattern: string, limit: number): Promise<SearchHit[]> {
  const { rows } = await getPool().query<{ id: string; title: string; album_id: string; album_title: string; artist_name: string }>(
    `SELECT t.id, t.title, al.id AS album_id, al.title AS album_title, ar.name AS artist_name
       FROM public.tracks t
       JOIN public.albums al ON al.id = t.album_id
       JOIN public.artists ar ON ar.id = al.artist_id
      WHERE t.title ILIKE $1
         OR EXISTS (SELECT 1 FROM ingest.track_aliases x WHERE x.track_id = t.id AND x.alias ILIKE $1)
      ORDER BY t.title
      LIMIT $2`,
    [pattern, limit],
  );
  return rows.map((row) => ({
    type: "track", id: Number(row.id), label: row.title, context: `${row.artist_name} · ${row.album_title}`,
    albumId: Number(row.album_id),
  }));
}

async function searchOrganizations(pattern: string, limit: number): Promise<SearchHit[]> {
  const { rows } = await getPool().query<{ id: string; name: string; organization_type: string }>(
    `SELECT o.id, o.name, o.organization_type
       FROM public.organizations o
      WHERE o.name ILIKE $1
         OR EXISTS (SELECT 1 FROM ingest.organization_aliases x WHERE x.organization_id = o.id AND x.alias ILIKE $1)
      ORDER BY o.name
      LIMIT $2`,
    [pattern, limit],
  );
  return rows.map((row) => ({ type: "organization", id: Number(row.id), label: row.name, context: row.organization_type, albumId: null }));
}

const SEARCHERS: Record<SearchEntityType, (pattern: string, limit: number) => Promise<SearchHit[]>> = {
  artist: searchArtists,
  person: searchPersons,
  album: searchAlbums,
  track: searchTracks,
  organization: searchOrganizations,
};

export async function globalSearch(
  q: string, limit: number, types: readonly SearchEntityType[] = ALL_SEARCH_TYPES,
): Promise<Record<SearchEntityType, SearchHit[]>> {
  const pattern = `%${q}%`;
  const entries = await Promise.all(types.map(async (type) => [type, await SEARCHERS[type](pattern, limit)] as const));
  const result = {} as Record<SearchEntityType, SearchHit[]>;
  for (const [type, hits] of entries) result[type] = hits;
  for (const type of ALL_SEARCH_TYPES) result[type] ??= [];
  return result;
}
