// Puente de relaciones: convierte claims de tipo relación en filas de las
// tablas puente del core. Es el único módulo que escribe artist_members,
// person_organizations, album_credits, track_credits y album_formats, y lo
// hace bajo cuatro reglas fijas:
//
//   1. Una relación NUNCA crea sus extremos. Si el artista, la persona, el
//      álbum o la pista no existen todavía en el core, el claim se queda en
//      `candidate` y abre revisión: primero se aprueba la entidad, después
//      la relación. Nunca al revés.
//   2. La tabla destino está fijada por el entity_kind del claim, no por el
//      contenido del rol. Un crédito de disco no puede aterrizar en
//      artist_members ni por error de mapeo ni por un rol ambiguo: es
//      estructuralmente imposible (CONTRACT, regla dura).
//   3. Igual que las entidades, un claim `low` automático no escribe. Solo
//      una decisión humana explícita (createdBy="human", vía review approve
//      o la API del operador) materializa la relación.
//   4. La unidad es el registro completo, no el campo suelto: los claims
//      hermanos se leen juntos. Si dos contradicen un campo no se elige
//      ninguno — elegir sería inventar una decisión que nadie tomó.
//
// A diferencia del merge de entidades, la compuerta `low` se evalúa ANTES de
// resolver los extremos: una relación candidata no tiene nada a lo que
// engancharse, así que gastar una decisión de ER por cada uno de sus campos
// solo produciría ruido en er_decisions.
//
// EXTREMOS EXPLÍCITOS. Cuando una persona ya eligió los extremos por id (la
// API del operador), el claim los trae en `endpoints`: se verifica que existan
// y se usan tal cual, igual que el merge de entidades trata una FK explícita.
// `person_organization` y `album_format` no llegan de ninguna fuente, así que
// solo se materializan de esta forma.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import type { ClaimToPersist, Confidence } from "../claims/persistence.js";
import type { MergeOutcome } from "./engine.js";
import { normalizeDisplayName } from "../normalization/entity-name.js";
import { normalizeIdentity } from "../normalization/claims.js";
import { loadResolutionCandidates, persistResolutionDecision } from "../er/repository.js";
import { resolveEntity, resolutionThresholdsFromEnv } from "../er/resolver.js";
import type { ResolutionInput } from "../er/types.js";

export const RELATION_KINDS = ["artist_membership", "person_organization", "album_credit", "track_credit", "album_format"] as const;
export type RelationClaimKind = (typeof RELATION_KINDS)[number];

export function isRelationKind(kind: string): kind is RelationClaimKind {
  return (RELATION_KINDS as readonly string[]).includes(kind);
}

export type RelationColumn =
  | "artist_membership_id" | "person_organization_id" | "album_credit_id" | "track_credit_id" | "album_format_id";

export interface RelationSpec {
  kind: RelationClaimKind;
  /** Tabla puente del core. Fija por tipo: aquí vive la regla dura. */
  table: string;
  /** Columna FK homónima en ingest.claims y en ingest.merge_audit. */
  column: RelationColumn;
  /** Entidad de la que cuelga la fila: su ficha conserva la historia si la fila se retira. */
  parent: { kind: "artist" | "person" | "album" | "track"; column: "artist_id" | "person_id" | "album_id" | "track_id" };
}

export const RELATION_SPECS: Readonly<Record<RelationClaimKind, RelationSpec>> = {
  artist_membership: { kind: "artist_membership", table: "public.artist_members", column: "artist_membership_id", parent: { kind: "artist", column: "artist_id" } },
  person_organization: { kind: "person_organization", table: "public.person_organizations", column: "person_organization_id", parent: { kind: "person", column: "person_id" } },
  album_credit: { kind: "album_credit", table: "public.album_credits", column: "album_credit_id", parent: { kind: "album", column: "album_id" } },
  track_credit: { kind: "track_credit", table: "public.track_credits", column: "track_credit_id", parent: { kind: "track", column: "track_id" } },
  album_format: { kind: "album_format", table: "public.album_formats", column: "album_format_id", parent: { kind: "album", column: "album_id" } },
};

export const CREDIT_TYPES = [
  "musician", "guest", "writer", "composer", "producer", "recording",
  "mixing", "mastering", "photography", "artwork", "other",
] as const;
export type CreditType = (typeof CREDIT_TYPES)[number];

function isCreditType(value: string | undefined): value is CreditType {
  return value !== undefined && (CREDIT_TYPES as readonly string[]).includes(value);
}

/** Un extremo explícito que no existe: es un error de quien pide, no una revisión pendiente. */
export class RelationEndpointMissingError extends Error {
  constructor(readonly entityKind: string, readonly entityId: number) {
    super(`${entityKind} ${entityId} inexistente`);
  }
}

// El rol crudo se conserva íntegro en la columna `role`; credit_type es solo
// la clasificación gruesa del enum del core. Las reglas se evalúan en orden:
// la primera que coincide gana, y lo específico va antes que lo genérico.
const CREDIT_TYPE_RULES: ReadonlyArray<readonly [RegExp, CreditType]> = [
  [/(master(ing|ed|izaci[oó]n|izado)?)\b/iu, "mastering"],
  [/(mix(ing|ed|es)?\b|mezcl)/iu, "mixing"],
  [/(record(ing|ed)\b|grabaci[oó]n|grabado|ingenier|engineer|sonidista)/iu, "recording"],
  [/(produc)/iu, "producer"],
  [/(compos|m[uú]sica de|autor de la m[uú]sica)/iu, "composer"],
  [/(letra|lyric|writ(er|ten)|escrit|texto)/iu, "writer"],
  [/(photo|foto)/iu, "photography"],
  [/(art\s?work|dise[nñ]|design|portada|cover\s*art|ilustra|illustrat|gr[aá]fic)/iu, "artwork"],
  [/(guest|invitad|especial|special)/iu, "guest"],
];

