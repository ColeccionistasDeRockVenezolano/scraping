// Ediciones del operador (PHASES §E7B, ARCHITECTURE §4.14).
//
// La API no escribe el core: traduce cada petición a claims
// `created_by=human, confidence=high` de una fuente propia (`crv-operador`) y
// los pasa por el mismo merge que la ingesta. Este módulo solo compone piezas
// del motor; ninguna regla de merge vive aquí ni en los controllers.
//
//  * UNA PETICIÓN, UNA TRANSACCIÓN, UN RUN. Todo lo que pide una edición
//    (el nombre, el año, el tipo...) entra junto o no entra. El run `manual`
//    guarda quién, qué y por qué; cada fila de merge_audit apunta a él.
//  * EL MERGE DECIDE PRIMERO. Rellenar un campo vacío, reconocer un alias o
//    detectar un homónimo es trabajo del motor. Solo cuando el valor afirmado
//    por la persona no queda en el core (había otro afirmado, o el motor lo
//    guardó como alias) se aplica la corrección humana, que cierra los
//    conflictos del campo y conserva el valor anterior en la auditoría.
//  * CREAR NO ES RECONOCER. Si el ER dice que la entidad ya existe, la
//    petición falla con su id; `allowSimilar` es la decisión humana explícita
//    de crear una ficha distinta de los candidatos.
import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { persistClaim, type ClaimTargets, type ClaimToPersist, type RelationEndpoints } from "../claims/persistence.js";
import { normalizeIdentity } from "../normalization/claims.js";
import { canonicalFieldValue, mergeClaim, overrideFieldByHuman } from "./engine.js";
import { ENTITY_SPECS, type EntitySpec, type ResolvableClaimKind } from "./specs.js";
import {
  RELATION_SPECS, RelationEndpointMissingError, RelationRowMissingError, correctRelationField, editableRelationFields,
  type RelationClaimKind,
} from "./relations.js";
import { DependentsError, removeEntity, removeRelation, type RemovalResult } from "./removals.js";

export const OPERATOR_SOURCE_SLUG = "crv-operador";

export type OperatorErrorCode = "not_found" | "already_exists" | "needs_review" | "has_dependents" | "not_open" | "invalid";

/** Fallo esperado de una edición: la API lo traduce a 404/409/422. */
export class OperatorError extends Error {
  constructor(readonly code: OperatorErrorCode, message: string, readonly details?: Record<string, unknown>) {
    super(message);
  }
}

export interface OperatorContext {
  client: PoolClient;
  runId: number;
  sourceId: number;
  operator: string;
  note: string;
}

export interface OperatorAction {
  name: string;
  operator: string;
  note: string;
  params?: Record<string, unknown>;
}

/**
 * Abre la transacción y el run de una petición. Si `work` falla, no queda
 * nada: ni claims, ni auditoría, ni el run.
 */
export async function withOperatorRun<T>(
  action: OperatorAction,
  work: (context: OperatorContext) => Promise<T>,
): Promise<{ runId: number; result: T }> {
  const note = action.note.trim();
  if (!note) throw new OperatorError("invalid", "nota obligatoria");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
      VALUES($1,'Operador del catálogo (API)','database','high',false,
             'Altas y correcciones humanas hechas por la API de escritura (E7B). Nunca se raspa.')
      ON CONFLICT (slug) DO NOTHING`, [OPERATOR_SOURCE_SLUG]);
    const source = await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [OPERATOR_SOURCE_SLUG]);
    const sourceId = Number(source.rows[0]!.id);
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind,source_id,status,params) VALUES('manual',$1,'running',$2::jsonb) RETURNING id::text`,
    [sourceId, JSON.stringify({ action: action.name, operator: action.operator, note, ...action.params })]);
    const runId = Number(run.rows[0]!.id);
    const result = await work({ client, runId, sourceId, operator: action.operator, note });
    await client.query("UPDATE ingest.scrape_runs SET status='ok',finished_at=now() WHERE id=$1", [runId]);
    await client.query("COMMIT");
    return { runId, result };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

let claimSequence = 0;

/** Claim humano de la fuente del operador. El hash incluye el run: repetir una edición deja historia. */
function humanClaim(
  context: OperatorContext,
  input: {
    entityKind: ClaimToPersist["entityKind"]; identityKey: string; label: string; field: string; value: unknown;
    targets?: ClaimTargets; extra?: Partial<ClaimToPersist>;
  },
): ClaimToPersist {
  claimSequence += 1;
  const value = input.value === undefined ? null : input.value;
  const rawHash = createHash("sha256")
    .update(JSON.stringify([input.entityKind, input.identityKey, input.field, value, context.runId, claimSequence]))
    .digest("hex");
  return {
    entityKind: input.entityKind,
    identity: input.identityKey,
    identitySecondary: input.identityKey,
    originalIdentity: input.label,
    field: input.field,
    rawValue: value,
    normalizedValue: value,
    rawHash,
    extractor: "api-operador",
    extractorVersion: "1",
    evidence: {
      url: `crv-api://operator-runs/${context.runId}`,
      excerpt: `${context.operator}: ${input.field}=${JSON.stringify(value)} — ${context.note}`.slice(0, 1000),
    },
    sourceId: context.sourceId,
    runId: context.runId,
    confidence: "high",
    createdBy: "human",
    ...input.targets,
    ...input.extra,
  };
}

