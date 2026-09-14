// Unico escritor del core. Toda mutacion pasa por policy, advisory lock,
// claim y merge_audit. DeepSeek nunca entra en este modulo como ejecutor.
import type { PoolClient } from "pg";
import type { DeepSeekGateway } from "../ai/gateway.js";
import { getPool } from "../db/client.js";
import type { ClaimToPersist, Confidence, PersistedClaim } from "../claims/persistence.js";
import { createFieldConflict, hasOpenFieldConflict } from "../conflicts/engine.js";
import { normalizeDisplayName, normalizeEntityName } from "../normalization/entity-name.js";
import { resolveEntity } from "../er/resolver.js";
import { resolveEntityDeterministically } from "../er/scoring.js";
import { loadResolutionCandidates, persistResolutionDecision } from "../er/repository.js";
import { resolutionThresholdsFromEnv } from "../er/resolver.js";
import type { ResolutionDecision, ResolutionInput, ScoreFeature } from "../er/types.js";
import { ENTITY_SPECS, claimTargetId, resolvableSpec, type EntitySpec, type ResolvableClaimKind } from "./specs.js";
import { isRelationKind, mergeRelationClaim, type RelationClaimKind } from "./relations.js";
import { MEDIA_LINK_KIND, mergeMediaLinkClaim } from "./media-links.js";

export interface MergeOutcome {
  action: "applied" | "unchanged" | "candidate" | "conflict" | "unsupported";
  entityKind?: ResolvableClaimKind;
  entityId?: number;
  artistId?: number;
  personId?: number;
  albumId?: number;
  trackId?: number;
  organizationId?: number;
  resolutionDecisionId?: number;
  /** La entidad nació con este claim (NO_MATCH + creación), no se reconoció una existente. */
  created?: boolean;
  /** Relaciones: tipo y filas puente materializadas (una por pista acotada). */
  relationKind?: RelationClaimKind;
  relationIds?: number[];
  detail: string;
}

const ALIAS_FIELDS = new Set(["alias", "aliases", "nickname", "stage_name", "former_name", "alternate_title"]);
const CONTEXT_FIELDS = new Set([
  "artist_name", "album_title", "person_name", "organization_name", "credited_name",
  "credit_role", "credit_scope", "membership_status", "role", "from_year", "to_year",
  "label", "recording_studio", "production_company", "location", "source_url",
  // Enlaces externos de la entidad (Bandcamp, Facebook). No hay columna en el
  // core para ellos; se aceptan como contexto trazable hasta que se decida si
  // se proyectan a media.media_links.
  "web_url", "catalog_number", "format", "track_numbers", "track_title", "genre",
]);
const INTEGER_FIELDS = new Set(["formed_year", "disbanded_year", "release_year", "disc_number", "track_number", "duration_seconds", "youtube_start_seconds", "label_id"]);
const BOOLEAN_FIELDS = new Set(["is_venezuelan"]);

// Textos largos: una biografía escrita por una persona trae párrafos. El
// normalizador de nombres colapsa todo espacio, saltos incluidos, y eso sigue
// valiendo para lo que llega de las fuentes (su HTML no afirma párrafos); solo
// el texto humano conserva los saltos de línea.
const TEXT_BLOCK_FIELDS = new Set(["biography", "description", "notes"]);

function json(value: unknown): string { return JSON.stringify(value); }
function same(left: unknown, right: unknown): boolean { return json(left) === json(right); }

function normalizeTextBlock(value: string): string {
  return value.normalize("NFC").replace(/\r\n?/gu, "\n").split("\n")
    .map((line) => line.replace(/[^\S\n]+/gu, " ").trim())
    .join("\n").replace(/\n{3,}/gu, "\n\n").trim();
}

/** Valor tal como el merge lo escribiría en la columna del core. */
export function canonicalFieldValue(value: unknown, field: string, actor: "system" | "ai" | "human" = "system"): string | number | boolean | null {
  return scalar(value, field, actor === "human");
}

function scalar(value: unknown, field: string, preserveLineBreaks = false): string | number | boolean | null {
  if (value === null) return null;
  if (INTEGER_FIELDS.has(field)) {
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/\s+/gu, "").replace(/\.0+$/u, ""));
    if (!Number.isInteger(parsed)) throw new Error(`${field} debe ser entero`);
    return parsed;
  }
  if (BOOLEAN_FIELDS.has(field)) {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "1") return true;
    if (value === "false" || value === "0") return false;
    throw new Error(`${field} debe ser boolean`);
  }
  // Algunos extractores históricos emitieron `label`, mientras que el enum
  // canónico usa `record_label`. La mesa muestra ambos como "Sello
  // discográfico"; aplicar esa elección debe escribir el valor válido.
  if (field === "organization_type" && value === "label") return "record_label";
  if (typeof value === "string") {
    return preserveLineBreaks && TEXT_BLOCK_FIELDS.has(field) ? normalizeTextBlock(value) : normalizeDisplayName(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  throw new Error(`${field}: un campo canonico directo debe ser escalar`);
}

function targetResult(spec: EntitySpec, id: number, extra: Partial<MergeOutcome> = {}): Partial<MergeOutcome> {
  return {
    entityKind: spec.kind, entityId: id,
    ...(spec.kind === "artist" ? { artistId: id } : {}),
    ...(spec.kind === "person" ? { personId: id } : {}),
    ...(spec.kind === "album" ? { albumId: id } : {}),
    ...(spec.kind === "track" ? { trackId: id } : {}),
    ...(spec.kind === "organization" ? { organizationId: id } : {}),
    ...extra,
  };
}

function splitIdentity(value: string): string[] {
  return value.split("::").map(normalizeDisplayName).filter(Boolean);
}

function defaultResolutionInput(claim: ClaimToPersist, spec: EntitySpec): ResolutionInput {
  if (claim.resolutionInput) {
    if (claim.resolutionInput.kind !== spec.erKind) throw new Error("resolutionInput no corresponde al entity_kind del claim");
    return claim.resolutionInput;
  }
  const parts = splitIdentity(claim.originalIdentity);
  const rawName = typeof claim.rawValue === "string" && claim.field === spec.identityColumn
    ? claim.rawValue : parts.at(-1) ?? claim.originalIdentity;
  if (spec.kind === "artist") return { kind: "ARTIST", name: rawName };
  if (spec.kind === "person") return { kind: "PERSON", name: rawName };
  if (spec.kind === "organization") return { kind: "ORGANIZATION", name: rawName };
  if (spec.kind === "album") {
    const artistName = parts.length >= 2 ? parts[0] : undefined;
    return {
      kind: "ALBUM", name: rawName,
      ...((claim.parentArtistId === undefined && artistName === undefined) ? {} : {
        artist: { ...(claim.parentArtistId === undefined ? {} : { id: claim.parentArtistId }), ...(artistName === undefined ? {} : { name: artistName }) },
      }),
      ...(claim.field === "release_year" && typeof claim.normalizedValue === "number" ? { year: claim.normalizedValue } : {}),
      ...(claim.field === "album_type" && typeof claim.normalizedValue === "string" ? { releaseType: claim.normalizedValue } : {}),
    };
  }
  const albumName = parts.length >= 2 ? parts.at(-2) : undefined;
  const artistName = parts.length >= 3 ? parts[0] : undefined;
  const parsedTrack = claim.trackNumber ?? (parts.length >= 3 && /^\d+$/u.test(parts.at(-1) ?? "") ? Number(parts.at(-1)) : undefined);
  return {
    kind: "TRACK", name: rawName,
    ...((claim.parentAlbumId === undefined && albumName === undefined) ? {} : {
      album: {
        ...(claim.parentAlbumId === undefined ? {} : { id: claim.parentAlbumId }),
        ...(albumName === undefined ? {} : { name: albumName }),
        ...(artistName === undefined ? {} : { artistName }),
      },
    }),
    ...(claim.discNumber === undefined ? {} : { disc: claim.discNumber }),
    ...(parsedTrack === undefined ? {} : { trackNumber: parsedTrack }),
  };
}

/**
 * ¿Alguna fuente escribió alguna vez este campo de esta entidad? El rastro de
 * merge_audit es la única prueba: si no hay fila, el valor que tiene la
 * columna lo puso el DEFAULT del DDL y no contradice a nadie.
 */
async function wasAsserted(client: PoolClient, spec: EntitySpec, targetId: number, field: string): Promise<boolean> {
  const { rowCount } = await client.query(
    `SELECT 1 FROM ingest.merge_audit WHERE entity_kind=$1::ingest.claim_entity_kind AND ${spec.targetColumn}=$2 AND field=$3 LIMIT 1`,
    [spec.kind, targetId, field]);
  return (rowCount ?? 0) > 0;
}

async function attachClaim(client: PoolClient, claimId: number, spec: EntitySpec, targetId: number, status: "accepted" | "candidate" | "conflict" = "accepted"): Promise<void> {
  await client.query(`UPDATE ingest.claims SET ${spec.targetColumn}=$1,status=$2,updated_at=now() WHERE id=$3`, [targetId, status, claimId]);
}

async function audit(
  client: PoolClient,
  claim: ClaimToPersist,
  claimId: number,
  spec: EntitySpec,
  targetId: number,
  field: string,
  oldValue: unknown,
  newValue: unknown,
  confidence: Confidence,
  reason: string,
): Promise<number> {
  if (same(oldValue, newValue)) throw new Error("merge_audit no admite old_value == new_value");
  const saved = await client.query<{ id: string }>(`
    INSERT INTO ingest.merge_audit(
      run_id,entity_kind,${spec.targetColumn},field,old_value,new_value,reason,confidence,performed_by
    ) VALUES($1,$2::ingest.claim_entity_kind,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9)
    RETURNING id`, [
    claim.runId ?? null, spec.kind, targetId, field,
    oldValue === null ? null : json(oldValue), newValue === null ? null : json(newValue),
    reason, confidence, claim.createdBy ?? "system",
  ]);
  const auditId = saved.rows[0]?.id;
  if (!auditId) throw new Error("no se pudo crear merge_audit");
  await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [auditId, claimId]);
  return Number(auditId);
}