// Instrumentos y voces: cualquier rol de ejecución es `musician`. La lista
// cubre lo que aparece en las fichas (inglés y español); lo que no encaja se
// clasifica `other` en vez de forzarse a músico.
const MUSICIAN_ROLE =
  /(guitar|guitarra|bass|bajo|drum|bater|percussion|percusi|vocal|voz|voces|voice|sing|cant|keyboard|teclad|piano|organ|[oó]rgano|synth|sintetiz|sax|trumpet|trompeta|tromb[oó]n|trombone|flute|flauta|clarinet|oboe|viol[ií]n|violin|viola|cello|chelo|contrabajo|harp|arpa|harmonica|arm[oó]nica|accordion|acorde[oó]n|banjo|mandolin|cuatro|maracas|conga|timbal|bong[oó]|charrasca|tambor|coro|chorus|backing|palmas|int[eé]rprete|interpret|performer|ejecuta)/iu;

// En la foto y el arte el texto del rol no añade nada: "Photos", "Photography
// by" y "Fotografía" dicen lo mismo, y "Graphic Design & Illustrations" y
// "Artwork & Illustration" también. Ahí, dos créditos de la misma persona en el
// mismo disco son uno. En los demás tipos el rol sí distingue: "Guitar" y
// "Bass" son dos créditos, "Produced by" y "Executive Production" también;
// solo se ignora la preposición final, tildes, mayúsculas y signos.
const ROLE_AGNOSTIC_TYPES: ReadonlySet<CreditType> = new Set(["photography", "artwork"]);

/** Tipos cuyo texto de rol no distingue un crédito de otro (foto y arte). */
export function isRoleAgnosticCreditType(type: CreditType): boolean {
  return ROLE_AGNOSTIC_TYPES.has(type);
}