const ENTITY_TARGET_KEY = {
  artist: "artistId", person: "personId", organization: "organizationId", album: "albumId", track: "trackId",
} as const satisfies Record<ResolvableClaimKind, keyof ClaimTargets>;

const RELATION_TARGET_KEY = {
  artist_membership: "artistMembershipId", person_organization: "personOrganizationId",
  album_credit: "albumCreditId", track_credit: "trackCreditId", album_format: "albumFormatId",
} as const satisfies Record<RelationClaimKind, keyof ClaimTargets>;

export interface FieldWrite {
  field: string;
  /** applied: el merge lo escribió; unchanged: ya estaba; corrected: sustituyó un valor afirmado. */
  action: "applied" | "unchanged" | "corrected";
  conflictsClosed: number[];
}

export interface EntityWriteResult {
  kind: ResolvableClaimKind;
  id: number;
  fields: FieldWrite[];
}

function storedEquals(stored: string | null, wanted: string | number | boolean | null): boolean {
  return stored === null ? wanted === null : wanted !== null && stored === String(wanted);
}

/**
 * `settle`: la persona está resolviendo un conflicto, no solo afirmando un
 * valor. Aunque el core ya diga lo mismo, la corrección se aplica para que los
 * rivales queden sustituidos y el conflicto cerrado.
 */
async function writeField(
  context: OperatorContext, spec: EntitySpec, targetId: number, identityKey: string, label: string,
  field: string, value: unknown, settle = false,
): Promise<FieldWrite> {
  const column = spec.fields[field];
  if (!column) throw new OperatorError("invalid", `campo ${spec.kind}.${field} no editable`);
  let wanted: string | number | boolean | null;
  try {
    wanted = canonicalFieldValue(value, field, "human");
  } catch (error) {
    throw new OperatorError("invalid", (error as Error).message);
  }
  const claim = humanClaim(context, {
    entityKind: spec.kind, identityKey, label, field, value, targets: { [ENTITY_TARGET_KEY[spec.kind]]: targetId },
  });
  const persisted = await persistClaim(claim, context.client);
  const outcome = await mergeClaim(claim, persisted, { client: context.client });
  if (outcome.action === "unsupported") throw new OperatorError("invalid", outcome.detail);
  const stored = await context.client.query<{ value: string | null }>(`SELECT ${column}::text AS value FROM ${spec.table} WHERE id=$1`, [targetId]);
  if (!settle && storedEquals(stored.rows[0]?.value ?? null, wanted)) {
    return { field, action: outcome.action === "applied" ? "applied" : "unchanged", conflictsClosed: [] };
  }
  const override = await overrideFieldByHuman(context.client, {
    claim, claimId: persisted.id, kind: spec.kind, targetId, field, note: context.note,
  });
  return { field, action: override.changed || outcome.action === "applied" ? "corrected" : "unchanged", conflictsClosed: override.conflictsClosed };
}

/** Resuelve un conflicto de campo con el valor que afirma la persona (uno de los rivales u otro). */
export async function settleEntityField(
  context: OperatorContext, kind: ResolvableClaimKind, id: number, field: string, value: unknown,
): Promise<FieldWrite> {
  const spec = ENTITY_SPECS[kind];
  const label = await currentLabel(context, spec, id);
  return writeField(context, spec, id, `operador:${kind}:${id}`, label, field, value, true);
}

async function currentLabel(context: OperatorContext, spec: EntitySpec, id: number): Promise<string> {
  const { rows } = await context.client.query<{ label: string }>(`SELECT ${spec.identityColumn} AS label FROM ${spec.table} WHERE id=$1`, [id]);
  if (!rows[0]) throw new OperatorError("not_found", `${spec.kind} ${id} inexistente`, { entity: spec.kind, id });
  return rows[0].label;
}

export interface CreateEntityOptions {
  /** Decisión humana: crear aunque el ER vea candidatos parecidos. */
  allowSimilar?: boolean;
  /** Álbum: artista del que cuelga. */
  artistId?: number;
  /** Pista: disco del que cuelga. */
  albumId?: number;
}

/**
 * Alta de una entidad. El nombre entra primero (es el claim que crea la
 * ficha); el resto de campos se escriben después sobre el id ya creado.
 */
