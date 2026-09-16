// Servicio de fusión de fichas con previsualización (PHASES E11.3; generalizado
// a organizaciones y artistas en E11.10; plan P2).
//
// Una persona decide qué ficha queda y con qué campos; este módulo convierte
// esa decisión en una transacción del operador: previsualización con hash
// (nadie fusiona sobre un estado que no vio), correcciones de campo como
// claims humanos, `mergeInto` para mover referencias y la unificación de
// créditos y membresías equivalentes.
//
// Es el MISMO camino para personas, organizaciones y artistas: lo que cambia
// por kind sale de `ENTITY_SPECS` (tabla, columna destino, alias y campos) y de
// las reglas de vacío del motor (`MERGE_EMPTY_RULES`), para que la
// previsualización no prometa nada que la fusión no vaya a hacer.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { mergeInto, MERGE_EMPTY_VALUES, MERGE_TABLES } from "../review/duplicates.js";
import { looksLikeOrganization, nameWithoutNickname, surnameToken } from "../review/person-names.js";
import { mergeEquivalentCredits, mergeEquivalentMemberships } from "./equivalent-relations.js";
import { OperatorError, updateEntity, type OperatorContext } from "./operator.js";
import { resolveRedirect } from "./redirects.js";
import { ENTITY_SPECS } from "./specs.js";

/** Entidades con ficha propia, alias y navegación: las únicas que se fusionan con previsualización. */
export type MergeableKind = "person" | "organization" | "artist";
export const MERGEABLE_KINDS: readonly MergeableKind[] = ["person", "organization", "artist"];

/**
 * Campos que la previsualización compara y sobre los que ofrece elegir. Se
 * derivan de los specs de entidad (una sola lista de campos por kind) quitando
 * la identidad: así no hay dos listas que puedan separarse.
 */
export const MERGE_FIELDS: Readonly<Record<MergeableKind, readonly string[]>> = MERGEABLE_KINDS.reduce(
  (acc, kind) => {
    const spec = ENTITY_SPECS[kind];
    acc[kind] = Object.keys(spec.fields).filter((field) => field !== spec.identityColumn);
    return acc;
  },
  {} as Record<MergeableKind, readonly string[]>,
);

export type EntityMergeField = string;

export interface MergeSide {
  id: number;
  name: string;
  fields: Record<string, unknown>;
  aliases: string[];
  /**
   * Referencias de la ficha, con los mismos nombres en las tres entidades:
   * `bands` = membresías (persona) o membresías del artista (artista);
   * `albumCredits`/`trackCredits` = créditos; `organizations` = vínculos con
   * organizaciones (persona) o personas vinculadas (organización).
   */
  counts: { bands: number; albumCredits: number; trackCredits: number; organizations: number; claims: number };
}

export interface EntityMergePreview {
  kind: MergeableKind;
  keep: MergeSide;
  drop: MergeSide;
  /** Sugerencia: la ficha con más referencias; a igualdad, la de id menor. */
  recommendedKeepId: number;
  /** Ambos lados tienen valor y difieren: la persona elige. */
  fieldConflicts: Array<{ field: EntityMergeField; keepValue: unknown; dropValue: unknown }>;
  /** Vacío en `keep` y presente en `drop`: se completa solo. */
  fieldsFilledFromDrop: EntityMergeField[];
  /** Membresías compartidas (solo personas: el resto de entidades no tiene bandas). */
  sharedBands: Array<{ id: number; name: string }>;
  sharedAlbums: Array<{ id: number; title: string }>;
  /** Alias de `drop` que `keep` no tiene ya; se moverán al fusionar. */
  aliasesToAdd: string[];
  /** Revisiones de review_queue que carean las dos fichas. */
  reviewsBetween: number[];
  warnings: string[];
  previewHash: string;
}

export interface EntityMergeRequest {
  kind: MergeableKind;
  keepId: number;
  dropId: number;
  previewHash: string;
  /** Solo para campos de `fieldConflicts`. Si falta, gana `keep`. */
  fieldChoices?: Partial<Record<EntityMergeField, "keep" | "drop">> | undefined;
  keepDropNameAsAlias: boolean;
}