/** Clave con la que dos créditos del mismo acreditado y la misma obra son el mismo. */
export function creditEquivalenceKey(creditType: CreditType, role: string): string {
  if (ROLE_AGNOSTIC_TYPES.has(creditType)) return creditType;
  const normalized = role.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase()
    .replace(/\s+(?:by|at|por|en)\s*:?\s*$/u, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  return `${creditType}:${normalized}`;
}

/** Clasificación determinista del rol en el enum credit_type del core. */
export function creditTypeForRole(role: string): CreditType {
  const value = role.trim();
  if (!value) return "other";
  for (const [pattern, type] of CREDIT_TYPE_RULES) if (pattern.test(value)) return type;
  return MUSICIAN_ROLE.test(value) ? "musician" : "other";
}

interface RelationFields {
  get(field: string): string | undefined;
  claimIds: number[];
  /** Campos con más de un valor distinto entre los claims vivos. */
  contradicted: string[];
}

/**
 * Una relación es el registro completo, no un campo suelto: cada claim
 * hermano aporta una pieza (artist_name, person_name, role, ...). Se leen
 * todos los del mismo (entity_kind, identity_key) vivos.
 *
 * Si dos claims dan valores distintos para el mismo campo no se elige uno:
 * elegir sería inventar una decisión que ninguna fuente tomó. El campo queda
 * marcado como contradicho y la relación entera va a revisión humana.
 */
async function gatherFields(client: PoolClient, entityKind: string, identityKey: string): Promise<RelationFields> {
  const { rows } = await client.query<{ id: string; field: string; normalized_value: unknown; raw_value: unknown }>(
    `SELECT id::text, field, normalized_value, raw_value
       FROM ingest.claims
      WHERE entity_kind=$1 AND identity_key=$2 AND status IN ('candidate','accepted')
      ORDER BY id`,
    [entityKind, identityKey],
  );
  const values = new Map<string, string>();
  const contradicted = new Set<string>();
  const claimIds: number[] = [];
  for (const row of rows) {
    claimIds.push(Number(row.id));
    const value = typeof row.normalized_value === "string" && row.normalized_value.trim()
      ? row.normalized_value
      : typeof row.raw_value === "string" ? row.raw_value : undefined;
    if (value === undefined) continue;
    const text = normalizeDisplayName(value);
    if (!text) continue;
    const previous = values.get(row.field);
    if (previous === undefined) values.set(row.field, text);
    else if (previous.toLowerCase() !== text.toLowerCase()) contradicted.add(row.field);
  }
  return { get: (field) => values.get(field), claimIds, contradicted: [...contradicted] };
}

interface Endpoint {
  id?: number;
  decisionId?: number;
  action: string;
  name: string;
  /** Cómo se resolvió: heredado del claim graph, decidido por el ER o elegido por id. */
  via: "claim" | "er" | "explicit";
  ambiguous?: boolean;
}

const CLAIM_TARGET_COLUMN = {
  artist: "artist_id", person: "person_id", organization: "organization_id",
  album: "album_id", track: "track_id",
} as const;

type EntityClaimKind = keyof typeof CLAIM_TARGET_COLUMN;

const ENDPOINT_TABLE: Readonly<Record<EntityClaimKind, { table: string; name: "name" | "title" }>> = {
  artist: { table: "public.artists", name: "name" },
  person: { table: "public.persons", name: "name" },
  organization: { table: "public.organizations", name: "name" },
  album: { table: "public.albums", name: "title" },
  track: { table: "public.tracks", name: "title" },
};

/** Extremo elegido por id: se verifica y se usa sin pasar por el ER. */
async function explicitEndpoint(client: PoolClient, kind: EntityClaimKind, id: number): Promise<Endpoint> {
  const { table, name } = ENDPOINT_TABLE[kind];
  const { rows } = await client.query<{ name: string }>(`SELECT ${name} AS name FROM ${table} WHERE id=$1`, [id]);
  if (!rows[0]) throw new RelationEndpointMissingError(kind, id);
  return { id, action: "EXPLICIT", name: rows[0].name, via: "explicit" };
}

/**
 * Resolución heredada. El extremo de una relación no es un nombre suelto que
 * haya que volver a identificar en todo el catálogo: es la MISMA entidad que
 * el claim hermano de esta fuente ya resolvió y auditó. Reusar esa decisión
 * es más exacto que repetir el ER — y es lo único que puede funcionar para
 * una persona recién creada, cuya trayectoria en el core está vacía justo
 * porque esta membresía todavía no existe.
 *
 * Se restringe a la misma fuente: dos homónimos de una misma fuente ya se
 * habrían unificado aguas arriba (comparten identity_key), así que el puente
 * no introduce una decisión de identidad nueva, hereda la que ya se tomó. Si
 * la misma identidad apunta a más de una entidad, no se elige: va a revisión.
 */
async function resolveFromClaims(
  client: PoolClient, kind: EntityClaimKind, identityKey: string, sourceId: number,
): Promise<{ id?: number; ambiguous: boolean }> {
  const column = CLAIM_TARGET_COLUMN[kind];
  const { rows } = await client.query<{ id: string }>(
    `SELECT DISTINCT ${column}::text AS id FROM ingest.claims
      WHERE entity_kind=$1 AND identity_key=$2 AND source_id=$3 AND ${column} IS NOT NULL`,
    [kind, identityKey, sourceId],
  );
  if (rows.length === 1) return { id: Number(rows[0]!.id), ambiguous: false };
  return { ambiguous: rows.length > 1 };
}

/**
 * Resuelve un extremo contra el core: primero el claim graph de la fuente,
 * y si no hay herencia, el ER. Del ER solo cuenta un AUTO_MATCH: la relación
 * no propone entidades nuevas ni acepta un POSSIBLE_MATCH.
 */
async function resolveEndpoint(
  client: PoolClient,
  claim: ClaimToPersist,
  claimId: number,
  input: ResolutionInput,
  claimKind: EntityClaimKind,
  identityCandidates: string[],
): Promise<Endpoint> {
  for (const identity of identityCandidates) {
    const inherited = await resolveFromClaims(client, claimKind, normalizeIdentity(identity), claim.sourceId);
    if (inherited.ambiguous) return { action: "AMBIGUOUS", name: input.name, via: "claim", ambiguous: true };
    if (inherited.id !== undefined) return { id: inherited.id, action: "INHERITED", name: input.name, via: "claim" };
  }
  const candidates = await loadResolutionCandidates(input, client);
  const decision = await resolveEntity(input, candidates, { thresholds: resolutionThresholdsFromEnv() });
  const decisionId = await persistResolutionDecision(decision, input, {
    claimId, ...(claim.runId === undefined ? {} : { runId: claim.runId }), queryable: client,
  });
  return {
    ...(decision.action === "AUTO_MATCH" && decision.candidateId !== undefined ? { id: decision.candidateId } : {}),
    decisionId, action: decision.action, name: input.name, via: "er",
  };
}

export type CreditedKind = "person" | "organization" | "artist";

function isCreditedKind(value: string | undefined): value is CreditedKind {
  return value === "person" || value === "organization" || value === "artist";
}

type CreditedColumn = "person_id" | "organization_id" | "artist_id";
/** Sin `column`, el acreditado no existe en el core y `endpoint` dice por qué. */
type CreditedTarget = { column: CreditedColumn; endpoint: Endpoint } | { column?: undefined; endpoint: Endpoint };

/**
 * Extremo acreditado: persona, organización o banda, en ese orden — salvo que
 * la fuente diga de qué tipo es, en cuyo caso se prueba SOLO ese.
 *
 * El orden por defecto es una conjetura razonable cuando no hay más dato,
 * pero deja de serlo en un recopilatorio: ahí lo acreditado en cada pista es
 * el GRUPO que la toca, y probar primero `person` puede engancharla a un
 * homónimo. Cuando la fuente lo afirma —`credited_kind`— no se conjetura.
 */
async function resolveCredited(
  client: PoolClient,
  claim: ClaimToPersist,
  claimId: number,
  name: string,
  albumTitle: string | undefined,
  declared?: string,
): Promise<CreditedTarget> {
  const order = [
    { column: "person_id", claimKind: "person", input: { kind: "PERSON", name, ...(albumTitle === undefined ? {} : { albumCredits: [albumTitle] }) } },
    { column: "organization_id", claimKind: "organization", input: { kind: "ORGANIZATION", name, ...(albumTitle === undefined ? {} : { associatedAlbums: [albumTitle] }) } },
    { column: "artist_id", claimKind: "artist", input: { kind: "ARTIST", name } },
  ] as const;
  const wanted = isCreditedKind(declared) ? order.filter((option) => option.claimKind === declared) : order;
  let last: Endpoint | undefined;
  for (const option of wanted) {
    const endpoint = await resolveEndpoint(client, claim, claimId, option.input, option.claimKind, [name]);
    if (endpoint.id !== undefined) return { column: option.column, endpoint };
    last = endpoint;
  }
  return { endpoint: last! };
}

/** El acreditado elegido por id: exactamente uno de persona, banda u organización. */
async function explicitCredited(
  client: PoolClient, claim: ClaimToPersist,
): Promise<{ column: CreditedColumn; endpoint: Endpoint } | undefined> {
  const endpoints = claim.endpoints;
  if (endpoints === undefined) return undefined;
  const chosen = ([
    ["person_id", "person", endpoints.personId],
    ["artist_id", "artist", endpoints.artistId],
    ["organization_id", "organization", endpoints.organizationId],
  ] as const).filter(([, , id]) => id !== undefined);
  if (chosen.length === 0) return undefined;
  if (chosen.length > 1) throw new Error("un crédito acredita a una sola persona, banda u organización");
  const [column, kind, id] = chosen[0]!;
  return { column, endpoint: await explicitEndpoint(client, kind, id!) };
}

/** Traza cómo se identificó cada extremo: herencia del claim graph, ER o id explícito. */
function provenance(endpoints: ReadonlyArray<readonly [string, Endpoint]>): string {
  return endpoints
    .map(([label, endpoint]) => `${label}=${endpoint.via === "claim" ? "claim_graph"
      : endpoint.via === "explicit" ? `explicit_fk:${endpoint.id}` : `er_decision:${endpoint.decisionId ?? "?"}`}`)
    .join(" ");
}

async function attach(
  client: PoolClient, spec: RelationSpec, claimId: number, relationId: number | null,
  status: "accepted" | "candidate",
): Promise<void> {
  await client.query(
    `UPDATE ingest.claims SET ${spec.column}=$1,status=$2,updated_at=now() WHERE id=$3`,
    [relationId, status, claimId],
  );
}

async function auditRelation(
  client: PoolClient, claim: ClaimToPersist, claimId: number, spec: RelationSpec,
  relationId: number, field: string, oldValue: unknown, newValue: unknown, confidence: Confidence, reason: string,
): Promise<void> {
  const saved = await client.query<{ id: string }>(
    `INSERT INTO ingest.merge_audit(run_id,entity_kind,${spec.column},field,old_value,new_value,reason,confidence,performed_by)
     VALUES($1,$2::ingest.claim_entity_kind,$3,$4,$5::jsonb,$6::jsonb,$7,$8,$9) RETURNING id`,
    [claim.runId ?? null, spec.kind, relationId, field,
      oldValue === null ? null : JSON.stringify(oldValue), JSON.stringify(newValue), reason, confidence, claim.createdBy ?? "system"],
  );
  const auditId = saved.rows[0]?.id;
  if (!auditId) throw new Error("no se pudo crear merge_audit de relación");
  await client.query(
    "INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [auditId, claimId],
  );
}

/** Alta de una fila puente: el rastro nombra la tabla y guarda la fila completa. */
async function auditInsert(
  context: RelationContext, relationId: number, row: Record<string, unknown>, reason: string,
): Promise<void> {
  const { client, claim, claimId, spec } = context;
  await auditRelation(client, claim, claimId, spec, relationId, spec.table.replace("public.", ""), null, row, claim.confidence, reason);
}

async function pendingReview(
  client: PoolClient, claimId: number, spec: RelationSpec, reason: string, payload: Record<string, unknown>,
): Promise<number> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ingest.review_queue
      WHERE claim_a_id=$1 AND kind='manual_review' AND status IN ('open','in_progress') ORDER BY id LIMIT 1`,
    [claimId],
  );
  if (existing.rows[0]?.id) return Number(existing.rows[0].id);
  const saved = await client.query<{ id: string }>(
    `INSERT INTO ingest.review_queue(kind,claim_a_id,priority,payload,notes)
     VALUES('manual_review',$1,6,$2::jsonb,$3) RETURNING id`,
    [claimId, JSON.stringify({ relationKind: spec.kind, reason, ...payload }), `Relación pendiente: ${reason}`],
  );
  return Number(saved.rows[0]!.id);
}

function year(value: string | undefined): number | null {
  if (!value) return null;
  const match = /(\d{4})/u.exec(value);
  return match ? Number(match[1]) : null;
}

function trackNumbers(value: string | undefined): number[] {
  if (!value) return [];
  return [...new Set(
    (value.match(/\d{1,3}/gu) ?? []).map(Number).filter((item) => item > 0 && item < 1000),
  )].sort((left, right) => left - right);
}

interface RelationContext {
  client: PoolClient;
  claim: ClaimToPersist;
  claimId: number;
  spec: RelationSpec;
  fields: RelationFields;
}

/** Campos que solo una persona afirma (notas, vigencia): una fuente nunca los rellena. */
function humanField(context: RelationContext, field: string): string | undefined {
  return context.claim.createdBy === "human" ? context.fields.get(field) : undefined;
}

type RelationResult =
  | { status: "written"; ids: number[]; created: number; detail: string }
  | { status: "pending"; reason: string; payload: Record<string, unknown> };

/**
 * Período contra una fila ya registrada: un año distinto sobre la MISMA
 * función no se sobrescribe ni se ignora, va a revisión humana.
 */
function periodContradicts(
  incoming: { from: number | null; to: number | null },
  stored: { from_year: number | null; to_year: number | null },
): boolean {
  const differs = (value: number | null, current: number | null): boolean =>
    value !== null && current !== null && value !== current;
  return differs(incoming.from, stored.from_year) || differs(incoming.to, stored.to_year);
}

async function membership(context: RelationContext): Promise<RelationResult> {
  const { client, claim, claimId, fields } = context;
  const explicit = claim.endpoints;
  const artistName = fields.get("artist_name");
  const personName = fields.get("person_name");
  const role = fields.get("role");
  if (!role || (!artistName && explicit?.artistId === undefined) || (!personName && explicit?.personId === undefined)) {
    return { status: "pending", reason: "faltan campos obligatorios de la membresía", payload: { artistName, personName, role } };
  }
  const from = year(fields.get("from_year"));
  const to = year(fields.get("to_year"));
  const period = { ...(from === null ? {} : { from }), ...(to === null ? {} : { to }) };
  const artist = explicit?.artistId !== undefined
    ? await explicitEndpoint(client, "artist", explicit.artistId)
    : await resolveEndpoint(client, claim, claimId, { kind: "ARTIST", name: artistName!, ...(personName ? { members: [personName] } : {}) }, "artist", [artistName!]);
  // La trayectoria que afirma esta misma fila es el contexto del ER: banda,
  // función y período. No es un atajo, es la evidencia del claim.
  const person = explicit?.personId !== undefined
    ? await explicitEndpoint(client, "person", explicit.personId)
    : await resolveEndpoint(client, claim, claimId,
      { kind: "PERSON", name: personName!, bands: [artist.name], roles: [role], ...(Object.keys(period).length === 0 ? {} : { period }) },
      "person", [personName!]);
  if (artist.id === undefined || person.id === undefined) {
    return {
      status: "pending", reason: "extremo inexistente en el core; apruebe primero la entidad",
      payload: { artist: { name: artistName, action: artist.action, decisionId: artist.decisionId },
        person: { name: personName, action: person.action, decisionId: person.decisionId } },
    };
  }
  // Clave de idempotencia (artist_id, person_id, rol normalizado): el rol es
  // parte de lo que la fila afirma, así que la misma persona con dos
  // funciones en la misma banda son dos membresías, no una duplicada.
  const existing = await client.query<{ id: string; from_year: number | null; to_year: number | null }>(
    `SELECT id::text, from_year, to_year FROM public.artist_members
      WHERE artist_id=$1 AND person_id=$2 AND lower(role)=lower($3) LIMIT 1`,
    [artist.id, person.id, role],
  );
  const current = existing.rows[0];
  if (current) {
    if (periodContradicts({ from, to }, current)) {
      return { status: "pending", reason: "período contradictorio para una membresía ya registrada",
        payload: { membershipId: Number(current.id), stored: { from: current.from_year, to: current.to_year }, incoming: { from, to } } };
    }
    return { status: "written", ids: [Number(current.id)], created: 0, detail: "membresía ya registrada" };
  }
  // is_current no se infiere: la ausencia de año de salida no es una
  // afirmación de que la persona siga en la banda. Queda en false (default
  // del core) salvo que una persona lo declare.
  const isCurrent = humanField(context, "is_current") === "true";
  const notes = humanField(context, "notes") ?? null;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.artist_members(artist_id,person_id,role,from_year,to_year,is_current,notes)
     VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [artist.id, person.id, role, from, to, isCurrent, notes],
  );
  const id = Number(inserted.rows[0]!.id);
  await auditInsert(context, id,
    { artistId: artist.id, personId: person.id, role, fromYear: from, toYear: to, ...(isCurrent ? { isCurrent } : {}), ...(notes === null ? {} : { notes }) },
    `membresía nueva; ${provenance([["artist", artist], ["person", person]])}`);
  return { status: "written", ids: [id], created: 1, detail: "membresía creada y auditada" };
}

/**
 * Persona en una organización (sello, estudio, productora). Ninguna fuente la
 * afirma todavía: solo se materializa con los dos extremos elegidos por id.
 */
async function personOrganization(context: RelationContext): Promise<RelationResult> {
  const { client, claim, fields } = context;
  const role = fields.get("role");
  if (!role) return { status: "pending", reason: "falta el rol de la persona en la organización", payload: {} };
  if (claim.endpoints?.personId === undefined || claim.endpoints.organizationId === undefined) {
    return { status: "pending", reason: "la relación persona-organización solo se registra con extremos explícitos", payload: { role } };
  }
  const person = await explicitEndpoint(client, "person", claim.endpoints.personId);
  const organization = await explicitEndpoint(client, "organization", claim.endpoints.organizationId);
  const from = year(fields.get("from_year"));
  const to = year(fields.get("to_year"));
  const existing = await client.query<{ id: string; from_year: number | null; to_year: number | null }>(
    `SELECT id::text, from_year, to_year FROM public.person_organizations
      WHERE person_id=$1 AND organization_id=$2 AND lower(role)=lower($3) LIMIT 1`,
    [person.id, organization.id, role],
  );
  const current = existing.rows[0];
  if (current) {
    if (periodContradicts({ from, to }, current)) {
      return { status: "pending", reason: "período contradictorio para una relación ya registrada",
        payload: { personOrganizationId: Number(current.id), stored: { from: current.from_year, to: current.to_year }, incoming: { from, to } } };
    }
    return { status: "written", ids: [Number(current.id)], created: 0, detail: "relación persona-organización ya registrada" };
  }
  const notes = humanField(context, "notes") ?? null;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.person_organizations(person_id,organization_id,role,from_year,to_year,notes)
     VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
    [person.id, organization.id, role, from, to, notes],
  );
  const id = Number(inserted.rows[0]!.id);
  await auditInsert(context, id,
    { personId: person.id, organizationId: organization.id, role, fromYear: from, toYear: to, ...(notes === null ? {} : { notes }) },
    `relación persona-organización nueva; ${provenance([["person", person], ["organization", organization]])}`);
  return { status: "written", ids: [id], created: 1, detail: "relación persona-organización creada y auditada" };
}

async function albumEndpoint(context: RelationContext): Promise<Endpoint | { pending: RelationResult }> {
  const { client, claim, claimId, fields } = context;
  if (claim.endpoints?.albumId !== undefined) return explicitEndpoint(client, "album", claim.endpoints.albumId);
  const albumTitle = fields.get("album_title");
  if (!albumTitle) return { pending: { status: "pending", reason: "el registro no indica álbum", payload: {} } };
  const artistName = fields.get("artist_name");
  const album = await resolveEndpoint(client, claim, claimId, {
    kind: "ALBUM", name: albumTitle,
    ...(artistName === undefined ? {} : { artist: { name: artistName } }),
  }, "album", artistName === undefined ? [albumTitle] : [`${artistName}::${albumTitle}`, albumTitle]);
  if (album.id === undefined) {
    return { pending: {
      status: "pending", reason: "álbum inexistente en el core; apruebe primero el álbum",
      payload: { album: { title: albumTitle, artistName, action: album.action, decisionId: album.decisionId } },
    } };
  }
  return album;
}

async function insertCredit(
  context: RelationContext, parentColumn: "album_id" | "track_id", parentId: number,
  targetColumn: "person_id" | "organization_id" | "artist_id", targetId: number,
  creditType: CreditType, role: string, trace: string,
): Promise<{ id: number; created: boolean }> {
  const { client, spec } = context;
  const candidates = await client.query<{ id: string; role: string }>(
    `SELECT id::text, role FROM ${spec.table}
      WHERE ${parentColumn}=$1 AND ${targetColumn}=$2 AND credit_type=$3::credit_type ORDER BY id`,
    [parentId, targetId, creditType],
  );
  const key = creditEquivalenceKey(creditType, role);
  const existing = candidates.rows.find((row) => creditEquivalenceKey(creditType, row.role) === key);
  if (existing) return { id: Number(existing.id), created: false };
  const notes = humanField(context, "notes") ?? null;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ${spec.table}(${parentColumn},${targetColumn},credit_type,role,notes)
     VALUES($1,$2,$3::credit_type,$4,$5) RETURNING id`,
    [parentId, targetId, creditType, role, notes],
  );
  const id = Number(inserted.rows[0]!.id);
  await auditInsert(context, id,
    { [parentColumn]: parentId, [targetColumn]: targetId, creditType, role, ...(notes === null ? {} : { notes }) },
    `crédito nuevo; ${trace}`);
  return { id, created: true };
}

