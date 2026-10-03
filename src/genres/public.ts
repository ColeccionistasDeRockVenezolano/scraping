// CRV · Géneros públicos: lo que el catálogo y la Radio CRV pueden mostrar
// (PLAN_GENEROS §5 y §6).
//
// Solo cuentan las asignaciones `confirmed`: una sugerencia o un texto de
// fuente sin confirmar nunca se presenta como hecho ni entra en filtros o
// estaciones. Las pistas heredan del ÁLBUM (`genreOrigin: "album"`), nunca del
// artista; artista y álbum se leen por separado y no se mezclan.
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { genreStatusOf, type GenreStatus } from "../merge/genre-projection.js";
import type { GenreEntityKind } from "./rules.js";

export interface PublicGenre {
  id: number;
  slug: string;
  name: string;
  /** Slug de la familia; en una asignación directa a familia, el propio slug. */
  family: string;
  /** Solo en un subgénero: el slug de su género (pasaje → joropo). */
  parentGenre?: string;
}

export interface PublicGenres {
  primaryGenre: PublicGenre | null;
  genres: PublicGenre[];
  genreStatus: GenreStatus;
}

type Queryable = Pick<Pool | PoolClient, "query">;

/**
 * Géneros confirmados de varias entidades de un nivel, principal primero.
 * `visibleText` (solo álbumes: `albums.genre`) distingue `pending` de
 * `unclassified` cuando no hay principal confirmado.
 */
export async function publicGenresFor(
  kind: GenreEntityKind, ids: number[], visibleText: ReadonlyMap<number, string | null> = new Map(), db: Queryable = getPool(),
): Promise<Map<number, PublicGenres>> {
  const result = new Map<number, PublicGenres>();
  const unique = [...new Set(ids)];
  if (!unique.length) return result;
  const column = kind === "album" ? "album_id" : "artist_id";
  const { rows } = await db.query<{ entity_id: string; id: string; slug: string; name: string; family: string; parent_genre: string | null; role: string }>(`
    SELECT x.${column}::text AS entity_id, g.id::text, g.slug, g.name, COALESCE(f.slug, g.slug) AS family,
           CASE WHEN g.level = 'subgenre' THEN pg.slug END AS parent_genre, x.role
      FROM ingest.${kind}_genres x
      JOIN ingest.genre_lineage g ON g.id = x.genre_id
      LEFT JOIN ingest.genres f ON f.id = g.family_id
      LEFT JOIN ingest.genres pg ON pg.id = g.genre_id
     WHERE x.${column} = ANY($1::bigint[]) AND x.status = 'confirmed'
     ORDER BY x.${column}, (x.role = 'primary') DESC, g.name`, [unique]);
  for (const id of unique) result.set(id, { primaryGenre: null, genres: [], genreStatus: "unclassified" });
  for (const row of rows) {
    const entry = result.get(Number(row.entity_id))!;
    const genre: PublicGenre = { id: Number(row.id), slug: row.slug, name: row.name, family: row.family };
    if (row.parent_genre) genre.parentGenre = row.parent_genre;
    entry.genres.push(genre);
    if (row.role === "primary") entry.primaryGenre = genre;
  }
  for (const [id, entry] of result) {
    // Artista: sin proyección de texto; con géneros confirmados pero sin principal sigue pendiente.
    const visible = kind === "album" ? visibleText.get(id) ?? null : entry.genres.length ? "pending" : null;
    entry.genreStatus = genreStatusOf(entry.primaryGenre !== null, visible);
  }
  return result;
}

/**
 * Condición SQL para filtrar por slug (PLAN §5): un nodo incluye lo asignado
 * a él y a sus descendientes (una familia, sus géneros y subgéneros; un
 * género, sus subgéneros). `$n` es el parámetro con el slug.
 */
export function genreFilterSql(kind: GenreEntityKind, entityExpr: string, param: string): string {
  const column = kind === "album" ? "album_id" : "artist_id";
  return `EXISTS (
    SELECT 1 FROM ingest.${kind}_genres gf
      JOIN ingest.genre_lineage gg ON gg.id = gf.genre_id
      JOIN ingest.genres gp ON gp.id IN (gg.id, gg.genre_id, gg.family_id)
     WHERE gf.${column} = ${entityExpr} AND gf.status = 'confirmed' AND gp.slug = ${param})`;
}

/** Condición SQL: la entidad no tiene ningún género confirmado (filtro «Sin género»). */
export function genreMissingSql(kind: GenreEntityKind, entityExpr: string): string {
  const column = kind === "album" ? "album_id" : "artist_id";
  return `NOT EXISTS (
    SELECT 1 FROM ingest.${kind}_genres gm WHERE gm.${column} = ${entityExpr} AND gm.status = 'confirmed')`;
}

/**
 * Condición SQL para la ampliación opcional del filtro de discos: un disco sin
 * género por el de su artista. Es solo una vista de búsqueda —no asigna ni
 * hereda nada— y quien la usa la combina con `genreMissingSql`. (El camino
 * inverso, artista por sus discos, ya no hace falta: desde 0036 el artista
 * recibe los géneros de sus discos.)
 */
export function relatedGenreFilterSql(entityExpr: string, param: string): string {
  return `EXISTS (SELECT 1 FROM public.albums ra WHERE ra.id = ${entityExpr} AND ${genreFilterSql("artist", "ra.artist_id", param)})`;
}

export interface GenreFacet {
  slug: string;
  name: string;
  /** Fichas con este género confirmado (también las de sus descendientes). */
  count: number;
  /** Discos sin género propio que entran por el de su artista (en artistas, siempre 0). */
  relatedCount: number;
}

