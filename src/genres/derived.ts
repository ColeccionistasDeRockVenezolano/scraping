// CRV · Géneros que el artista recibe de sus discos (migración 0036, Brian
// 2026-10-01). La regla vive en la base (`ingest.crv_derive_artist_genres`) y
// se aplica sola en cada transacción que toca discos o géneros; esto es la
// reconciliación completa: la primera carga y el arreglo de cualquier deriva
// (p. ej. mantenimiento hecho con `crv.artist_genres_from_albums = off`).
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { lockGenres } from "./store.js";

export interface DerivedCounts {
  /** Filas derivadas confirmadas (principal + secundarias). */
  rows: number;
  primaries: number;
  /** Artistas con al menos una fila derivada. */
  artists: number;
  /** Artistas sin ningún género confirmado (propio o de sus discos). */
  artistsWithoutGenre: number;
}

export interface DeriveReport {
  mode: "confirm" | "dry-run";
  runId: number;
  /** Artistas cuyas filas derivadas cambiaron. */
  artistsChanged: number;
  /** Filas que cambiaron (altas, bajas y cambios). */
  rowsChanged: number;
  before: DerivedCounts;
  after: DerivedCounts;
}

type Queryable = Pick<Pool | PoolClient, "query">;

export async function measureDerivedGenres(db: Queryable): Promise<DerivedCounts> {
  const { rows } = await db.query<{ rows: string; primaries: string; artists: string; without: string }>(`
    SELECT (SELECT count(*) FROM ingest.artist_genres WHERE source_kind = 'albums' AND decision_kind = 'rule' AND status = 'confirmed')::text AS rows,
           (SELECT count(*) FROM ingest.artist_genres WHERE source_kind = 'albums' AND decision_kind = 'rule' AND status = 'confirmed' AND role = 'primary')::text AS primaries,
           (SELECT count(DISTINCT artist_id) FROM ingest.artist_genres WHERE source_kind = 'albums' AND decision_kind = 'rule')::text AS artists,
           (SELECT count(*) FROM public.artists a
             WHERE NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id = a.id AND g.status = 'confirmed'))::text AS without`);
  const row = rows[0]!;
  return { rows: Number(row.rows), primaries: Number(row.primaries), artists: Number(row.artists), artistsWithoutGenre: Number(row.without) };
}

/** Artistas cuyas filas derivadas no coinciden con lo que dicen sus discos (no escribe). */
export async function derivedDrift(db: Queryable): Promise<number[]> {
  const { rows } = await db.query<{ id: string }>(
    "SELECT id::text FROM public.artists WHERE ingest.crv_derive_artist_genres(id, false) > 0 ORDER BY id");
  return rows.map((row) => Number(row.id));
}

/**
 * Recalcula las filas derivadas de todos los artistas dentro de un run (queda
 * en el diario y se deshace desde el historial). Sin `confirm`, todo se deshace
 * y el reporte dice lo que se escribiría.
 */
export async function runDeriveArtistGenres(options: { confirm: boolean; actor: string }): Promise<DeriveReport> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockGenres(client);
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind, status, params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
    [JSON.stringify({ action: "genres_derive_artists", actor: options.actor, confirm: options.confirm })]);
    const runId = Number(run.rows[0]!.id);
    const before = await measureDerivedGenres(client);
    const { rows } = await client.query<{ artists: string; changes: string }>(`
      SELECT count(*) FILTER (WHERE n > 0)::text AS artists, COALESCE(sum(n), 0)::text AS changes
        FROM (SELECT ingest.crv_derive_artist_genres(id, true) AS n FROM public.artists ORDER BY id) x`);
    const after = await measureDerivedGenres(client);
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now() WHERE id=$1", [runId]);
    await client.query(options.confirm ? "COMMIT" : "ROLLBACK");
    return {
      mode: options.confirm ? "confirm" : "dry-run", runId,
      artistsChanged: Number(rows[0]!.artists), rowsChanged: Number(rows[0]!.changes), before, after,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