/** El tipo declarado por una persona manda; si no hay, se clasifica el rol. */
function creditTypeFor(context: RelationContext, role: string): CreditType {
  const declared = humanField(context, "credit_type");
  return isCreditType(declared) ? declared : creditTypeForRole(role);
}

async function albumCredit(context: RelationContext): Promise<RelationResult> {
  const { client, claim, claimId, fields } = context;
  const credited = fields.get("credited_name");
  const role = fields.get("credit_role");
  const explicit = await explicitCredited(client, claim);
  if ((!credited && !explicit) || !role) return { status: "pending", reason: "faltan campos obligatorios del crédito", payload: { credited, role } };
  const album = await albumEndpoint(context);
  if ("pending" in album) return album.pending;
  const target: CreditedTarget = explicit ?? await resolveCredited(client, claim, claimId, credited!, fields.get("album_title"), fields.get("credited_kind"));
  if (target.column === undefined) {
    return { status: "pending", reason: "acreditado inexistente en el core; apruebe primero la entidad",
      payload: { credited, action: target.endpoint.action, decisionId: target.endpoint.decisionId } };
  }
  const result = await insertCredit(context, "album_id", album.id!, target.column, target.endpoint.id!,
    creditTypeFor(context, role), role, provenance([["album", album], ["credited", target.endpoint]]));
  return { status: "written", ids: [result.id], created: result.created ? 1 : 0,
    detail: result.created ? "crédito de álbum creado y auditado" : "crédito de álbum ya registrado" };
}

