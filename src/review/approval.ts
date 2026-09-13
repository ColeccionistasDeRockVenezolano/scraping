// Promoción por entidad. La cola guarda un ítem por claim, pero una persona no
// decide campo a campo: decide si "Los Kings" entra al catálogo. Aprobar
// re-ejecuta el merge marcando createdBy="human", que es la guarda que el motor
// YA contempla para crear entidades — no se abre una vía nueva al core ni se
// eleva la confianza del claim, que sigue siendo `low` y trazable como tal.
import { getPool } from "../db/client.js";
import { mergeClaim } from "../merge/engine.js";
import { resolvableSpec } from "../merge/specs.js";
import type { ClaimToPersist, Confidence } from "../claims/persistence.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("review:approval");

export interface PendingEntity {
  entityKind: string;
  identityKey: string;
  identityRaw: string;
  claims: number;
  fields: string[];
  sources: number;
}

export interface ApprovalResult {
  entityKind: string;
  identityKey: string;
  promoted: number;
  applied: number;
  /** Ya coincidía con el core: la re-aprobación es idempotente, no un fallo. */
  unchanged: number;
  stillCandidate: number;
  unsupported: number;
  reviewsClosed: number;
  targetId?: number;
  /** Filas puente creadas o reconocidas cuando la entidad es una relación. */
  relationIds?: number[];
}

interface ClaimRow {
  id: string;
  source_id: string;
  entity_kind: string;
  field: string;
  raw_value: unknown;
  normalized_value: unknown;
  raw_hash: string;
  extractor: string;
  extractor_version: string;
  confidence: Confidence;
  identity_raw: string | null;
  identity_key: string | null;
  identity_secondary_key: string | null;
  run_id: string | null;
  artist_id: string | null;
  person_id: string | null;
  organization_id: string | null;
  album_id: string | null;
  track_id: string | null;
  evidence_url: string | null;
}

const num = (value: string | null): number | undefined => (value === null ? undefined : Number(value));

/** Reconstruye el claim ya persistido para volver a pasarlo por el merge. */
function toClaimToPersist(row: ClaimRow): ClaimToPersist {
  const identity = row.identity_raw ?? row.identity_key ?? "";
  return {
    entityKind: row.entity_kind as ClaimToPersist["entityKind"],
    identity: row.identity_key ?? identity,
    identitySecondary: row.identity_secondary_key ?? identity,
    originalIdentity: identity,
    field: row.field,
    rawValue: row.raw_value,
    normalizedValue: row.normalized_value,
    rawHash: row.raw_hash,
    extractor: row.extractor,
    extractorVersion: row.extractor_version,
    // El motor no lee la evidencia (vive en ingest.claim_evidence y no se
    // duplica aquí); se conserva la URL real cuando existe para no inventarla.
    evidence: { url: row.evidence_url ?? "https://localhost/claim" },
    sourceId: Number(row.source_id),
    confidence: row.confidence,
    // La decisión humana es lo que habilita la creación de la entidad.
    createdBy: "human",
    ...(row.run_id === null ? {} : { runId: Number(row.run_id) }),
    ...(num(row.artist_id) === undefined ? {} : { artistId: num(row.artist_id) }),
    ...(num(row.person_id) === undefined ? {} : { personId: num(row.person_id) }),
    ...(num(row.organization_id) === undefined ? {} : { organizationId: num(row.organization_id) }),
    ...(num(row.album_id) === undefined ? {} : { albumId: num(row.album_id) }),
    ...(num(row.track_id) === undefined ? {} : { trackId: num(row.track_id) }),
  } as ClaimToPersist;
}

/** Recupera un claim ya persistido sin concederle autoridad por sí mismo. */
export async function loadClaimForApproval(claimId: number): Promise<ClaimToPersist | undefined> {
  const { rows } = await getPool().query<ClaimRow>(`${SELECT_CLAIM} WHERE c.id=$1`, [claimId]);
  return rows[0] === undefined ? undefined : toClaimToPersist(rows[0]);
}

const SELECT_CLAIM = `
  SELECT c.id::text, c.source_id::text, c.entity_kind, c.field, c.raw_value, c.normalized_value,
         c.raw_hash, c.extractor, c.extractor_version, c.confidence,
         c.identity_raw, c.identity_key, c.identity_secondary_key, c.run_id::text,
         c.artist_id::text, c.person_id::text, c.organization_id::text, c.album_id::text, c.track_id::text,
         (SELECT e.url FROM ingest.claim_evidence e WHERE e.claim_id = c.id ORDER BY e.id LIMIT 1) AS evidence_url
    FROM ingest.claims c`;

/**
 * Candidatos agrupados por entidad: una decisión humana por identidad.
 *
 * `sourceSlug` elige QUÉ entidades entran, no qué claims se promueven: una
 * entidad vista por dos fuentes se selecciona por cualquiera de ellas y sus
 * contadores siguen siendo globales, porque la identidad es una sola. Por eso
 * el filtro va en HAVING y no en WHERE.
 */