async function lowReview(client: PoolClient, claimId: number, field: string, payload: unknown = {}): Promise<number> {
  const existing = await client.query<{ id: string }>("SELECT id FROM ingest.review_queue WHERE claim_a_id=$1 AND kind='low_confidence' AND status IN ('open','in_progress') ORDER BY id LIMIT 1", [claimId]);
  if (existing.rows[0]?.id) return Number(existing.rows[0].id);
  const saved = await client.query<{ id: string }>(`
    INSERT INTO ingest.review_queue(kind,claim_a_id,priority,payload,notes)
    VALUES('low_confidence',$1,6,$2::jsonb,'Claim low/AI: no modifica el core') RETURNING id`,
  [claimId, json({ field, ...((payload && typeof payload === "object") ? payload as Record<string, unknown> : {}) })]);
  return Number(saved.rows[0]!.id);
}

async function resolutionReview(client: PoolClient, claimId: number, decisionId: number, decision: ResolutionDecision): Promise<number> {
  const kind = decision.aiProposal ? "ai_entity_resolution"
    : decision.kind === "PERSON" ? "person_match"
    : decision.kind === "ORGANIZATION" ? "organization_match"
      : decision.kind === "ALBUM" ? "album_match"
        : decision.kind === "ARTIST" ? "ambiguous_alias" : "manual_review";
  const target = decision.candidateId;
  const columns = {
    person: decision.kind === "PERSON" ? target ?? null : null,
    organization: decision.kind === "ORGANIZATION" ? target ?? null : null,
    album: decision.kind === "ALBUM" ? target ?? null : null,
    track: decision.kind === "TRACK" ? target ?? null : null,
    artist: decision.kind === "ARTIST" ? target ?? null : null,
  };
  const existing = await client.query<{ id: string }>(`
    SELECT id FROM ingest.review_queue WHERE claim_a_id=$1 AND status IN ('open','in_progress')
      AND payload->>'resolutionDecisionId'=$2::text ORDER BY id LIMIT 1`, [claimId, decisionId]);
  if (existing.rows[0]?.id) return Number(existing.rows[0].id);
  const saved = await client.query<{ id: string }>(`
    INSERT INTO ingest.review_queue(
      kind,claim_a_id,priority,person_a_id,organization_a_id,album_id,track_id,artist_a_id,payload,notes
    ) VALUES($1::ingest.review_kind,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,'ER no autorizo auto-merge')
    RETURNING id`, [
    kind, claimId, decision.action === "POSSIBLE_MATCH" ? 7 : 6,
    columns.person, columns.organization, columns.album, columns.track, columns.artist,
    json({ resolutionDecisionId: decisionId, action: decision.action, score: decision.score, explanation: decision.explanation, features: decision.features, aiProposal: decision.aiProposal ?? null, aiFailure: decision.aiFailure ?? null }),
  ]);
  return Number(saved.rows[0]!.id);
}

async function insertAlias(
  client: PoolClient,
  claim: ClaimToPersist,
  claimId: number,
  spec: EntitySpec,
  targetId: number,
  aliasInput: string,
  isPrimary: boolean,
): Promise<"inserted" | "exists" | "ambiguous"> {
  const alias = normalizeDisplayName(aliasInput);
  if (!alias) return "exists";
  const normalized = normalizeEntityName(alias).primaryKey;
  const collision = await client.query<{ target_id: string }>(`
    SELECT ${spec.aliasTargetColumn}::text AS target_id FROM ${spec.aliasTable}
     WHERE normalized_alias=$1 AND ${spec.aliasTargetColumn}<>$2 LIMIT 1`, [normalized, targetId]);
  if (collision.rows[0]) {
    await client.query(`
      INSERT INTO ingest.review_queue(kind,claim_a_id,priority,payload,notes)
      SELECT 'ambiguous_alias',$1,8,$2::jsonb,'El alias ya pertenece a otra entidad; no se aplica'
      WHERE NOT EXISTS(SELECT 1 FROM ingest.review_queue WHERE kind='ambiguous_alias' AND claim_a_id=$1 AND status IN ('open','in_progress'))`,
    [claimId, json({ alias, normalizedAlias: normalized, targetId, conflictingTargetId: Number(collision.rows[0].target_id), entityKind: spec.kind })]);
    return "ambiguous";
  }
  const aliasType = claim.field === "stage_name" ? "stage_name"
    : claim.field === "nickname" ? "other"
      : claim.field === "former_name" ? "former_name"
        : (spec.kind === "album" || spec.kind === "track") ? "alternate_title" : "name_variant";
  const inserted = await client.query(`
    INSERT INTO ${spec.aliasTable}(
      ${spec.aliasTargetColumn},alias,alias_type,normalized_alias,is_primary,confidence,source_id,raw_page_id,claim_id,notes
    ) VALUES($1,$2,$3::ingest.alias_type,$4,$5,$6,$7,$8,$9,'Original conservado; clave normalizada solo para ER')
    ON CONFLICT(${spec.aliasTargetColumn},alias) DO NOTHING`, [
    targetId, alias, aliasType, normalized, isPrimary, claim.confidence,
    claim.sourceId, claim.rawPageId ?? null, claimId,
  ]);
  return inserted.rowCount === 1 ? "inserted" : "exists";
}