async function trackCredit(context: RelationContext): Promise<RelationResult> {
  const { client, claim, claimId, fields } = context;
  const credited = fields.get("credited_name");
  const role = fields.get("credit_role");
  const explicit = await explicitCredited(client, claim);
  if ((!credited && !explicit) || !role) return { status: "pending", reason: "faltan campos obligatorios del crédito", payload: { credited, role } };

  let trackIds: number[] = [];
  let trace: Array<readonly [string, Endpoint]> = [];
  if (claim.endpoints?.trackId !== undefined) {
    const track = await explicitEndpoint(client, "track", claim.endpoints.trackId);
    trackIds = [track.id!];
    trace = [["track", track]];
  } else {
    const album = await albumEndpoint(context);
    if ("pending" in album) return album.pending;
    trace = [["album", album]];
    // Dos formas de acotar la pista: el título explícito, o "(tracks 01, 03)"
    // que enumera los números dentro del mismo disco. La segunda produce una
    // fila por pista; el claim conserva la FK de la primera y la auditoría
    // registra cada una por separado.
    const trackTitle = fields.get("track_title");
    const numbers = trackNumbers(fields.get("track_numbers"));
    if (trackTitle) {
      // Con el álbum ya resuelto a un id, la pista se busca por clave exacta
      // DENTRO de ese álbum, no por ER global: el título de una pista solo es
      // identificador dentro de su disco. Si empata con más de una, no se elige.
      const { rows } = await client.query<{ id: string }>(
        `SELECT t.id::text FROM public.tracks t
          WHERE t.album_id=$1 AND (lower(t.title)=lower($2)
                OR EXISTS (SELECT 1 FROM ingest.track_aliases x WHERE x.track_id=t.id AND x.normalized_alias=$3))`,
        [album.id, trackTitle, normalizeIdentity(trackTitle)],
      );
      if (rows.length !== 1) {
        return { status: "pending",
          reason: rows.length === 0 ? "pista inexistente en el core; apruebe primero la pista" : "el título empata con varias pistas del álbum",
          payload: { track: trackTitle, albumId: album.id, matches: rows.length } };
      }
      trackIds = [Number(rows[0]!.id)];
    } else if (numbers.length > 0) {
      const { rows } = await client.query<{ id: string; track_number: number }>(
        "SELECT id::text, track_number FROM public.tracks WHERE album_id=$1 AND track_number = ANY($2::int[]) ORDER BY disc_number,track_number",
        [album.id, numbers],
      );
      if (rows.length === 0) {
        return { status: "pending", reason: "las pistas indicadas no existen todavía en el core", payload: { numbers } };
      }
      trackIds = rows.map((row) => Number(row.id));
    } else {
      return { status: "pending", reason: "el crédito de pista no indica ni título ni números", payload: {} };
    }
  }

  const target: CreditedTarget = explicit ?? await resolveCredited(client, claim, claimId, credited!, fields.get("album_title"), fields.get("credited_kind"));
  if (target.column === undefined) {
    return { status: "pending", reason: "acreditado inexistente en el core; apruebe primero la entidad",
      payload: { credited, action: target.endpoint.action, decisionId: target.endpoint.decisionId } };
  }
  const creditType = creditTypeFor(context, role);
  const ids: number[] = []; let created = 0;
  for (const trackId of trackIds) {
    const result = await insertCredit(context, "track_id", trackId, target.column, target.endpoint.id!,
      creditType, role, provenance([...trace, ["credited", target.endpoint]]));
    ids.push(result.id);
    if (result.created) created += 1;
  }
  return { status: "written", ids, created,
    detail: created > 0 ? `créditos de pista creados: ${created}` : "créditos de pista ya registrados" };
}