export async function createEntity(
  context: OperatorContext, kind: ResolvableClaimKind, values: Record<string, unknown>, options: CreateEntityOptions = {},
): Promise<EntityWriteResult> {
  const spec = ENTITY_SPECS[kind];
  const name = values[spec.identityColumn];
  if (typeof name !== "string" || !name.trim()) throw new OperatorError("invalid", `${spec.identityColumn} obligatorio`);

  let extra: Partial<ClaimToPersist> = {};
  if (kind === "album") {
    if (options.artistId === undefined) throw new OperatorError("invalid", "artistId obligatorio para crear un álbum");
    await currentLabel(context, ENTITY_SPECS.artist, options.artistId);
    extra = { parentArtistId: options.artistId };
  } else if (kind === "track") {
    if (options.albumId === undefined) throw new OperatorError("invalid", "albumId obligatorio para crear una pista");
    await currentLabel(context, ENTITY_SPECS.album, options.albumId);
    const trackNumber = Number(values["track_number"]);
    const discNumber = values["disc_number"] === undefined ? 1 : Number(values["disc_number"]);
    if (!Number.isInteger(trackNumber) || trackNumber <= 0 || !Number.isInteger(discNumber) || discNumber <= 0) {
      throw new OperatorError("invalid", "track_number (y disc_number, si se indica) deben ser enteros positivos");
    }
    const taken = await context.client.query<{ id: string; title: string }>(
      "SELECT id::text,title FROM public.tracks WHERE album_id=$1 AND disc_number=$2 AND track_number=$3",
      [options.albumId, discNumber, trackNumber]);
    if (taken.rows[0]) {
      throw new OperatorError("already_exists", `la posición ${discNumber}-${trackNumber} ya la ocupa «${taken.rows[0].title}»`,
        { existingId: Number(taken.rows[0].id) });
    }
    extra = { parentAlbumId: options.albumId, discNumber, trackNumber };
  }

  const identityKey = `${normalizeIdentity(name)}#operador-${randomUUID()}`;
  const claim = humanClaim(context, { entityKind: kind, identityKey, label: name, field: spec.identityColumn, value: name, extra });
  const persisted = await persistClaim(claim, context.client);
  const outcome = await mergeClaim(claim, persisted, {
    client: context.client,
    ...(options.allowSimilar ? { humanResolution: { verdict: "different" as const, decidedBy: context.operator } } : {}),
  });
  if (outcome.action !== "applied" || !outcome.created || outcome.entityId === undefined) {
    if (outcome.entityId !== undefined) {
      throw new OperatorError("already_exists", `${kind} ya existe en el catálogo (id ${outcome.entityId})`, {
        existingId: outcome.entityId,
      });
    }
    throw new OperatorError("needs_review", `el catálogo no autoriza crear ${kind} «${name}»: ${outcome.detail}`, {
      ...(outcome.resolutionDecisionId === undefined ? {} : { resolutionDecisionId: outcome.resolutionDecisionId }),
      hint: "hay candidatos parecidos; allowSimilar=true crea la ficha como distinta a sabiendas",
    });
  }
  const id = outcome.entityId;
  const fields: FieldWrite[] = [{ field: spec.identityColumn, action: "applied", conflictsClosed: [] }];
  for (const [field, value] of Object.entries(values)) {
    if (field === spec.identityColumn || value === undefined) continue;
    if (kind === "track" && (field === "track_number" || field === "disc_number")) continue;
    fields.push(await writeField(context, spec, id, identityKey, name, field, value));
  }
  return { kind, id, fields };
}

/** Corrección de campos de una entidad existente. */
export async function updateEntity(
  context: OperatorContext, kind: ResolvableClaimKind, id: number, values: Record<string, unknown>,
): Promise<EntityWriteResult> {
  const spec = ENTITY_SPECS[kind];
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw new OperatorError("invalid", "no hay campos que cambiar");
  const label = await currentLabel(context, spec, id);
  const identityKey = `operador:${kind}:${id}`;
  // El nombre al final: sus claims hermanos no dependen de él, y así un
  // rename ambiguo no bloquea el resto de la corrección.
  entries.sort(([left], [right]) => Number(left === spec.identityColumn) - Number(right === spec.identityColumn));
  const fields: FieldWrite[] = [];
  for (const [field, value] of entries) fields.push(await writeField(context, spec, id, identityKey, label, field, value));
  return { kind, id, fields };
}

async function recordRemoval(context: OperatorContext, removal: RemovalResult): Promise<void> {
  await context.client.query(
    "UPDATE ingest.scrape_runs SET params=COALESCE(params,'{}'::jsonb) || jsonb_build_object('removed',$2::jsonb) WHERE id=$1",
    [context.runId, JSON.stringify(removal)]);
}

function dependentsError(error: DependentsError): OperatorError {
  return new OperatorError("has_dependents", error.message, { dependents: error.dependents });
}