async function canonicalName(client: PoolClient, spec: EntitySpec, targetId: number): Promise<string> {
  const result = await client.query<Record<string, unknown>>(`SELECT ${spec.identityColumn} FROM ${spec.table} WHERE id=$1`, [targetId]);
  const value = result.rows[0]?.[spec.identityColumn];
  if (typeof value !== "string") throw new Error(`${spec.kind} ${targetId} inexistente`);
  return value;
}

function explicitDecision(input: ResolutionInput, id: number, canonical: string): ResolutionDecision {
  const explicitFeature: ScoreFeature = {
    key: "target.explicit_fk", label: "destino explicito", value: 1, weight: 1,
    contribution: 1, polarity: "for", evidence: `FK verificada hacia ${id} (${canonical})`,
  };
  return {
    kind: input.kind, inputOriginal: input.name,
    inputNormalized: normalizeEntityName(input.name).primaryKey,
    action: "AUTO_MATCH", score: 1, candidateId: id, features: [explicitFeature],
    candidates: [{ candidateId: id, canonicalName: canonical, score: 1, action: "AUTO_MATCH", features: [explicitFeature], hardConflicts: [], nameBasis: "canonical_exact", hasContextSupport: true, autoEligible: true }],
    thresholds: resolutionThresholdsFromEnv(), explanation: "destino FK explicito y existente", deterministic: true,
  };
}

// `reviewDecisionId` falta cuando la decisión no sale de la Mesa sino de una
// petición directa del operador a la API (crear una ficha homónima a sabiendas).
export type HumanResolutionOverride =
  | { verdict: "same"; targetId: number; reviewDecisionId?: number; decidedBy: string }
  | { verdict: "different"; reviewDecisionId?: number; decidedBy: string };

function humanReference(override: HumanResolutionOverride): string {
  return override.reviewDecisionId === undefined ? "una petición del operador" : `review_decision ${override.reviewDecisionId}`;
}

function humanSameDecision(
  input: ResolutionInput,
  targetId: number,
  canonical: string,
  override: HumanResolutionOverride & { verdict: "same" },
): ResolutionDecision {
  const feature: ScoreFeature = {
    key: "target.human_same", label: "identidad confirmada por una persona", value: 1,
    weight: 1, contribution: 1, polarity: "for",
    evidence: `${override.decidedBy} confirmó (${humanReference(override)}) la identidad contra ${targetId} (${canonical})`,
  };
  return {
    kind: input.kind, inputOriginal: input.name,
    inputNormalized: normalizeEntityName(input.name).primaryKey,
    action: "AUTO_MATCH", score: 1, candidateId: targetId, features: [feature],
    candidates: [{ candidateId: targetId, canonicalName: canonical, score: 1, action: "AUTO_MATCH", features: [feature], hardConflicts: [], nameBasis: "canonical_exact", hasContextSupport: true, autoEligible: true }],
    thresholds: resolutionThresholdsFromEnv(),
    explanation: `match humano desde ${humanReference(override)}`,
    // El shape histórico exige `true`: significa que el registro conserva la
    // salida determinista completa, no quién tuvo la autoridad final. Esa
    // autoridad queda en entity_resolution_decisions.decided_by='human'.
    deterministic: true,
  };
}

function humanDifferentDecision(
  input: ResolutionInput,
  candidates: ResolutionDecision["candidates"],
  override: HumanResolutionOverride & { verdict: "different" },
): ResolutionDecision {
  const feature: ScoreFeature = {
    key: "target.human_different", label: "identidad separada por una persona", value: 1,
    weight: 1, contribution: -1, polarity: "against",
    evidence: `${override.decidedBy} confirmó (${humanReference(override)}) que no es ningún candidato mostrado`,
  };
  return {
    kind: input.kind, inputOriginal: input.name,
    inputNormalized: normalizeEntityName(input.name).primaryKey,
    action: "NO_MATCH", score: 0, features: [feature], candidates,
    thresholds: resolutionThresholdsFromEnv(),
    explanation: `separación humana desde ${humanReference(override)}`,
    deterministic: true,
  };
}

/**
 * Un álbum o una pista nuevos necesitan su parental EXISTIENDO en el core:
 * el modelo no admite un disco sin artista ni una pista sin disco. El nombre
 * del parental viaja en la identidad (`artista::disco::pista`), pero un
 * nombre no es un id, así que se resuelve contra el core y solo se acepta un
 * AUTO_MATCH determinista. Si el parental todavía no fue aprobado, la
 * creación no ocurre y el claim sigue candidato: primero el artista, después
 * el disco, después la pista.
 */
async function resolveParentId(client: PoolClient, input: ResolutionInput): Promise<number | undefined> {
  if (!input.name) return undefined;
  const candidates = await loadResolutionCandidates(input, client);
  const decision = resolveEntityDeterministically(input, candidates, resolutionThresholdsFromEnv());
  return decision.action === "AUTO_MATCH" ? decision.candidateId : undefined;
}

/**
 * El número de pista no viaja en el claim del título, sino en un claim
 * hermano de la misma identidad. Sin él la pista no puede crearse: el core
 * exige (album_id, disc_number, track_number).
 */
async function siblingInteger(client: PoolClient, claim: ClaimToPersist, field: string): Promise<number | undefined> {
  const { rows } = await client.query<{ normalized_value: unknown; raw_value: unknown }>(
    `SELECT normalized_value, raw_value FROM ingest.claims
      WHERE entity_kind=$1 AND identity_key=$2 AND field=$3 AND status IN ('candidate','accepted')
      ORDER BY id LIMIT 1`,
    [claim.entityKind, claim.identity, field],
  );
  const row = rows[0];
  if (!row) return undefined;
  const value = Number(typeof row.normalized_value === "number" || typeof row.normalized_value === "string"
    ? row.normalized_value : row.raw_value);
  return Number.isInteger(value) && value > 0 ? value : undefined;
}