const ARCHIVE_QUALITIES = new Set(["HQ", "LQ", "unknown"]);
const ARCHIVE_STATUSES = new Set(["published", "unpublished", "unknown"]);

/** Formato archivado de un disco (CD, casete, FLAC...). Solo con el disco elegido por id o resuelto. */
async function albumFormat(context: RelationContext): Promise<RelationResult> {
  const { client, fields } = context;
  const format = fields.get("format");
  if (!format) return { status: "pending", reason: "falta el formato", payload: {} };
  const quality = fields.get("quality") ?? null;
  const archiveStatus = fields.get("archive_status") ?? "unknown";
  if ((quality !== null && !ARCHIVE_QUALITIES.has(quality)) || !ARCHIVE_STATUSES.has(archiveStatus)) {
    return { status: "pending", reason: "calidad o estado de archivo fuera de los valores del core", payload: { quality, archiveStatus } };
  }
  const album = await albumEndpoint(context);
  if ("pending" in album) return album.pending;
  const filePath = fields.get("file_path") ?? null;
  // Un mismo disco puede archivarse dos veces en el mismo formato (dos rips
  // FLAC); lo que las distingue es el archivo. Sin ruta, el formato es uno.
  const existing = await client.query<{ id: string }>(
    `SELECT id::text FROM public.album_formats
      WHERE album_id=$1 AND lower(format)=lower($2) AND file_path IS NOT DISTINCT FROM $3 LIMIT 1`,
    [album.id, format, filePath],
  );
  if (existing.rows[0]) return { status: "written", ids: [Number(existing.rows[0].id)], created: 0, detail: "formato ya registrado" };
  const notes = humanField(context, "notes") ?? null;
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.album_formats(album_id,format,quality,archive_status,file_path,notes)
     VALUES($1,$2,$3::archive_quality,$4::archive_status,$5,$6) RETURNING id`,
    [album.id, format, quality, archiveStatus, filePath, notes],
  );
  const id = Number(inserted.rows[0]!.id);
  await auditInsert(context, id,
    { albumId: album.id, format, quality, archiveStatus, filePath, ...(notes === null ? {} : { notes }) },
    `formato nuevo; ${provenance([["album", album]])}`);
  return { status: "written", ids: [id], created: 1, detail: "formato creado y auditado" };
}

/**
 * Materializa un claim de relación. La compuerta `low` va primero: un claim
 * automático se queda en revisión sin gastar decisiones de ER.
 *
 * `externalClient` es la transacción de quien llama (la API del operador):
 * sin él, cada relación abre y confirma la suya.
 */
export async function mergeRelationClaim(claim: ClaimToPersist, claimId: number, externalClient?: PoolClient): Promise<MergeOutcome> {
  if (externalClient) return mergeRelationWith(externalClient, claim, claimId);
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const outcome = await mergeRelationWith(client, claim, claimId);
    await client.query("COMMIT");
    return outcome;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function mergeRelationWith(client: PoolClient, claim: ClaimToPersist, claimId: number): Promise<MergeOutcome> {
  const spec = RELATION_SPECS[claim.entityKind as RelationClaimKind];
  const identityKey = claim.identity;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`relation:${spec.kind}:${identityKey}`]);

  if ((claim.createdBy ?? "system") === "ai" || (claim.confidence === "low" && claim.createdBy !== "human")) {
    await client.query("UPDATE ingest.claims SET status='candidate',updated_at=now() WHERE id=$1", [claimId]);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM ingest.review_queue WHERE claim_a_id=$1 AND kind='low_confidence' AND status IN ('open','in_progress') ORDER BY id LIMIT 1`,
      [claimId],
    );
    if (!existing.rows[0]) {
      await client.query(
        `INSERT INTO ingest.review_queue(kind,claim_a_id,priority,payload,notes)
         VALUES('low_confidence',$1,6,$2::jsonb,'Relación low: no escribe tablas puente')`,
        [claimId, JSON.stringify({ field: claim.field, relationKind: spec.kind, identity: claim.originalIdentity })],
      );
    }
    return { action: "candidate", relationKind: spec.kind, detail: "relación low/AI enviada a revisión; core intacto" };
  }

  const fields = await gatherFields(client, spec.kind, identityKey);
  const context: RelationContext = { client, claim, claimId, spec, fields };
  const outcome: RelationResult = fields.contradicted.length > 0
    ? { status: "pending", reason: "claims contradictorios sobre el mismo hecho", payload: { fields: fields.contradicted } }
    : spec.kind === "artist_membership" ? await membership(context)
      : spec.kind === "person_organization" ? await personOrganization(context)
        : spec.kind === "album_credit" ? await albumCredit(context)
          : spec.kind === "track_credit" ? await trackCredit(context)
            : await albumFormat(context);

  if (outcome.status === "pending") {
    await client.query("UPDATE ingest.claims SET status='candidate',updated_at=now() WHERE id=$1", [claimId]);
    const reviewId = await pendingReview(client, claimId, spec, outcome.reason, outcome.payload);
    return { action: "candidate", relationKind: spec.kind, detail: `${outcome.reason}; review=${reviewId}` };
  }

  // Todos los claims hermanos de la relación quedan enganchados a la fila:
  // la evidencia de cada campo apunta al mismo hecho del core.
  for (const sibling of fields.claimIds) await attach(client, spec, sibling, outcome.ids[0]!, "accepted");
  await attach(client, spec, claimId, outcome.ids[0]!, "accepted");
  await client.query(
    `UPDATE ingest.review_queue SET status='approved',resolved_by='human',resolved_at=now(),updated_at=now(),
            resolution_note=COALESCE(resolution_note,'relación materializada en el core')
      WHERE claim_a_id = ANY($1::bigint[]) AND kind IN ('low_confidence','manual_review') AND status IN ('open','in_progress')`,
    [[...new Set([...fields.claimIds, claimId])]],
  );
  return {
    action: outcome.created > 0 ? "applied" : "unchanged",
    relationKind: spec.kind, relationIds: outcome.ids, detail: outcome.detail,
  };
}

