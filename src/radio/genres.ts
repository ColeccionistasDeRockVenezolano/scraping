// CRV · Géneros de la Radio CRV (PLAN_GENEROS §6).
//
// La radio en vivo la mantiene el exportador de herra (cron diario sobre el
// canal); este módulo no decide qué canciones suenan. Solo ANOTA cada pieza con
// los géneros CONFIRMADOS de su álbum en el catálogo, nunca los del artista:
//
//   video de YouTube → álbum enlazado (enlace principal primero) → album_genres confirmados.
//
// Una pieza sin álbum enlazado queda sin anotar y sigue sonando en la radio
// general; una con álbum pero sin principal confirmado queda `pending` o
// `unclassified` y no entra en estaciones por género.
import type { Pool, PoolClient } from "pg";
import { radioGenresOf, RADIO_CATALOG_VERSION, type RadioTrackGenres } from "./catalog.js";

type Queryable = Pick<Pool | PoolClient, "query">;

/** Géneros de radio por álbum, a partir de sus asignaciones confirmadas. */
export async function loadRadioAlbumGenres(db: Queryable, albumIds: number[]): Promise<Map<number, RadioTrackGenres>> {
  const unique = [...new Set(albumIds)];
  if (!unique.length) return new Map();
  const { rows } = await db.query<{ album_id: string; genre: string | null; slug: string | null; name: string | null; family: string | null; role: "primary" | "secondary" | null }>(`
    SELECT al.id::text AS album_id, al.genre, g.slug, g.name, COALESCE(f.slug, g.slug) AS family, ag.role
      FROM public.albums al
      LEFT JOIN ingest.album_genres ag ON ag.album_id = al.id AND ag.status = 'confirmed'
      LEFT JOIN ingest.genre_lineage g ON g.id = ag.genre_id
      LEFT JOIN ingest.genres f ON f.id = g.family_id
     WHERE al.id = ANY($1::bigint[])
     ORDER BY al.id, (ag.role = 'primary') DESC, g.name`, [unique]);
  const byAlbum = new Map<number, { visible: string | null; confirmed: Array<{ slug: string; name: string; family: string; role: "primary" | "secondary" }> }>();
  for (const row of rows) {
    const entry = byAlbum.get(Number(row.album_id)) ?? { visible: row.genre, confirmed: [] };
    if (row.slug && row.name && row.family && row.role) entry.confirmed.push({ slug: row.slug, name: row.name, family: row.family, role: row.role });
    byAlbum.set(Number(row.album_id), entry);
  }
  return new Map([...byAlbum].map(([id, entry]) => [id, radioGenresOf(entry.confirmed, entry.visible)]));
}

/** Álbum del catálogo de cada video (enlace principal primero; a igualdad, el id menor). */
export async function albumsForVideos(db: Queryable, videoIds: string[]): Promise<Map<string, number>> {
  const unique = [...new Set(videoIds)];
  if (!unique.length) return new Map();
  const { rows } = await db.query<{ video_id: string; album_id: string }>(`
    SELECT DISTINCT ON (v.video_id) v.video_id, va.album_id::text
      FROM media.youtube_videos v JOIN media.video_albums va ON va.video_id = v.id
     WHERE v.video_id = ANY($1::text[])
     ORDER BY v.video_id, va.is_primary_link DESC, va.album_id`, [unique]);
  return new Map(rows.map((row) => [row.video_id, Number(row.album_id)]));
}

export interface AnnotationStats { items: number; linked: number; confirmed: number; pending: number; unclassified: number; unlinked: number }

/**
 * Anota un catálogo de radio ya exportado (el de herra). No quita, agrega ni
 * reordena piezas ni toca sus tiempos: solo `albumId` y `genres`, y la versión.
 * Lo que ya no tiene álbum pierde la anotación vieja.
 */
export function annotateRadioCatalog(
  catalog: Record<string, unknown>, albumByVideo: ReadonlyMap<string, number>, genresByAlbum: ReadonlyMap<number, RadioTrackGenres>,
  annotatedAt: string,
): { catalog: Record<string, unknown>; stats: AnnotationStats } {
  if (!Array.isArray(catalog["items"])) throw new Error("el catálogo de radio no tiene `items`");
  const stats: AnnotationStats = { items: 0, linked: 0, confirmed: 0, pending: 0, unclassified: 0, unlinked: 0 };
  const items = (catalog["items"] as unknown[]).map((raw) => {
    stats.items += 1;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
    const { albumId: _oldAlbum, genres: _oldGenres, ...item } = raw as Record<string, unknown>;
    const albumId = typeof item["videoId"] === "string" ? albumByVideo.get(item["videoId"]) : undefined;
    const genres = albumId === undefined ? undefined : genresByAlbum.get(albumId);
    if (albumId === undefined || !genres) {
      stats.unlinked += 1;
      return item;
    }
    stats.linked += 1;
    stats[genres.genreStatus] += 1;
    return { ...item, albumId, genres };
  });
  return { catalog: { ...catalog, version: RADIO_CATALOG_VERSION, genresAnnotatedAt: annotatedAt, items }, stats };
}