export async function deleteEntity(context: OperatorContext, kind: ResolvableClaimKind, id: number): Promise<RemovalResult> {
  let removal: RemovalResult | null;
  try {
    removal = await removeEntity(context.client, kind, id, { note: context.note, runId: context.runId });
  } catch (error) {
    if (error instanceof DependentsError) throw dependentsError(error);
    throw error;
  }
  if (!removal) throw new OperatorError("not_found", `${kind} ${id} inexistente`, { entity: kind, id });
  await recordRemoval(context, removal);
  return removal;
}

/** Campo que materializa la relación: el resto son sus hermanos. */
const PRIMARY_FIELD: Readonly<Record<RelationClaimKind, string>> = {
  artist_membership: "role", person_organization: "role",
  album_credit: "credit_role", track_credit: "credit_role", album_format: "format",
};

export interface RelationWriteResult {
  kind: RelationClaimKind;
  id: number;
  /** false: la misma relación ya estaba registrada y se devuelve la existente. */
  created: boolean;
}

/**
 * Alta de una fila puente con los extremos elegidos por id. Cada campo es un
 * claim hermano de la misma identidad; el puente los lee juntos.
 */
export async function createRelation(
  context: OperatorContext, kind: RelationClaimKind, endpoints: RelationEndpoints,
  values: Record<string, string | number | boolean | null | undefined>,
): Promise<RelationWriteResult> {
  const identityKey = `operador:${kind}:${randomUUID()}`;
  const label = `${kind} (${context.operator})`;
  const primary = PRIMARY_FIELD[kind];
  let primaryClaim: { claim: ClaimToPersist; id: number } | undefined;
  for (const [field, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    // El puente lee texto: los años y las banderas viajan como cadena.
    const claim = humanClaim(context, { entityKind: kind, identityKey, label, field, value: String(value), extra: { endpoints } });
    const persisted = await persistClaim(claim, context.client);
    if (field === primary) primaryClaim = { claim, id: persisted.id };
  }
  if (!primaryClaim) throw new OperatorError("invalid", `${primary} obligatorio`);
  let outcome;
  try {
    outcome = await mergeClaim(primaryClaim.claim, { id: primaryClaim.id, inserted: true }, { client: context.client });
  } catch (error) {
    if (error instanceof RelationEndpointMissingError) {
      throw new OperatorError("invalid", error.message, { entity: error.entityKind, id: error.entityId });
    }
    if (error instanceof Error && !("code" in error)) throw new OperatorError("invalid", error.message);
    throw error;
  }
  const id = outcome.relationIds?.[0];
  if (outcome.action === "candidate" || id === undefined) throw new OperatorError("needs_review", outcome.detail);
  return { kind, id, created: outcome.action === "applied" };
}

export interface RelationUpdateResult {
  kind: RelationClaimKind;
  id: number;
  fields: Array<{ field: string; action: "corrected" | "unchanged" }>;
}

export async function updateRelation(
  context: OperatorContext, kind: RelationClaimKind, id: number, values: Record<string, unknown>,
): Promise<RelationUpdateResult> {
  const spec = RELATION_SPECS[kind];
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length === 0) throw new OperatorError("invalid", "no hay campos que cambiar");
  const editable = new Set(editableRelationFields(kind));
  const fields: RelationUpdateResult["fields"] = [];
  for (const [field, value] of entries) {
    if (!editable.has(field)) throw new OperatorError("invalid", `campo ${kind}.${field} no editable`);
    const claim = humanClaim(context, {
      entityKind: kind, identityKey: `operador:${kind}:${id}`, label: `${spec.table} ${id}`, field, value,
      targets: { [RELATION_TARGET_KEY[kind]]: id },
    });
    try {
      const persisted = await persistClaim(claim, context.client);
      const result = await correctRelationField(context.client, { kind, id, field, value, claim, claimId: persisted.id, note: context.note });
      fields.push({ field, action: result.changed ? "corrected" : "unchanged" });
    } catch (error) {
      // La FK del claim hacia una fila inexistente la rechaza PostgreSQL (23503).
      if (error instanceof RelationRowMissingError || (error as { code?: string }).code === "23503") {
        throw new OperatorError("not_found", `${kind} ${id} inexistente`, { entity: kind, id });
      }
      if (error instanceof Error && !("code" in error)) throw new OperatorError("invalid", error.message);
      throw error;
    }
  }
  return { kind, id, fields };
}

export async function deleteRelation(context: OperatorContext, kind: RelationClaimKind, id: number): Promise<RemovalResult> {
  const removal = await removeRelation(context.client, kind, id, { note: context.note, runId: context.runId });
  if (!removal) throw new OperatorError("not_found", `${kind} ${id} inexistente`, { entity: kind, id });
  await recordRemoval(context, removal);
  return removal;
}