/**
 * Identidad heredada. Cuando un claim crea la entidad, sus hermanos —el año,
 * el género, la duración— llegan después con el mismo identity_key y sin FK,
 * y volver a resolverlos por ER los estrella contra los guardias de
 * homónimos y de contexto: un álbum o una pista recién creados no tienen
 * todavía el contexto que el ER exige para reconocerlos. El resultado era
 * que solo el nombre entraba al catálogo y todo lo demás quedaba candidato.
 *
 * No es una decisión de identidad nueva: es la que ya se tomó y se auditó
 * para esa misma identidad en esa misma fuente. Si apunta a más de una
 * entidad no se elige ninguna y sigue el camino normal del ER.
 */
async function inheritedTarget(client: PoolClient, claim: ClaimToPersist, spec: EntitySpec): Promise<number | undefined> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT DISTINCT ${spec.targetColumn}::text AS id FROM ingest.claims
      WHERE entity_kind=$1 AND identity_key=$2 AND source_id=$3 AND ${spec.targetColumn} IS NOT NULL`,
    [spec.kind, claim.identity, claim.sourceId],
  );
  return rows.length === 1 ? numberFrom(rows[0]!.id) : undefined;
}

function inheritedDecision(input: ResolutionInput, id: number, canonical: string): ResolutionDecision {
  const inherited: ScoreFeature = {
    key: "target.inherited_identity", label: "identidad ya resuelta en esta fuente", value: 1, weight: 1,
    contribution: 1, polarity: "for", evidence: `otro claim de la misma identidad y fuente resolvio a ${id} (${canonical})`,
  };
  return {
    kind: input.kind, inputOriginal: input.name,
    inputNormalized: normalizeEntityName(input.name).primaryKey,
    action: "AUTO_MATCH", score: 1, candidateId: id, features: [inherited],
    candidates: [{ candidateId: id, canonicalName: canonical, score: 1, action: "AUTO_MATCH", features: [inherited], hardConflicts: [], nameBasis: "canonical_exact", hasContextSupport: true, autoEligible: true }],
    thresholds: resolutionThresholdsFromEnv(), explanation: "identidad heredada de un claim hermano ya resuelto y auditado", deterministic: true,
  };
}

async function createEntity(client: PoolClient, claim: ClaimToPersist, claimId: number, spec: EntitySpec, input: ResolutionInput, decisionId: number): Promise<number | undefined> {
  if (claim.field !== spec.identityColumn) return undefined;
  const name = scalar(claim.normalizedValue, claim.field);
  if (typeof name !== "string" || !name) throw new Error(`${spec.kind}.${spec.identityColumn} debe ser texto`);
  let query: string; let params: unknown[];
  if (spec.kind === "artist") { query = "INSERT INTO public.artists(name) VALUES($1) RETURNING id"; params = [name]; }
  else if (spec.kind === "person") { query = "INSERT INTO public.persons(name) VALUES($1) RETURNING id"; params = [name]; }
  else if (spec.kind === "organization") { query = "INSERT INTO public.organizations(name) VALUES($1) RETURNING id"; params = [name]; }
  else if (spec.kind === "album") {
    const artistName = input.kind === "ALBUM" ? input.artist?.name : undefined;
    const artistId = claim.parentArtistId ?? (input.kind === "ALBUM" ? input.artist?.id : undefined)
      ?? (artistName === undefined ? undefined : await resolveParentId(client, { kind: "ARTIST", name: artistName }));
    if (!artistId) return undefined;
    query = "INSERT INTO public.albums(artist_id,title) VALUES($1,$2) RETURNING id"; params = [artistId, name];
  } else {
    const albumRef = input.kind === "TRACK" ? input.album : undefined;
    const albumId = claim.parentAlbumId ?? albumRef?.id
      ?? (albumRef?.name === undefined ? undefined : await resolveParentId(client, {
        kind: "ALBUM", name: albumRef.name,
        ...(albumRef.artistName === undefined ? {} : { artist: { name: albumRef.artistName } }),
      }));
    const disc = claim.discNumber ?? (input.kind === "TRACK" ? input.disc : undefined)
      ?? await siblingInteger(client, claim, "disc_number") ?? 1;
    const track = claim.trackNumber ?? (input.kind === "TRACK" ? input.trackNumber : undefined)
      ?? await siblingInteger(client, claim, "track_number");
    if (!albumId || !track) return undefined;
    // El core impone UNIQUE(album_id, disc_number, track_number). Hay fuentes
    // que repiten la numeración dentro de un mismo disco (las dos caras de un
    // LP suelen empezar en 01). Chocar contra la restricción abortaría toda
    // la aprobación, así que la posición ocupada por otra pista se deja como
    // decisión humana en vez de reventar o de mover el número por cuenta
    // propia.
    const taken = await client.query<{ title: string }>(
      "SELECT title FROM public.tracks WHERE album_id=$1 AND disc_number=$2 AND track_number=$3 LIMIT 1",
      [albumId, disc, track],
    );
    if (taken.rows[0] !== undefined) return undefined;
    query = "INSERT INTO public.tracks(album_id,disc_number,track_number,title) VALUES($1,$2,$3,$4) RETURNING id"; params = [albumId, disc, track, name];
  }
  const saved = await client.query<{ id: string }>(query, params);
  const id = Number(saved.rows[0]?.id);
  if (!id) throw new Error(`no se pudo crear ${spec.kind}`);
  await attachClaim(client, claimId, spec, id);
  await insertAlias(client, claim, claimId, spec, id, name, true);
  await audit(client, claim, claimId, spec, id, spec.identityColumn, null, name, claim.confidence, `new entity after deterministic NO_MATCH; er_decision=${decisionId}`);
  return id;
}

export interface MergeOptions {
  gateway?: DeepSeekGateway;
  humanResolution?: HumanResolutionOverride;
  /**
   * Transacción de quien llama. Sin ella, cada claim abre y confirma la suya.
   * Con ella, el merge no hace BEGIN/COMMIT: la API agrupa todos los claims
   * de una edición y, si uno falla, no queda nada a medias.
   */
  client?: PoolClient;
}

/**
 * Aplica un claim ya persistido dentro de una transaccion. Contradicciones
 * de cualquier confianza se conservan; high no equivale a overwrite.
 */
export async function mergeClaim(
  claim: ClaimToPersist,
  persisted: PersistedClaim,
  options: MergeOptions = {},
): Promise<MergeOutcome> {
  const spec = resolvableSpec(claim.entityKind);
  if (!spec) {
    // Las relaciones tienen su propio puente, con la tabla destino fijada por
    // el entity_kind. Regla dura preservada: album_credit/track_credit no
    // pueden aterrizar en artist_members ni por un rol ambiguo.
    if (isRelationKind(claim.entityKind)) return mergeRelationClaim(claim, persisted.id, options.client);
    // Un arte tampoco es entidad resoluble: se cuelga de una que ya existe.
    if (claim.entityKind === MEDIA_LINK_KIND) return mergeMediaLinkClaim(claim, persisted.id);
    await (options.client ?? getPool()).query("UPDATE ingest.claims SET status='candidate',updated_at=now() WHERE id=$1", [persisted.id]);
    return { action: "unsupported", detail: `merge de ${claim.entityKind} no escribe entidades resolubles; credito != membresia` };
  }
  if (options.client) return mergeEntityClaim(options.client, spec, claim, persisted, options);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const outcome = await mergeEntityClaim(client, spec, claim, persisted, options);
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function mergeEntityClaim(
  client: PoolClient,
  spec: EntitySpec,
  claim: ClaimToPersist,
  persisted: PersistedClaim,
  options: MergeOptions,
): Promise<MergeOutcome> {
  const input = defaultResolutionInput(claim, spec);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`merge:${spec.kind}:${normalizeEntityName(input.name).primaryKey}`]);
  let targetId = claimTargetId(claim, spec);
  if (options.humanResolution?.verdict === "same") {
    if (targetId !== undefined && targetId !== options.humanResolution.targetId) {
      throw new Error(`el claim ${persisted.id} ya apunta a ${targetId}, no a ${options.humanResolution.targetId}`);
    }
    targetId = options.humanResolution.targetId;
  }
  if (targetId === undefined && !persisted.inserted) {
    const attached = await client.query<Record<string, unknown>>(`SELECT ${spec.targetColumn} FROM ingest.claims WHERE id=$1`, [persisted.id]);
    targetId = numberFrom(attached.rows[0]?.[spec.targetColumn]);
  }
  let inherited = false;
  if (targetId === undefined) {
    targetId = await inheritedTarget(client, claim, spec);
    inherited = targetId !== undefined;
  }
  let decision: ResolutionDecision;
  if (targetId !== undefined) {
    const canonical = await canonicalName(client, spec, targetId);
    // La herencia no marca `target.explicit_fk`: una variante de nombre
    // sobre una identidad heredada se conserva como alias, no se trata
    // como propuesta de rename.
    decision = options.humanResolution?.verdict === "same"
      ? humanSameDecision(input, targetId, canonical, options.humanResolution)
      : inherited ? inheritedDecision(input, targetId, canonical) : explicitDecision(input, targetId, canonical);
  } else {
    const candidates = await loadResolutionCandidates(input, client);
    decision = options.humanResolution?.verdict === "different"
      ? humanDifferentDecision(input, candidates.map((candidate) => ({
        candidateId: candidate.id, canonicalName: candidate.canonicalName, score: 0,
        action: "NO_MATCH", features: [], hardConflicts: [], nameBasis: "none",
        hasContextSupport: false, autoEligible: false,
      })), options.humanResolution)
      : await resolveEntity(input, candidates, {
        thresholds: resolutionThresholdsFromEnv(),
        ...(options.gateway === undefined ? {} : { gateway: options.gateway }),
      });
    if (decision.action === "AUTO_MATCH") targetId = decision.candidateId;
  }
  const decisionId = await persistResolutionDecision(decision, input, {
    claimId: persisted.id,
    ...(claim.runId === undefined ? {} : { runId: claim.runId }),
    queryable: client,
    ...(options.humanResolution === undefined ? {} : { decidedBy: "human" as const }),
  });

  // Un claim low automático nunca toca el core: va a revisión y se detiene
  // aquí. La excepción es una decisión humana explícita (createdBy="human",
  // vía review approve), que es la que la guarda de createEntity más abajo
  // ya contemplaba — sin esta salvedad ese `createdBy === "human"` era
  // inalcanzable y ninguna aprobación podía poblar el catálogo.
  if ((claim.createdBy ?? "system") === "ai" || (claim.confidence === "low" && claim.createdBy !== "human")) {
    if (targetId !== undefined) await attachClaim(client, persisted.id, spec, targetId, "candidate");
    else await client.query("UPDATE ingest.claims SET status='candidate',updated_at=now() WHERE id=$1", [persisted.id]);
    await lowReview(client, persisted.id, claim.field, { resolutionDecisionId: decisionId, resolutionAction: decision.action, score: decision.score });
    return { action: "candidate", ...(targetId === undefined ? { entityKind: spec.kind, resolutionDecisionId: decisionId } : targetResult(spec, targetId, { resolutionDecisionId: decisionId })), detail: "claim low/AI enviado a revision; canonical intacto" };
  }

  if (targetId === undefined && decision.action === "NO_MATCH" && (claim.confidence === "high" || claim.createdBy === "human")) {
    const created = await createEntity(client, claim, persisted.id, spec, input, decisionId);
    if (created !== undefined) {
      return { action: "applied", created: true, ...targetResult(spec, created, { resolutionDecisionId: decisionId }), detail: `${spec.kind} nuevo con nombre original conservado y auditado` };
    }
  }
  if (targetId === undefined || decision.action !== "AUTO_MATCH") {
    await client.query("UPDATE ingest.claims SET status='candidate',updated_at=now() WHERE id=$1", [persisted.id]);
    await resolutionReview(client, persisted.id, decisionId, decision);
    return { action: "candidate", resolutionDecisionId: decisionId, detail: `${decision.action}: no se modifica el canonico` };
  }

  await attachClaim(client, persisted.id, spec, targetId, "candidate");
  if (ALIAS_FIELDS.has(claim.field)) {
    const values = Array.isArray(claim.normalizedValue) ? claim.normalizedValue : [claim.normalizedValue];
    let ambiguous = false;
    for (const item of values) {
      if (typeof item !== "string") continue;
      if (await insertAlias(client, claim, persisted.id, spec, targetId, item, false) === "ambiguous") ambiguous = true;
    }
    await attachClaim(client, persisted.id, spec, targetId, ambiguous ? "candidate" : "accepted");
    return { action: ambiguous ? "candidate" : "applied", ...targetResult(spec, targetId, { resolutionDecisionId: decisionId }), detail: ambiguous ? "alias ambiguo enviado a revision" : "alias conservado sin cambiar nombre canonico" };
  }
  const column = spec.fields[claim.field];
  if (!column) {
    if (CONTEXT_FIELDS.has(claim.field)) {
      await attachClaim(client, persisted.id, spec, targetId, "accepted");
      return { action: "unchanged", ...targetResult(spec, targetId, { resolutionDecisionId: decisionId }), detail: "claim contextual aceptado; no representa una columna core" };
    }
    return { action: "unsupported", ...targetResult(spec, targetId, { resolutionDecisionId: decisionId }), detail: `campo ${spec.kind}.${claim.field} no permitido` };
  }
  const currentRow = await client.query<Record<string, unknown>>(`SELECT ${column} FROM ${spec.table} WHERE id=$1 FOR UPDATE`, [targetId]);
  if (!currentRow.rows[0]) throw new Error(`${spec.kind} ${targetId} desaparecio durante merge`);
  const current = currentRow.rows[0][column] ?? null;
  const proposed = scalar(claim.normalizedValue, claim.field, claim.createdBy === "human");

  if (same(current, proposed)) {
    await attachClaim(client, persisted.id, spec, targetId, "accepted");
    return { action: "unchanged", ...targetResult(spec, targetId, { resolutionDecisionId: decisionId }), detail: "valor canonico ya coincide" };
  }
  if (column === spec.identityColumn && typeof current === "string" && typeof proposed === "string") {
    const proposedKey = normalizeEntityName(proposed).primaryKey;
    const knownAlias = await client.query(`SELECT 1 FROM ${spec.aliasTable} WHERE ${spec.aliasTargetColumn}=$1 AND normalized_alias=$2 LIMIT 1`, [targetId, proposedKey]);
    if (normalizeEntityName(current).primaryKey === proposedKey || knownAlias.rowCount === 1) {
      const aliasResult = await insertAlias(client, claim, persisted.id, spec, targetId, proposed, false);
      await attachClaim(client, persisted.id, spec, targetId, aliasResult === "ambiguous" ? "candidate" : "accepted");
      return { action: aliasResult === "ambiguous" ? "candidate" : "unchanged", ...targetResult(spec, targetId, { resolutionDecisionId: decisionId }), detail: "variacion previsible conservada como alias; canonical estable" };
    }
  }
  // Un match por alias/contexto conserva el canonical name y agrega el raw
  // recibido como alias; un target FK explicito con nombre distinto es una
  // propuesta de rename y por ello un conflicto.
  if (column === spec.identityColumn && decision.features.every((item) => item.key !== "target.explicit_fk") && typeof proposed === "string") {
    const aliasResult = await insertAlias(client, claim, persisted.id, spec, targetId, proposed, false);
    await attachClaim(client, persisted.id, spec, targetId, aliasResult === "ambiguous" ? "candidate" : "accepted");
    return { action: aliasResult === "ambiguous" ? "candidate" : "applied", ...targetResult(spec, targetId, { resolutionDecisionId: decisionId }), detail: "variante conservada como alias; canonical name no se reemplazo" };
  }
  if (await hasOpenFieldConflict(client, spec.kind, targetId, claim.field)) {
    const conflict = await createFieldConflict(client, { claimId: persisted.id, kind: spec.kind, targetId, field: claim.field, currentValue: current, proposedValue: proposed });
    return { action: "conflict", ...targetResult(spec, targetId, { resolutionDecisionId: decisionId }), detail: `campo suspendido por conflicto abierto; review=${conflict.reviewId}` };
  }
  // Una contradiccion exige DOS afirmaciones. Varias columnas del core son
  // NOT NULL con DEFAULT —`artists.artist_type` es 'band',
  // `albums.album_type` es 'other'—, asi que `current` nunca es NULL y todo
  // claim de tipo se archivaba como contradiccion contra un valor que
  // ninguna fuente afirmo: lo puso el DDL. `createEntity` solo escribe la
  // columna de identidad, de modo que la ausencia de rastro en merge_audit
  // prueba que ese valor nunca fue afirmado por nadie.
  const asserted = current === null ? false : await wasAsserted(client, spec, targetId, claim.field);
  if (current !== null && asserted) {
    const conflict = await createFieldConflict(client, { claimId: persisted.id, kind: spec.kind, targetId, field: claim.field, currentValue: current, proposedValue: proposed });
    return { action: "conflict", ...targetResult(spec, targetId, { resolutionDecisionId: decisionId }), detail: `contradiccion conservada; review=${conflict.reviewId}` };
  }
  await client.query(`UPDATE ${spec.table} SET ${column}=$1 WHERE id=$2`, [proposed, targetId]);
  await attachClaim(client, persisted.id, spec, targetId, "accepted");
  // El valor anterior va al rastro tal cual estaba, aunque fuera el del
  // DDL: la auditoria dice lo que habia, no lo que se supone que habia.
  await audit(client, claim, persisted.id, spec, targetId, claim.field, current, proposed, claim.confidence,
    current === null ? `non-conflicting fill; er_decision=${decisionId}` : `default del DDL sustituido por la primera afirmacion; er_decision=${decisionId}`);
  return {
    action: "applied", ...targetResult(spec, targetId, { resolutionDecisionId: decisionId }),
    detail: current === null ? "campo vacio completado y auditado" : "default del DDL completado con la primera afirmacion de una fuente",
  };
}

/** Compatibilidad para el runner actual: solo retorna matches auto deterministas. */
export async function resolveArtistId(identity: string): Promise<number | undefined> {
  const input: ResolutionInput = { kind: "ARTIST", name: identity };
  const candidates = await loadResolutionCandidates(input);
  const decision = resolveEntityDeterministically(input, candidates, resolutionThresholdsFromEnv());
  return decision.action === "AUTO_MATCH" ? decision.candidateId : undefined;
}

export type ConflictResolution = "resolved_a" | "resolved_b" | "both_kept" | "dismissed";

export interface RepeatedTrackResolution {
  conflictId: number;
  originalTrackId: number;
  repeatedTrackId: number;
  repeatedPosition: number;
  claimsMoved: number;
}

/**
 * Resuelve el caso en que dos ocurrencias reales del mismo título fueron
 * fusionadas por una identidad antigua basada solo en el nombre. La posición
 * y la evidencia capturada distinguen las ocurrencias; ambas se conservan.
 */
export async function keepRepeatedTrackOccurrences(
  conflictIds: number[],
  options: { actor: "human"; note: string; runId?: number },
): Promise<RepeatedTrackResolution[]> {
  if (options.actor !== "human") throw new Error("la resolución de pistas repetidas requiere actor human");
  if (!options.note.trim()) throw new Error("resolution note obligatoria");
  if (!conflictIds.length || conflictIds.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new Error("conflictIds inválidos");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const results: RepeatedTrackResolution[] = [];
    for (const conflictId of [...new Set(conflictIds)]) {
      const loaded = await client.query<{
        claim_a_id: string; claim_b_id: string; value_a: unknown; value_b: unknown;
        status: string; track_id: string; album_id: string; disc_number: number;
        track_number: number; title: string; source_id: string; raw_page_id: string | null;
        seed_upload_id: string | null; identity_key: string; evidence_position: number | null;
        evidence_url: string | null;
      }>(`
        SELECT cf.claim_a_id::text,cf.claim_b_id::text,cf.value_a,cf.value_b,cf.status::text,
               b.track_id::text,t.album_id::text,t.disc_number,t.track_number,t.title,
               b.source_id::text,b.raw_page_id::text,b.seed_upload_id::text,b.identity_key,
               ev.position AS evidence_position,ev.url AS evidence_url
          FROM ingest.conflicts cf
          JOIN ingest.claims b ON b.id=cf.claim_b_id
          JOIN public.tracks t ON t.id=b.track_id
          LEFT JOIN LATERAL (
            SELECT position,url FROM ingest.claim_evidence WHERE claim_id=b.id ORDER BY id LIMIT 1
          ) ev ON true
         WHERE cf.id=$1 AND cf.entity_kind='track' AND cf.field='track_number'
         FOR UPDATE OF cf,t`, [conflictId]);
      const row = loaded.rows[0];
      if (!row) throw new Error(`conflicto de número de pista inexistente: ${conflictId}`);
      if (row.status !== "open") throw new Error(`conflicto ${conflictId} ya no está abierto (${row.status})`);
      const originalPosition = Number(row.value_a);
      const repeatedPosition = Number(row.value_b);
      if (!Number.isInteger(originalPosition) || !Number.isInteger(repeatedPosition)
        || originalPosition !== row.track_number || repeatedPosition <= 0 || repeatedPosition === originalPosition) {
        throw new Error(`conflicto ${conflictId} no representa dos posiciones válidas de la misma pista`);
      }
      if (row.evidence_position === null) throw new Error(`claim ${row.claim_b_id} no conserva posición de evidencia`);
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`merge:track:${row.album_id}:${row.disc_number}:${repeatedPosition}`]);
      const occupied = await client.query<{ id: string; title: string }>(
        "SELECT id::text,title FROM tracks WHERE album_id=$1 AND disc_number=$2 AND track_number=$3",
        [Number(row.album_id), row.disc_number, repeatedPosition]);
      if (occupied.rows[0]) throw new Error(`posición ${repeatedPosition} ya ocupada por ${occupied.rows[0].title} (track ${occupied.rows[0].id})`);
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO public.tracks(album_id,disc_number,track_number,title)
        VALUES($1,$2,$3,$4) RETURNING id::text`,
      [Number(row.album_id), row.disc_number, repeatedPosition, row.title]);
      const repeatedTrackId = Number(inserted.rows[0]!.id);

      const siblings = await client.query<{ id: string }>(`
        SELECT DISTINCT c.id::text
          FROM ingest.claims c JOIN ingest.claim_evidence e ON e.claim_id=c.id
         WHERE c.entity_kind='track' AND c.source_id=$1
           AND c.raw_page_id IS NOT DISTINCT FROM $2::bigint
           AND c.seed_upload_id IS NOT DISTINCT FROM $3::bigint
           AND c.identity_key=$4 AND e.position=$5
           AND e.url IS NOT DISTINCT FROM $6`, [
        Number(row.source_id), row.raw_page_id, row.seed_upload_id, row.identity_key,
        row.evidence_position, row.evidence_url,
      ]);
      const claimIds = siblings.rows.map((item) => Number(item.id));
      if (!claimIds.includes(Number(row.claim_b_id))) throw new Error(`no se pudo reconstruir la ocurrencia del claim ${row.claim_b_id}`);
      await client.query("UPDATE ingest.claims SET track_id=$1,status='accepted',updated_at=now() WHERE id=ANY($2::bigint[])", [repeatedTrackId, claimIds]);
      await client.query("UPDATE ingest.claims SET status='accepted',updated_at=now() WHERE id=$1", [Number(row.claim_a_id)]);
      const spec = resolvableSpec("track")!;
      await audit(client, { runId: options.runId, createdBy: "human" } as ClaimToPersist,
        Number(row.claim_b_id), spec, repeatedTrackId, "title", null, row.title, "high",
        `human repeated-track resolution; positions ${originalPosition} and ${repeatedPosition}: ${options.note}`);
      await client.query(`
        UPDATE ingest.conflicts SET status='both_kept',resolved_by='human',resolution_note=$2,resolved_at=now()
         WHERE id=$1`, [conflictId, options.note]);
      await client.query(`
        UPDATE ingest.review_queue SET status='approved',resolved_by='human',resolution_note=$2,resolved_at=now(),updated_at=now()
         WHERE (conflict_id=$1 OR claim_a_id=ANY($3::bigint[])) AND status IN ('open','in_progress')`,
      [conflictId, options.note, claimIds]);
      await client.query(`
        UPDATE ingest.review_decisions d SET status='withdrawn',withdrawn_at=now(),note=concat_ws(E'\n',d.note,$2::text)
         WHERE d.status='active' AND d.review_id IN (
           SELECT id FROM ingest.review_queue WHERE conflict_id=$1
         )`, [conflictId, `Sustituida por resolución both_kept: ${options.note}`]);
      results.push({ conflictId, originalTrackId: Number(row.track_id), repeatedTrackId, repeatedPosition, claimsMoved: claimIds.length });
    }
    await client.query("COMMIT");
    return results;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

