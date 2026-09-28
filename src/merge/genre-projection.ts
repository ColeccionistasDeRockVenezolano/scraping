// CRV · Proyección `ingest.album_genres` → `public.albums.genre`
// (PLAN_GENEROS §4 «albums.genre: proyección con un solo escritor»).
//
// Con GENRES_PROJECTION_ENABLED encendido, este es el ÚNICO escritor de la
// columna; el motor de fusión deja de escribirla. La regla:
//
//   1. principal confirmado                     → nombre de ese género;
//   2. una persona rechazó todos sus géneros    → NULL;
//   3. hay claims `genre` del álbum             → texto literal de la fuente de
//      mayor rango (el que el motor habría escrito), marcado `pending` en la API;
//   4. nada                                     → NULL.
//
// El rango de la fuente solo decide qué texto se ve mientras el caso espera;
// nunca decide el género confirmado. Cada cambio queda en merge_audit con los
// claims que lo respaldan, igual que cualquier otra escritura del core.
import type { PoolClient } from "pg";
import { getEnv } from "../config/env.js";
import { normalizeDisplayName } from "../normalization/entity-name.js";

/** Estados de la evidencia que cuentan como afirmación vigente de una fuente. */
export const LIVE_GENRE_CLAIM_STATUSES = ["accepted", "conflict"] as const;

export type GenreStatus = "confirmed" | "pending" | "unclassified";

export interface ProjectionResult {
  albumId: number;
  before: string | null;
  after: string | null;
  changed: boolean;
  basis: "primary" | "rejected_by_human" | "source_text" | "none";
}

interface ProjectionTarget { value: string | null; basis: ProjectionResult["basis"]; claimIds: number[] }

async function projectionTarget(client: PoolClient, albumId: number): Promise<ProjectionTarget> {
  const primary = await client.query<{ name: string; claim_ids: string[] }>(`
    SELECT g.name, ag.claim_ids::text[] AS claim_ids
      FROM ingest.album_genres ag JOIN ingest.genres g ON g.id = ag.genre_id
     WHERE ag.album_id = $1 AND ag.role = 'primary' AND ag.status = 'confirmed'`, [albumId]);
  if (primary.rows[0]) {
    return { value: primary.rows[0].name, basis: "primary", claimIds: primary.rows[0].claim_ids.map(Number) };
  }
  const states = await client.query<{ rejected_by_human: boolean; live: boolean }>(`
    SELECT bool_or(status = 'rejected' AND decision_kind = 'human') AS rejected_by_human,
           bool_or(status IN ('confirmed','suggested')) AS live
      FROM ingest.album_genres WHERE album_id = $1`, [albumId]);
  const claims = await client.query<{ id: string; value: string | null }>(`
    SELECT c.id::text, COALESCE(c.normalized_value, c.raw_value) #>> '{}' AS value
      FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
     WHERE c.album_id = $1 AND c.entity_kind = 'album' AND c.field = 'genre'
       AND c.status::text = ANY($2::text[])
     ORDER BY CASE s.trust_level::text WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              CASE c.status::text WHEN 'accepted' THEN 0 ELSE 1 END, c.id`, [albumId, [...LIVE_GENRE_CLAIM_STATUSES]]);
  const claimIds = claims.rows.map((row) => Number(row.id));
  if (states.rows[0]?.rejected_by_human && !states.rows[0].live) return { value: null, basis: "rejected_by_human", claimIds };
  const text = claims.rows.map((row) => (row.value === null ? "" : normalizeDisplayName(row.value))).find(Boolean);
  if (text) return { value: text.slice(0, 200), basis: "source_text", claimIds };
  return { value: null, basis: "none", claimIds };
}

/** El claim que ancla la auditoría: el doctor exige que toda auditoría enlace alguno. */
async function anchorClaims(client: PoolClient, albumId: number, claimIds: number[]): Promise<number[]> {
  if (claimIds.length) return claimIds;
  const { rows } = await client.query<{ id: string }>(
    "SELECT id::text FROM ingest.claims WHERE album_id = $1 ORDER BY (field = 'genre') DESC, id LIMIT 1", [albumId]);
  return rows.map((row) => Number(row.id));
}

/**
 * Recalcula `albums.genre` de un álbum. Con la proyección apagada no escribe
 * nada (el motor de fusión sigue siendo el escritor) y devuelve `changed=false`.
 */
export async function projectAlbumGenre(
  client: PoolClient, albumId: number, options: { runId?: number | undefined; force?: boolean } = {},
): Promise<ProjectionResult> {
  const current = await client.query<{ genre: string | null }>("SELECT genre FROM public.albums WHERE id = $1 FOR UPDATE", [albumId]);
  if (!current.rows[0]) throw new Error(`album ${albumId} inexistente`);
  const before = current.rows[0].genre;
  const target = await projectionTarget(client, albumId);
  const enabled = options.force ?? getEnv().GENRES_PROJECTION_ENABLED;
  if (!enabled || before === target.value) {
    return { albumId, before, after: enabled ? target.value : before, changed: false, basis: target.basis };
  }
  await client.query("UPDATE public.albums SET genre = $1 WHERE id = $2", [target.value, albumId]);
  const audit = await client.query<{ id: string }>(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,album_id,field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,'album',$2,'genre',$3::jsonb,$4::jsonb,$5,'high','system') RETURNING id::text`,
  [options.runId ?? null, albumId, before === null ? null : JSON.stringify(before), target.value === null ? null : JSON.stringify(target.value),
    `proyección de géneros (${target.basis}): album_genres → albums.genre`]);
  await client.query(
    "INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING",
    [Number(audit.rows[0]!.id), await anchorClaims(client, albumId, target.claimIds)]);
  return { albumId, before, after: target.value, changed: true, basis: target.basis };
}

/** Estado público del género de un álbum (PLAN §5 `genreStatus`). */
export function genreStatusOf(hasConfirmedPrimary: boolean, visibleGenre: string | null): GenreStatus {
  if (hasConfirmedPrimary) return "confirmed";
  return visibleGenre ? "pending" : "unclassified";
}
