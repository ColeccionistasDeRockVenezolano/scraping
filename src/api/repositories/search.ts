// CRV · Búsqueda global (PHASES §E7A: "búsqueda global... los alias
// participan"). Una consulta por tipo de entidad; el nombre/título propio
// o cualquiera de sus alias (ingest.*_aliases) puede matchear.
//
// Personas, artistas y organizaciones buscan con el índice en memoria
// (E11.9): la base es SQL_ASCII y `ILIKE '%jose%'` no encuentra «José».
// Álbumes y pistas siguen con ILIKE a propósito: el índice es de nombres de
// entidad, y su normalización (tildes, artículos, apodos) no aplica a títulos.
import { getPool } from "../../db/client.js";
import { ALL_SEARCH_TYPES, type SearchEntityType } from "../schemas.js";
import { searchIds, type IndexedKind } from "../search-index.js";

export interface SearchHit {
  type: SearchEntityType;
  id: number;
  label: string;
  context: string | null;
  /** Solo `track`: el disco al que pertenece (no tiene ficha propia; se navega al álbum). */
  albumId: number | null;
}

/** Hits de una entidad indexada: el orden lo manda el índice (los que empiezan primero). */
async function searchIndexed<T extends { id: string; name: string }>(
  kind: IndexedKind, q: string, limit: number, type: SearchEntityType,
  sql: string, context: (row: T) => string | null,
): Promise<SearchHit[]> {
  const ids = (await searchIds(kind, q)).slice(0, limit);
  if (ids.length === 0) return [];
  const { rows } = await getPool().query<T>(sql, [ids]);
  return rows.map((row) => ({ type, id: Number(row.id), label: row.name, context: context(row), albumId: null }));
}

async function searchArtists(q: string, limit: number): Promise<SearchHit[]> {
  return searchIndexed<{ id: string; name: string; origin_city: string | null }>("artist", q, limit, "artist",
    `SELECT a.id::text AS id, a.name, a.origin_city FROM public.artists a
      WHERE a.id = ANY($1::bigint[]) ORDER BY array_position($1::bigint[], a.id)`,
    (row) => row.origin_city);
}

async function searchPersons(q: string, limit: number): Promise<SearchHit[]> {
  return searchIndexed<{ id: string; name: string; nationality: string | null }>("person", q, limit, "person",
    `SELECT p.id::text AS id, p.name, p.nationality FROM public.persons p
      WHERE p.id = ANY($1::bigint[]) ORDER BY array_position($1::bigint[], p.id)`,
    (row) => row.nationality);
}

async function searchAlbums(q: string, limit: number): Promise<SearchHit[]> {
  // Disco y pista siguen con ILIKE (es el índice de nombres de entidad): aquí
  // los comodines los pone la propia consulta, no quien la llama.
  const pattern = `%${q}%`;
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

async function searchTracks(q: string, limit: number): Promise<SearchHit[]> {
  const pattern = `%${q}%`;
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

async function searchOrganizations(q: string, limit: number): Promise<SearchHit[]> {
  return searchIndexed<{ id: string; name: string; organization_type: string | null }>("organization", q, limit, "organization",
    `SELECT o.id::text AS id, o.name, o.organization_type FROM public.organizations o
      WHERE o.id = ANY($1::bigint[]) ORDER BY array_position($1::bigint[], o.id)`,
    (row) => row.organization_type);
}

const SEARCHERS: Record<SearchEntityType, (q: string, limit: number) => Promise<SearchHit[]>> = {
  artist: searchArtists,
  person: searchPersons,
  album: searchAlbums,
  track: searchTracks,
  organization: searchOrganizations,
};

export async function globalSearch(
  q: string, limit: number, types: readonly SearchEntityType[] = ALL_SEARCH_TYPES,
): Promise<Record<SearchEntityType, SearchHit[]>> {
  const entries = await Promise.all(types.map(async (type) => [type, await SEARCHERS[type](q, limit)] as const));
  const result = {} as Record<SearchEntityType, SearchHit[]>;
  for (const [type, hits] of entries) result[type] = hits;
  for (const type of ALL_SEARCH_TYPES) result[type] ??= [];
  return result;
}