export interface GenreGenreFacet extends GenreFacet {
  /** Subgéneros con fichas; ausente si no tiene ninguno. */
  subgenres?: GenreFacet[];
}

export interface GenreFamilyFacet extends GenreFacet {
  genres: GenreGenreFacet[];
}

export interface GenreFacets {
  total: number;
  withoutGenre: number;
  families: GenreFamilyFacet[];
}

/**
 * Conteos para el filtro por género de las listas: familias y subgéneros
 * activos con al menos una ficha (propia o por relación), de más a menos.
 * Cuentan las mismas fichas que `genreFilterSql` y `relatedGenreFilterSql`.
 */
export async function genreFacets(kind: GenreEntityKind, db: Queryable = getPool()): Promise<GenreFacets> {
  const own = kind === "album"
    ? `SELECT x.album_id AS entity_id, x.genre_id FROM ingest.album_genres x
         JOIN public.albums e ON e.id = x.album_id WHERE x.status = 'confirmed'`
    : `SELECT x.artist_id AS entity_id, x.genre_id FROM ingest.artist_genres x
         JOIN public.artists e ON e.id = x.artist_id WHERE x.status = 'confirmed'`;
  const related = kind === "album"
    ? `SELECT e.id AS entity_id, x.genre_id FROM public.albums e
         JOIN ingest.artist_genres x ON x.artist_id = e.artist_id AND x.status = 'confirmed'
        WHERE ${genreMissingSql("album", "e.id")}`
    : "SELECT NULL::bigint AS entity_id, NULL::bigint AS genre_id WHERE false";
  const entityTable = kind === "album" ? "public.albums" : "public.artists";
  const [counts, totals] = await Promise.all([
    // Cada asignación suma a su nodo y a sus antepasados (género y familia).
    db.query<{ source: "own" | "related"; node_id: string; count: string }>(`
      WITH hits AS (
        SELECT 'own' AS source, h.entity_id, h.genre_id FROM (${own}) h
        UNION ALL
        SELECT 'related', h.entity_id, h.genre_id FROM (${related}) h)
      SELECT h.source, n.node_id::text, count(DISTINCT h.entity_id)::text AS count
        FROM hits h
        JOIN ingest.genre_lineage l ON l.id = h.genre_id
        CROSS JOIN LATERAL (SELECT DISTINCT v FROM unnest(ARRAY[l.id, l.genre_id, l.family_id]) v WHERE v IS NOT NULL) n(node_id)
       GROUP BY h.source, n.node_id`),
    db.query<{ total: string; without: string }>(`
      SELECT count(*)::text AS total, count(*) FILTER (WHERE ${genreMissingSql(kind, "e.id")})::text AS without
        FROM ${entityTable} e`),
  ]);
  const { rows: nodes } = await db.query<{ id: string; slug: string; name: string; level: string; parent_id: string | null }>(`
    SELECT id::text, slug, name, level, parent_genre_id::text AS parent_id
      FROM ingest.genres WHERE active ORDER BY name`);

  const byNode = new Map<string, { own: number; related: number }>();
  for (const row of counts.rows) {
    const entry = byNode.get(row.node_id) ?? { own: 0, related: 0 };
    entry[row.source] = Number(row.count);
    byNode.set(row.node_id, entry);
  }
  const facetOf = (node: { id: string; slug: string; name: string }): GenreFacet => ({
    slug: node.slug, name: node.name, count: byNode.get(node.id)?.own ?? 0, relatedCount: byNode.get(node.id)?.related ?? 0,
  });
  const visible = (facet: GenreFacet) => facet.count > 0 || facet.relatedCount > 0;
  const byCount = (a: GenreFacet, b: GenreFacet) => b.count - a.count || b.relatedCount - a.relatedCount || a.name.localeCompare(b.name, "es");
  const families: GenreFamilyFacet[] = nodes.filter((node) => node.level === "family").map((family) => ({
    ...facetOf(family),
    genres: nodes.filter((node) => node.level === "genre" && node.parent_id === family.id).map((genre) => {
      const subgenres = nodes.filter((node) => node.level === "subgenre" && node.parent_id === genre.id).map(facetOf).filter(visible).sort(byCount);
      return subgenres.length ? { ...facetOf(genre), subgenres } : facetOf(genre);
    }).filter(visible).sort(byCount),
  })).filter(visible).sort(byCount);
  return { total: Number(totals.rows[0]?.total ?? 0), withoutGenre: Number(totals.rows[0]?.without ?? 0), families };
}

/**
 * Fichas cuyo género principal lo eligió Laya (`decided_by = 'auto:laya'`,
 * último recurso del 2026-09-27) o, en un artista, el que recibió de discos
 * cuyo único origen fue Laya (0036). Solo se enseña a quien inició sesión.
 */
export async function layaDecidedIds(kind: GenreEntityKind, ids: number[], db: Queryable = getPool()): Promise<Set<number>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set();
  const column = kind === "album" ? "album_id" : "artist_id";
  const { rows } = await db.query<{ id: string }>(`
    SELECT DISTINCT ${column}::text AS id FROM ingest.${kind}_genres
     WHERE ${column} = ANY($1::bigint[]) AND role = 'primary' AND status = 'confirmed'
       AND (decided_by = 'auto:laya' OR decision_rule = 'de_sus_discos_laya')`, [unique]);
  return new Set(rows.map((row) => Number(row.id)));
}