export interface EntityMergeResult {
  kind: MergeableKind;
  keepId: number;
  dropId: number;
  auditId: number;
  moved: number;
  discarded: number;
  filled: string[];
  fieldsCorrected: EntityMergeField[];
  creditsMerged: number;
  membershipsMerged: number;
}

/** `false` en is_venezuelan es el DEFAULT del core («nadie lo dijo»); el resto vacío es NULL. */
function present(kind: MergeableKind, field: string, value: unknown): boolean {
  const empty = MERGE_EMPTY_VALUES[`${MERGE_TABLES[kind]}.${field}`];
  if (empty === undefined) return value !== null && value !== undefined;
  if (typeof empty === "boolean") return value === !empty;
  return value !== null && value !== undefined && value !== empty;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * «Referencias» de una ficha: lo que se movería al fusionarla. Los claims son
 * evidencia, no referencias, y no cuentan para elegir la ficha que queda.
 */
function referenceCount(counts: MergeSide["counts"]): number {
  return counts.bands + counts.albumCredits + counts.trackCredits + counts.organizations;
}

/** Contadores por kind: cada entidad mide lo suyo con los nombres comunes. */
async function countRelations(queryable: Pick<PoolClient, "query">, kind: MergeableKind, id: number): Promise<MergeSide["counts"]> {
  const spec = ENTITY_SPECS[kind];
  const column = spec.targetColumn;
  const bands = kind === "person"
    ? "(SELECT count(*) FROM public.artist_members WHERE person_id=$1)::text"
    : kind === "artist" ? "(SELECT count(*) FROM public.artist_members WHERE artist_id=$1)::text" : "'0'";
  const organizations = kind === "person"
    ? "(SELECT count(*) FROM public.person_organizations WHERE person_id=$1)::text"
    : kind === "organization" ? "(SELECT count(*) FROM public.person_organizations WHERE organization_id=$1)::text" : "'0'";
  const { rows } = await queryable.query<{ bands: string; album_credits: string; track_credits: string; organizations: string; claims: string }>(`
    SELECT ${bands} AS bands,
           (SELECT count(*) FROM public.album_credits WHERE ${column}=$1)::text AS album_credits,
           (SELECT count(*) FROM public.track_credits WHERE ${column}=$1)::text AS track_credits,
           ${organizations} AS organizations,
           (SELECT count(*) FROM ingest.claims WHERE ${column}=$1)::text AS claims`, [id]);
  const counted = rows[0]!;
  return {
    bands: Number(counted.bands), albumCredits: Number(counted.album_credits),
    trackCredits: Number(counted.track_credits), organizations: Number(counted.organizations),
    claims: Number(counted.claims),
  };
}

async function loadSide(queryable: Pick<PoolClient, "query">, kind: MergeableKind, id: number, lock: boolean): Promise<MergeSide | null> {
  const spec = ENTITY_SPECS[kind];
  const { rows } = await queryable.query<{ row: Record<string, unknown> | null }>(
    `SELECT to_jsonb(t) AS row FROM ${spec.table} t WHERE t.id=$1${lock ? " FOR UPDATE" : ""}`, [id]);
  const row = rows[0]?.row;
  if (!row) return null;
  const fields = Object.fromEntries(MERGE_FIELDS[kind].map((field) => [field, row[field] ?? null]));
  const aliases = (await queryable.query<{ alias: string }>(
    `SELECT alias FROM ${spec.aliasTable} WHERE ${spec.aliasTargetColumn}=$1 ORDER BY alias`, [id])).rows.map((item) => item.alias);
  return {
    id, name: String(row[spec.identityColumn]), fields, aliases,
    counts: await countRelations(queryable, kind, id),
  };
}

async function sideOrThrow(queryable: Pick<PoolClient, "query">, kind: MergeableKind, id: number, lock: boolean): Promise<MergeSide> {
  const side = await loadSide(queryable, kind, id, lock);
  if (side) return side;
  const details: Record<string, unknown> = { entity: kind, id };
  const moved = await resolveRedirect(kind, id, queryable);
  if (moved) details["movedTo"] = moved;
  throw new OperatorError("not_found", `${kind} ${id} inexistente`, details);
}

/** Bandas en las que las dos personas comparten membresía (solo personas). */
async function sharedBands(queryable: Pick<PoolClient, "query">, keepId: number, dropId: number) {
  return (await queryable.query<{ id: string; name: string }>(`
    SELECT DISTINCT ar.id::text AS id, ar.name AS name
      FROM public.artist_members k
      JOIN public.artist_members d ON d.artist_id=k.artist_id AND d.person_id=$2
      JOIN public.artists ar ON ar.id=k.artist_id
     WHERE k.person_id=$1
     ORDER BY ar.name`, [keepId, dropId])).rows.map((row) => ({ id: Number(row.id), name: row.name }));
}

/** Discos en los que las dos fichas tienen crédito (de disco o de pista). */
async function sharedAlbums(queryable: Pick<PoolClient, "query">, column: string, keepId: number, dropId: number) {
  return (await queryable.query<{ id: string; title: string }>(`
    SELECT al.id::text AS id, al.title AS title
      FROM (
        SELECT c1.album_id AS album_id FROM public.album_credits c1
          JOIN public.album_credits c2 ON c2.album_id=c1.album_id AND c2.${column}=$2
         WHERE c1.${column}=$1
        UNION
        SELECT t.album_id FROM public.track_credits tc1
          JOIN public.track_credits tc2 ON tc2.track_id=tc1.track_id AND tc2.${column}=$2
          JOIN public.tracks t ON t.id=tc1.track_id
         WHERE tc1.${column}=$1
      ) shared
      JOIN public.albums al ON al.id=shared.album_id
     ORDER BY al.title`, [keepId, dropId])).rows.map((row) => ({ id: Number(row.id), title: row.title }));
}

/**
 * Previsualiza la fusión: qué se completaría, qué se contradice, qué comparten
 * y qué avisos merece. No escribe nada. Con `lock`, bloquea ambas filas
 * (`FOR UPDATE`) para fusionar sobre un estado que nadie más puede cambiar.
 */
export async function previewEntityMerge(
  queryable: Pick<PoolClient, "query">, kind: MergeableKind, keepId: number, dropId: number,
  options: { lock?: boolean } = {},
): Promise<EntityMergePreview> {
  if (keepId === dropId) throw new OperatorError("invalid", "no se puede fusionar una ficha consigo misma", { entity: kind, id: keepId });
  const lock = options.lock ?? false;
  const keep = await sideOrThrow(queryable, kind, keepId, lock);
  const drop = await sideOrThrow(queryable, kind, dropId, lock);
  const fields = MERGE_FIELDS[kind];

  const fieldConflicts: EntityMergePreview["fieldConflicts"] = [];
  const fieldsFilledFromDrop: EntityMergeField[] = [];
  for (const field of fields) {
    const keepPresent = present(kind, field, keep.fields[field]);
    const dropPresent = present(kind, field, drop.fields[field]);
    if (!keepPresent && dropPresent) fieldsFilledFromDrop.push(field);
    else if (keepPresent && dropPresent && !sameValue(keep.fields[field], drop.fields[field])) {
      fieldConflicts.push({ field, keepValue: keep.fields[field], dropValue: drop.fields[field] });
    }
  }

  const warnings: string[] = [];
  if (kind === "person") {
    for (const field of ["birth_date", "death_date"]) {
      if (present(kind, field, keep.fields[field]) && present(kind, field, drop.fields[field])
        && !sameValue(keep.fields[field], drop.fields[field])) {
        warnings.push("Fechas distintas: probablemente son dos personas.");
        break;
      }
    }
    const keepSurname = surnameToken(keep.name);
    const dropSurname = surnameToken(drop.name);
    if (keepSurname && dropSurname && keepSurname !== dropSurname) warnings.push("Los apellidos no coinciden.");
    if (looksLikeOrganization(keep.name) || looksLikeOrganization(drop.name)) {
      warnings.push("Parece una organización: considera convertirla en lugar de fusionar.");
    }
  }
  if (referenceCount(drop.counts) > referenceCount(keep.counts)) warnings.push("La ficha que desaparece es la más completa.");

  const keepKeys = new Set([nameWithoutNickname(keep.name), ...keep.aliases.map((alias) => nameWithoutNickname(alias))]);
  const aliasesToAdd = drop.aliases.filter((alias) => !keepKeys.has(nameWithoutNickname(alias)));
  const columns = kind === "person" ? ["person_a_id", "person_b_id"] : [`${kind}_a_id`, `${kind}_b_id`];
  const reviewsBetween = (await queryable.query<{ id: string }>(`
    SELECT id::text FROM ingest.review_queue
     WHERE (${columns[0]}=$1 AND ${columns[1]}=$2) OR (${columns[0]}=$2 AND ${columns[1]}=$1)
     ORDER BY id`, [keepId, dropId])).rows.map((row) => Number(row.id));

  const bands = kind === "person" ? await sharedBands(queryable, keepId, dropId) : [];
  const albums = await sharedAlbums(queryable, ENTITY_SPECS[kind].targetColumn, keepId, dropId);

  const previewHash = createHash("sha256").update(JSON.stringify([
    kind, keep.fields, keep.name, keep.aliases, keep.counts,
    drop.fields, drop.name, drop.aliases, drop.counts,
  ])).digest("hex");

  return {
    kind, keep, drop,
    recommendedKeepId: referenceCount(keep.counts) >= referenceCount(drop.counts) ? keep.id : drop.id,
    fieldConflicts, fieldsFilledFromDrop, sharedBands: bands, sharedAlbums: albums,
    aliasesToAdd, reviewsBetween, warnings, previewHash,
  };
}

export interface MergeEntityRowsResult {
  auditId: number;
  moved: number;
  discarded: number;
  filled: string[];
  creditsMerged: number;
  membershipsMerged: number;
  /** Membresías con períodos contradictorios que quedaron a revisión humana (solo personas). */
  membershipReviewsOpened: number;
}

/**
 * Fusión física de dos filas: `mergeInto` más la unificación de las relaciones
 * equivalentes del kind. La comparten el servicio (API) y la corrección por
 * plan JSON (CLI), para que no existan dos caminos distintos.
 */
export async function mergeEntityRows(
  client: PoolClient, kind: MergeableKind, keepId: number, dropId: number, note: string, runId: number, alias: boolean,
): Promise<MergeEntityRowsResult> {
  const spec = ENTITY_SPECS[kind];
  const outcome = await mergeInto(client, kind, keepId, dropId, note, runId, { alias });
  // `MergeableKind` solo tiene fichas navegables: la columna destino es una de estas tres.
  const creditsMerged = await mergeEquivalentCredits(
    client, { column: spec.targetColumn as "person_id" | "artist_id" | "organization_id", id: keepId }, note, runId);
  const memberships = kind === "person"
    ? await mergeEquivalentMemberships(client, keepId, note, runId)
    : { merged: 0, reviewsOpened: 0 };
  return {
    auditId: outcome.auditId, moved: outcome.moved, discarded: outcome.discarded,
    filled: outcome.filled, creditsMerged, membershipsMerged: memberships.merged,
    membershipReviewsOpened: memberships.reviewsOpened,
  };
}

/**
 * Fusiona una ficha en otra dentro de la transacción del operador. No hace
 * COMMIT: lo hace `withOperatorRun` cuando todo salió bien.
 */
export async function mergeEntities(context: OperatorContext, request: EntityMergeRequest): Promise<EntityMergeResult> {
  const { kind, keepId, dropId } = request;
  await context.client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");
  const preview = await previewEntityMerge(context.client, kind, keepId, dropId, { lock: true });
  if (preview.previewHash !== request.previewHash) {
    throw new OperatorError("stale_preview", "la ficha cambió desde la previsualización", {
      entity: kind, keepId, dropId, previewHash: preview.previewHash,
    });
  }
  const fieldsCorrected: EntityMergeField[] = [];
  for (const conflict of preview.fieldConflicts) {
    if (request.fieldChoices?.[conflict.field] !== "drop") continue;
    // El valor del duplicado se afirma como corrección humana: claim, auditoría
    // y cierre de conflictos, exactamente como si se hubiera tecleado.
    await updateEntity(context, kind, keepId, { [conflict.field]: conflict.dropValue });
    fieldsCorrected.push(conflict.field);
  }
  const merged = await mergeEntityRows(context.client, kind, keepId, dropId, context.note, context.runId, request.keepDropNameAsAlias);
  return {
    kind, keepId, dropId, auditId: merged.auditId, moved: merged.moved, discarded: merged.discarded,
    filled: merged.filled, fieldsCorrected, creditsMerged: merged.creditsMerged, membershipsMerged: merged.membershipsMerged,
  };
}