// ---------------------------------------------------------------------------
// Correcciones de una fila puente ya registrada.
//
// El alta es idempotente y nunca reescribe; corregir el rol de un crédito o el
// período de una membresía es otra cosa: una persona dice que lo registrado
// está mal. Se escribe la columna, se audita el valor anterior y el nuevo, y
// el claim humano sustituye a los que afirmaban el valor viejo.
// ---------------------------------------------------------------------------

type EditableKind = "text" | "year" | "boolean" | "credit_type" | "quality" | "archive_status";

const EDITABLE: Readonly<Record<RelationClaimKind, Readonly<Record<string, { kind: EditableKind; nullable: boolean }>>>> = {
  artist_membership: {
    role: { kind: "text", nullable: false }, from_year: { kind: "year", nullable: true }, to_year: { kind: "year", nullable: true },
    is_current: { kind: "boolean", nullable: false }, notes: { kind: "text", nullable: true },
  },
  person_organization: {
    role: { kind: "text", nullable: false }, from_year: { kind: "year", nullable: true }, to_year: { kind: "year", nullable: true },
    notes: { kind: "text", nullable: true },
  },
  album_credit: { role: { kind: "text", nullable: false }, credit_type: { kind: "credit_type", nullable: false }, notes: { kind: "text", nullable: true } },
  track_credit: { role: { kind: "text", nullable: false }, credit_type: { kind: "credit_type", nullable: false }, notes: { kind: "text", nullable: true } },
  album_format: {
    format: { kind: "text", nullable: false }, quality: { kind: "quality", nullable: true },
    archive_status: { kind: "archive_status", nullable: false }, file_path: { kind: "text", nullable: true }, notes: { kind: "text", nullable: true },
  },
};