/** Solo una decision humana puede cerrar un conflicto y, si corresponde, escribir core. */
export async function resolveFieldConflict(
  conflictId: number,
  resolution: ConflictResolution,
  options: { actor: "human"; note: string; runId?: number; client?: PoolClient },
): Promise<void> {
  if (options.actor !== "human") throw new Error("la resolucion de conflictos requiere actor human");
  if (!options.note.trim()) throw new Error("resolution note obligatoria");
  if (options.client) {
    await resolveFieldConflictWith(options.client, conflictId, resolution, options);
    return;
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await resolveFieldConflictWith(client, conflictId, resolution, options);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

async function resolveFieldConflictWith(
  client: PoolClient,
  conflictId: number,
  resolution: ConflictResolution,
  options: { note: string; runId?: number },
): Promise<void> {
  const loaded = await client.query<Record<string, unknown>>(`
    SELECT c.*,a.${"artist_id"} AS a_artist_id,a.person_id AS a_person_id,a.album_id AS a_album_id,a.track_id AS a_track_id,a.organization_id AS a_organization_id,
      b.artist_id AS b_artist_id,b.person_id AS b_person_id,b.album_id AS b_album_id,b.track_id AS b_track_id,b.organization_id AS b_organization_id
    FROM ingest.conflicts c JOIN ingest.claims a ON a.id=c.claim_a_id JOIN ingest.claims b ON b.id=c.claim_b_id
    WHERE c.id=$1 AND c.status='open' FOR UPDATE`, [conflictId]);
  const row = loaded.rows[0];
  if (!row) throw new Error(`conflicto abierto inexistente: ${conflictId}`);
  const kind = row["entity_kind"] as ResolvableClaimKind;
  const spec = resolvableSpec(kind);
  if (!spec) throw new Error(`conflicto ${kind} no resoluble por este motor`);
  const prefix = resolution === "resolved_b" ? "b" : "a";
  const targetId = numberFrom(row[`${prefix}_${spec.targetColumn}`]);
  if (!targetId) throw new Error("claims del conflicto no comparten un target valido");
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`merge:${kind}:${targetId}:${String(row["field"])}`]);
  if (resolution === "resolved_a" || resolution === "resolved_b") {
    const selectedClaimId = Number(row[resolution === "resolved_a" ? "claim_a_id" : "claim_b_id"]);
    const rejectedClaimId = Number(row[resolution === "resolved_a" ? "claim_b_id" : "claim_a_id"]);
    const chosen = row[resolution === "resolved_a" ? "value_a" : "value_b"];
    const field = String(row["field"]); const column = spec.fields[field];
    if (!column) throw new Error(`campo de conflicto no escribible: ${kind}.${field}`);
    const current = (await client.query<Record<string, unknown>>(`SELECT ${column} FROM ${spec.table} WHERE id=$1 FOR UPDATE`, [targetId])).rows[0]?.[column] ?? null;
    if (!same(current, chosen)) {
      await client.query(`UPDATE ${spec.table} SET ${column}=$1 WHERE id=$2`, [chosen, targetId]);
      const syntheticClaim = {
        runId: options.runId, createdBy: "human", confidence: "high",
      } as ClaimToPersist;
      await audit(client, syntheticClaim, selectedClaimId, spec, targetId, field, current, chosen, "high", `human conflict resolution ${resolution}: ${options.note}`);
    }
    await client.query("UPDATE ingest.claims SET status='accepted',updated_at=now() WHERE id=$1", [selectedClaimId]);
    await client.query("UPDATE ingest.claims SET status='superseded',updated_at=now() WHERE id=$1", [rejectedClaimId]);
  }
  await client.query(`
    UPDATE ingest.conflicts SET status=$2::ingest.conflict_status,resolved_by='human',resolution_note=$3,resolved_at=now() WHERE id=$1`,
  [conflictId, resolution, options.note]);
  await client.query(`
    UPDATE ingest.review_queue SET status=CASE WHEN $2='dismissed' THEN 'dismissed'::ingest.review_status ELSE 'approved'::ingest.review_status END,
      resolved_by='human',resolution_note=$3,resolved_at=now(),updated_at=now()
    WHERE conflict_id=$1 AND status IN ('open','in_progress')`, [conflictId, resolution, options.note]);
}

