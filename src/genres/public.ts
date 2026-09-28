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
  const { rows } = await db.query<{ entity_id: string; id: string; slug: string; name: string; family: string; role: string }>(`
    SELECT x.${column}::text AS entity_id, g.id::text, g.slug, g.name, COALESCE(f.slug, g.slug) AS family, x.role
      FROM ingest.${kind}_genres x
      JOIN ingest.genres g ON g.id = x.genre_id
      LEFT JOIN ingest.genres f ON f.id = g.parent_genre_id
     WHERE x.${column} = ANY($1::bigint[]) AND x.status = 'confirmed'
     ORDER BY x.${column}, (x.role = 'primary') DESC, g.name`, [unique]);
  for (const id of unique) result.set(id, { primaryGenre: null, genres: [], genreStatus: "unclassified" });
  for (const row of rows) {
    const entry = result.get(Number(row.entity_id))!;
    const genre: PublicGenre = { id: Number(row.id), slug: row.slug, name: row.name, family: row.family };
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
 * Condición SQL para filtrar por slug (PLAN §5): una familia incluye lo
 * asignado a la familia y a sus hijos. `$n` es el parámetro con el slug.
 */
export function genreFilterSql(kind: GenreEntityKind, entityExpr: string, param: string): string {
  const column = kind === "album" ? "album_id" : "artist_id";
  return `EXISTS (
    SELECT 1 FROM ingest.${kind}_genres gf
      JOIN ingest.genres gg ON gg.id = gf.genre_id
      LEFT JOIN ingest.genres gp ON gp.id = gg.parent_genre_id
     WHERE gf.${column} = ${entityExpr} AND gf.status = 'confirmed'
       AND (gg.slug = ${param} OR gp.slug = ${param}))`;
}

/**
 * Fichas cuyo género principal lo eligió Laya (`decided_by = 'auto:laya'`,
 * último recurso del 2026-09-27). Solo se enseña a quien inició sesión.
 */
export async function layaDecidedIds(kind: GenreEntityKind, ids: number[], db: Queryable = getPool()): Promise<Set<number>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set();
  const column = kind === "album" ? "album_id" : "artist_id";
  const { rows } = await db.query<{ id: string }>(`
    SELECT DISTINCT ${column}::text AS id FROM ingest.${kind}_genres
     WHERE ${column} = ANY($1::bigint[]) AND role = 'primary' AND status = 'confirmed' AND decided_by = 'auto:laya'`, [unique]);
  return new Set(rows.map((row) => Number(row.id)));
}