export function editableRelationFields(kind: RelationClaimKind): string[] {
  return Object.keys(EDITABLE[kind]);
}

export class RelationRowMissingError extends Error {
  constructor(readonly kind: RelationClaimKind, readonly id: number) {
    super(`${kind} ${id} inexistente`);
  }
}

function coerceEditable(field: string, spec: { kind: EditableKind; nullable: boolean }, value: unknown): string | number | boolean | null {
  if (value === null || value === undefined || value === "") {
    if (!spec.nullable) throw new Error(`${field} no admite vacío`);
    return null;
  }
  switch (spec.kind) {
    case "year": {
      const parsed = typeof value === "number" ? value : Number(String(value).trim());
      if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 9999) throw new Error(`${field} debe ser un año`);
      return parsed;
    }
    case "boolean":
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      throw new Error(`${field} debe ser boolean`);
    case "credit_type":
      if (typeof value === "string" && isCreditType(value)) return value;
      throw new Error(`${field} fuera del enum credit_type`);
    case "quality":
      if (typeof value === "string" && ARCHIVE_QUALITIES.has(value)) return value;
      throw new Error(`${field} fuera del enum archive_quality`);
    case "archive_status":
      if (typeof value === "string" && ARCHIVE_STATUSES.has(value)) return value;
      throw new Error(`${field} fuera del enum archive_status`);
    case "text": {
      if (typeof value !== "string") throw new Error(`${field} debe ser texto`);
      const text = normalizeDisplayName(value);
      if (!text && !spec.nullable) throw new Error(`${field} no admite vacío`);
      return text || null;
    }
  }
}

export interface RelationCorrection {
  kind: RelationClaimKind;
  id: number;
  field: string;
  value: unknown;
  /** Claim humano ya persistido con la FK de la fila. */
  claim: ClaimToPersist;
  claimId: number;
  note: string;
}

export async function correctRelationField(
  client: PoolClient, input: RelationCorrection,
): Promise<{ changed: boolean; oldValue: unknown; newValue: unknown }> {
  if (input.claim.createdBy !== "human") throw new Error("solo una persona corrige una fila puente registrada");
  if (!input.note.trim()) throw new Error("nota obligatoria para corregir una relación");
  const spec = RELATION_SPECS[input.kind];
  const editable = EDITABLE[input.kind][input.field];
  if (!editable) throw new Error(`campo ${input.kind}.${input.field} no editable`);
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`relation-row:${input.kind}:${input.id}`]);
  const loaded = await client.query<Record<string, unknown>>(
    `SELECT ${input.field}${editable.kind === "credit_type" || editable.kind === "quality" || editable.kind === "archive_status" ? "::text" : ""} AS value
       FROM ${spec.table} WHERE id=$1 FOR UPDATE`, [input.id]);
  if (!loaded.rows[0]) throw new RelationRowMissingError(input.kind, input.id);
  const current = loaded.rows[0]["value"] ?? null;
  const proposed = coerceEditable(input.field, editable, input.value);
  const changed = JSON.stringify(current) !== JSON.stringify(proposed);
  if (changed) {
    const cast = editable.kind === "credit_type" ? "::credit_type"
      : editable.kind === "quality" ? "::archive_quality" : editable.kind === "archive_status" ? "::archive_status" : "";
    await client.query(`UPDATE ${spec.table} SET ${input.field}=$1${cast} WHERE id=$2`, [proposed, input.id]);
    await auditRelation(client, input.claim, input.claimId, spec, input.id, input.field, current, proposed, "high",
      `corrección humana: ${input.note}`);
  }
  await client.query(`UPDATE ingest.claims SET ${spec.column}=$1,status='accepted',updated_at=now() WHERE id=$2`, [input.id, input.claimId]);
  await client.query(
    `UPDATE ingest.claims SET status='superseded',updated_at=now()
      WHERE ${spec.column}=$1 AND field=$2 AND id<>$3 AND status='accepted'`,
    [input.id, input.field, input.claimId]);
  return { changed, oldValue: current, newValue: proposed };
}