export interface HumanFieldOverride {
  /** Claim humano ya persistido con la FK de la entidad y el valor elegido. */
  claim: ClaimToPersist;
  claimId: number;
  kind: ResolvableClaimKind;
  targetId: number;
  field: string;
  note: string;
}

export interface HumanFieldOverrideResult {
  changed: boolean;
  oldValue: unknown;
  newValue: unknown;
  /** Conflictos abiertos del campo que esta decisión cerró. */
  conflictsClosed: number[];
  supersededClaims: number[];
  reviewsClosed: number;
}

/**
 * Corrección humana de un valor ya afirmado. `mergeClaim` nunca sobrescribe
 * (una fuente high tampoco): deja el conflicto abierto para una persona. Esto
 * es lo que hace esa persona cuando el valor correcto es uno que ella afirma,
 * sea uno de los rivales o ninguno de ellos.
 *
 * Nada se borra: el valor anterior queda en merge_audit, los claims que
 * afirmaban otro valor pasan a `superseded`, cada conflicto abierto del campo
 * se cierra como resolved_a/resolved_b si la corrección coincide con uno de
 * sus lados (o `dismissed` si no coincide con ninguno) y sus revisiones se
 * aprueban con la nota. Corre en la transacción de quien llama.
 */
export async function overrideFieldByHuman(client: PoolClient, input: HumanFieldOverride): Promise<HumanFieldOverrideResult> {
  if (input.claim.createdBy !== "human") throw new Error("solo una decisión humana sustituye un valor afirmado");
  if (!input.note.trim()) throw new Error("nota obligatoria para sustituir un valor");
  const spec = ENTITY_SPECS[input.kind];
  const column = spec.fields[input.field];
  if (!column) throw new Error(`campo ${input.kind}.${input.field} no escribible`);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`merge:${input.kind}:${input.targetId}:${input.field}`]);
  const loaded = await client.query<Record<string, unknown>>(`SELECT ${column} FROM ${spec.table} WHERE id=$1 FOR UPDATE`, [input.targetId]);
  if (!loaded.rows[0]) throw new Error(`${input.kind} ${input.targetId} inexistente`);
  const current = loaded.rows[0][column] ?? null;
  const proposed = scalar(input.claim.normalizedValue, input.field, true);
  const changed = !same(current, proposed);
  const reason = `corrección humana: ${input.note}`;
  if (changed) {
    await client.query(`UPDATE ${spec.table} SET ${column}=$1 WHERE id=$2`, [proposed, input.targetId]);
    // El nombre nuevo también identifica a la entidad; el anterior ya es alias.
    if (column === spec.identityColumn && typeof proposed === "string") {
      await insertAlias(client, input.claim, input.claimId, spec, input.targetId, proposed, false);
    }
    await audit(client, input.claim, input.claimId, spec, input.targetId, input.field, current, proposed, "high", reason);
  }
  await attachClaim(client, input.claimId, spec, input.targetId, "accepted");

  // Igualdad de valores para decidir qué lado ganó: la forma de una fuente
  // (texto colapsado) y la humana (con párrafos) se comparan sin saltos.
  const comparable = (value: unknown): string => {
    try { return json(scalar(value, input.field)); } catch { return json(value); }
  };
  const chosen = comparable(proposed);

  const rivals = await client.query<{ id: string; status: string; normalized_value: unknown; raw_value: unknown }>(`
    SELECT id::text,status::text,normalized_value,raw_value FROM ingest.claims
     WHERE ${spec.targetColumn}=$1 AND field=$2 AND id<>$3 AND status IN ('accepted','conflict','candidate')`,
  [input.targetId, input.field, input.claimId]);
  const supersededClaims: number[] = [];
  for (const rival of rivals.rows) {
    if (comparable(rival.normalized_value ?? rival.raw_value) === chosen) {
      if (rival.status === "conflict") {
        await client.query("UPDATE ingest.claims SET status='accepted',updated_at=now() WHERE id=$1", [Number(rival.id)]);
      }
    } else {
      supersededClaims.push(Number(rival.id));
    }
  }
  if (supersededClaims.length) {
    await client.query("UPDATE ingest.claims SET status='superseded',updated_at=now() WHERE id=ANY($1::bigint[])", [supersededClaims]);
  }

  const open = await client.query<{ id: string; value_a: unknown; value_b: unknown }>(`
    SELECT c.id::text,c.value_a,c.value_b FROM ingest.conflicts c
      JOIN ingest.claims a ON a.id=c.claim_a_id JOIN ingest.claims b ON b.id=c.claim_b_id
     WHERE c.status='open' AND c.entity_kind=$1::ingest.claim_entity_kind AND c.field=$2
       AND (a.${spec.targetColumn}=$3 OR b.${spec.targetColumn}=$3)
     FOR UPDATE OF c`, [input.kind, input.field, input.targetId]);
  const conflictsClosed: number[] = [];
  for (const conflict of open.rows) {
    const status = comparable(conflict.value_a) === chosen ? "resolved_a"
      : comparable(conflict.value_b) === chosen ? "resolved_b" : "dismissed";
    await client.query(`
      UPDATE ingest.conflicts SET status=$2::ingest.conflict_status,resolved_by='human',resolved_at=now(),
             resolution_note=$3 WHERE id=$1`,
    [Number(conflict.id), status, `sustituido por la corrección humana del claim ${input.claimId}: ${input.note}`]);
    conflictsClosed.push(Number(conflict.id));
  }
  const reviews = await client.query(`
    UPDATE ingest.review_queue SET status='approved',resolved_by='human',resolution_note=$1,resolved_at=now(),updated_at=now()
     WHERE status IN ('open','in_progress') AND kind='field_conflict'
       AND (conflict_id=ANY($2::bigint[]) OR claim_a_id=ANY($3::bigint[]) OR claim_b_id=ANY($3::bigint[])
            OR (payload->>'entityKind'=$4 AND payload->>'targetId'=$5 AND payload->>'field'=$6))`,
  [reason, conflictsClosed, [input.claimId, ...rivals.rows.map((row) => Number(row.id))], input.kind, String(input.targetId), input.field]);
  return { changed, oldValue: current, newValue: proposed, conflictsClosed, supersededClaims, reviewsClosed: reviews.rowCount ?? 0 };
}

function numberFrom(value: unknown): number | undefined {
  const result = Number(value);
  return Number.isFinite(result) && result > 0 ? result : undefined;
}
