// Persistencia idempotente de claims y evidencias. El indice real
// claims_dedupe_uk es la autoridad; ON CONFLICT nunca reescribe un claim.
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/client.js";
import type { ResolutionInput } from "../er/types.js";
import type { NormalizedClaim } from "../normalization/claims.js";

export type Confidence = "high" | "medium" | "low";
export type Actor = "system" | "ai" | "human";

export interface ClaimTargets {
  artistId?: number;
  personId?: number;
  organizationId?: number;
  albumId?: number;
  trackId?: number;
  artistMembershipId?: number;
  personOrganizationId?: number;
  albumCreditId?: number;
  trackCreditId?: number;
  albumFormatId?: number;
  videoId?: number;
  mediaLinkId?: number;
}

/**
 * Extremos de una relación ya identificados por id. Solo los aporta una
 * persona (la API del operador): no se guardan en el claim —que tiene un único
 * destino— sino que el puente de relaciones los verifica y los usa en vez de
 * resolver nombres.
 */
export interface RelationEndpoints {
  artistId?: number;
  personId?: number;
  organizationId?: number;
  albumId?: number;
  trackId?: number;
}

export interface ClaimToPersist extends NormalizedClaim, ClaimTargets {
  sourceId: number;
  endpoints?: RelationEndpoints;
  rawPageId?: number;
  seedUploadId?: number;
  runId?: number;
  confidence: Confidence;
  createdBy?: Actor;
  /** Contexto tipado para ER. No se ejecuta ni se copia al core. */
  resolutionInput?: ResolutionInput;
  /** Parentales requeridos para proponer ALBUM/TRACK nuevos. */
  parentArtistId?: number;
  parentAlbumId?: number;
  discNumber?: number;
  trackNumber?: number;
}

export interface PersistedClaim {
  id: number;
  inserted: boolean;
}

const TARGET_KEYS = [
  "artistId", "personId", "organizationId", "albumId", "trackId",
  "artistMembershipId", "personOrganizationId", "albumCreditId",
  "trackCreditId", "albumFormatId", "videoId", "mediaLinkId",
] as const satisfies ReadonlyArray<keyof ClaimTargets>;

function json(value: unknown): string { return JSON.stringify(value); }

export function targetId(input: ClaimTargets): number | undefined {
  const values = TARGET_KEYS.map((key) => input[key]).filter((item): item is number => item !== undefined);
  if (values.length > 1) throw new Error("un claim no puede apuntar a mas de una entidad");
  return values[0];
}

/**
 * Destinos que entran en `claims_dedupe_uk`. `mediaLinkId` queda fuera a
 * propósito: 0008 no añadió esa columna al COALESCE del índice, porque
 * hacerlo cambiaría la clave de deduplicacion de TODOS los claims ya
 * almacenados. Esta funcion refleja el indice real, que es la autoridad.
 */
function dedupeTargetId(input: ClaimTargets): number {
  return TARGET_KEYS
    .filter((key) => key !== "mediaLinkId")
    .map((key) => input[key])
    .find((item): item is number => item !== undefined) ?? 0;
}

/** `queryable` permite persistir dentro de la transacción de quien llama. */
export async function persistClaim(input: ClaimToPersist, queryable: Pick<Pool | PoolClient, "query"> = getPool()): Promise<PersistedClaim> {
  const pool = queryable;
  const createdBy = input.createdBy ?? "system";
  // Una propuesta de IA nunca adquiere autoridad high/medium por accidente.
  const confidence: Confidence = createdBy === "ai" ? "low" : input.confidence;
  const targets = TARGET_KEYS.map((key) => input[key] ?? null);
  // El merge puede adjuntar un target a una propuesta despues del primer
  // INSERT. En el re-run hay que reconocerla antes de intentar nuevamente
  // con target NULL; raw_hash ya incluye la identidad y evita mezclar filas.
  const prior = await pool.query<{ id: string }>(`
    SELECT id FROM ingest.claims
     WHERE source_id=$1 AND COALESCE(raw_page_id,0)=COALESCE($2,0)
       AND COALESCE(seed_upload_id,0)=COALESCE($3,0) AND entity_kind=$4
       AND field=$5 AND raw_hash=$6 AND identity_key=$7
     ORDER BY id LIMIT 1`, [
    input.sourceId, input.rawPageId ?? null, input.seedUploadId ?? null,
    input.entityKind, input.field, input.rawHash, input.identity,
  ]);
  if (prior.rows[0]?.id) {
    const id = Number(prior.rows[0].id);
    await persistEvidence(id, input, pool);
    return { id, inserted: false };
  }
  const insert = await pool.query<{ id: string }>(`
    INSERT INTO ingest.claims (
      source_id, raw_page_id, seed_upload_id, entity_kind,
      artist_id, person_id, organization_id, album_id, track_id,
      artist_membership_id, person_organization_id, album_credit_id,
      track_credit_id, album_format_id, video_id, media_link_id,
      field, raw_value, normalized_value, raw_hash, extractor,
      extractor_version, confidence, created_by, run_id,
      identity_raw, identity_key, identity_secondary_key
    ) VALUES (
      $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
      $17,$18::jsonb,$19::jsonb,$20,$21,$22,$23,$24,$25,$26,$27,$28
    ) ON CONFLICT DO NOTHING RETURNING id`, [
    input.sourceId, input.rawPageId ?? null, input.seedUploadId ?? null, input.entityKind,
    ...targets,
    input.field, json(input.rawValue), json(input.normalizedValue), input.rawHash,
    input.extractor, input.extractorVersion, confidence, createdBy, input.runId ?? null,
    input.originalIdentity, input.identity, input.identitySecondary,
  ]);
  const id = insert.rows[0]?.id;
  if (id) {
    await persistEvidence(Number(id), input, pool);
    return { id: Number(id), inserted: true };
  }
  const existing = await pool.query<{ id: string }>(`
    SELECT id FROM ingest.claims
    WHERE source_id=$1 AND COALESCE(raw_page_id,0)=COALESCE($2,0)
      AND COALESCE(seed_upload_id,0)=COALESCE($3,0) AND entity_kind=$4
      AND COALESCE(artist_id, person_id, organization_id, album_id, track_id,
                   artist_membership_id, person_organization_id, album_credit_id,
                   track_credit_id, album_format_id, video_id, 0)=$5
      AND field=$6 AND raw_hash=$7
    LIMIT 1`, [input.sourceId, input.rawPageId ?? null, input.seedUploadId ?? null,
    input.entityKind, dedupeTargetId(input), input.field, input.rawHash]);
  const existingId = existing.rows[0]?.id;
  if (!existingId) throw new Error("claims_dedupe_uk rechazo un claim pero no se encontro el duplicado");
  await persistEvidence(Number(existingId), input, pool);
  return { id: Number(existingId), inserted: false };
}

async function persistEvidence(claimId: number, input: ClaimToPersist, queryable: Pick<Pool | PoolClient, "query">): Promise<void> {
  const evidenceHash = createHash("sha256").update(json(input.evidence)).digest("hex");
  await queryable.query(`
    INSERT INTO ingest.claim_evidence (claim_id, raw_page_id, seed_upload_id, url, excerpt, selector, position, evidence_hash)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (claim_id, evidence_hash) DO NOTHING`, [
    claimId, input.rawPageId ?? null, input.seedUploadId ?? null, input.evidence.url,
    input.evidence.excerpt ?? null, input.evidence.selector ?? null, input.evidence.position ?? null, evidenceHash,
  ]);
}