export async function pendingEntities(
  options: { entityKind?: string; sourceSlug?: string; limit?: number } = {},
): Promise<PendingEntity[]> {
  const params: unknown[] = [];
  let filter = "status = 'candidate' AND identity_key IS NOT NULL";
  if (options.entityKind) {
    params.push(options.entityKind);
    filter += ` AND entity_kind = $${params.length}`;
  }
  let having = "";
  if (options.sourceSlug) {
    params.push(options.sourceSlug);
    having = `HAVING bool_or(source_id = (SELECT id FROM ingest.sources WHERE slug = $${params.length}))`;
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 5_000));
  const { rows } = await getPool().query<{
    entity_kind: string; identity_key: string; identity_raw: string | null;
    claims: number; fields: string[]; sources: number;
  }>(`
    SELECT entity_kind, identity_key, min(identity_raw) AS identity_raw,
           count(*)::int AS claims, array_agg(DISTINCT field) AS fields,
           count(DISTINCT source_id)::int AS sources
      FROM ingest.claims
     WHERE ${filter}
     GROUP BY entity_kind, identity_key
     ${having}
     ORDER BY count(DISTINCT source_id) DESC, count(*) DESC, min(identity_raw), identity_key
     LIMIT $${params.length}`, params);

  return rows.map((row) => ({
    entityKind: row.entity_kind,
    identityKey: row.identity_key,
    identityRaw: row.identity_raw ?? row.identity_key,
    claims: row.claims,
    fields: row.fields,
    sources: row.sources,
  }));
}

async function closeReviews(claimIds: number[], resolution: "approved" | "dismissed", note: string): Promise<number> {
  if (claimIds.length === 0) return 0;
  const { rowCount } = await getPool().query(`
    UPDATE ingest.review_queue
       SET status=$2, resolved_by='human', resolution_note=$3, resolved_at=now(), updated_at=now()
     WHERE claim_a_id = ANY($1::bigint[]) AND status IN ('open','in_progress')
       -- Aprobar la identidad no arbitra valores ni enlaces rivales. Esos
       -- trabajos tienen aplicadores propios y deben seguir visibles.
       AND kind NOT IN ('field_conflict','youtube_match','possible_duplicate')`,
  [claimIds, resolution, note]);
  return rowCount ?? 0;
}

/**
 * Promueve todos los claims candidatos de una entidad. El claim de la columna
 * identidad va primero: `createEntity` solo actúa sobre él, y el resto necesita
 * que la entidad exista para engancharse por AUTO_MATCH.
 */
export async function approveEntity(entityKind: string, identityKey: string, note: string): Promise<ApprovalResult> {
  if (!note.trim()) throw new Error("nota de resolución obligatoria");
  const spec = resolvableSpec(entityKind as ClaimToPersist["entityKind"]);
  const { rows } = await getPool().query<ClaimRow>(
    `${SELECT_CLAIM} WHERE c.entity_kind=$1 AND c.identity_key=$2 AND c.status='candidate'
      ORDER BY (c.field = $3) DESC, c.id`,
    [entityKind, identityKey, spec?.identityColumn ?? ""],
  );
  if (rows.length === 0) throw new Error(`sin claims candidatos para ${entityKind} "${identityKey}"`);

  const result: ApprovalResult = {
    entityKind, identityKey, promoted: rows.length,
    applied: 0, unchanged: 0, stillCandidate: 0, unsupported: 0, reviewsClosed: 0,
  };

  // Solo se cierra la revisión de lo que avanzó: si un claim sigue candidato,
  // su ítem queda abierto en vez de esconder trabajo sin hacer.
  const progressed: number[] = [];
  for (const row of rows) {
    const outcome = await mergeClaim(toClaimToPersist(row), { id: Number(row.id), inserted: false });
    if (outcome.action === "applied") {
      result.applied += 1;
      progressed.push(Number(row.id));
      const target = (outcome as { artistId?: number; personId?: number; organizationId?: number; albumId?: number; trackId?: number });
      const resolved = target.artistId ?? target.personId ?? target.organizationId ?? target.albumId ?? target.trackId;
      if (resolved !== undefined) result.targetId = resolved;
      if (outcome.relationIds?.length) result.relationIds = [...new Set([...(result.relationIds ?? []), ...outcome.relationIds])];
    } else if (outcome.action === "unchanged") {
      // El claim no cambió nada porque el core ya lo dice: su revisión se
      // cierra igual, o quedaría abierta para siempre.
      result.unchanged += 1;
      progressed.push(Number(row.id));
    } else if (outcome.action === "unsupported") result.unsupported += 1;
    else result.stillCandidate += 1;
  }

  result.reviewsClosed = await closeReviews(progressed, "approved", note);
  log.info({ ...result }, "entidad aprobada");
  return result;
}

/** Descarta los candidatos de una entidad sin tocar el core. */
export async function dismissEntity(entityKind: string, identityKey: string, note: string): Promise<ApprovalResult> {
  if (!note.trim()) throw new Error("nota de resolución obligatoria");
  const { rows } = await getPool().query<{ id: string }>(
    "SELECT id::text FROM ingest.claims WHERE entity_kind=$1 AND identity_key=$2 AND status='candidate'",
    [entityKind, identityKey],
  );
  if (rows.length === 0) throw new Error(`sin claims candidatos para ${entityKind} "${identityKey}"`);
  const ids = rows.map((row) => Number(row.id));
  await getPool().query("UPDATE ingest.claims SET status='rejected',updated_at=now() WHERE id = ANY($1::bigint[])", [ids]);
  const reviewsClosed = await closeReviews(ids, "dismissed", note);
  log.info({ entityKind, identityKey, rejected: ids.length, reviewsClosed }, "entidad descartada");
  return { entityKind, identityKey, promoted: 0, applied: 0, unchanged: 0, stillCandidate: 0, unsupported: 0, reviewsClosed };
}
