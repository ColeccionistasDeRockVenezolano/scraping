// Puente de relaciones: convierte claims de tipo relación en filas de las
// tablas puente del core. Es el único módulo que escribe artist_members,
// album_credits y track_credits, y lo hace bajo cuatro reglas fijas:
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
//      una decisión humana explícita (createdBy="human", vía review approve)
//      materializa la relación.
//   4. La unidad es el registro completo, no el campo suelto: los claims
//      hermanos se leen juntos. Si dos contradicen un campo no se elige
//      ninguno — elegir sería inventar una decisión que nadie tomó.
//
// A diferencia del merge de entidades, la compuerta `low` se evalúa ANTES de
// resolver los extremos: una relación candidata no tiene nada a lo que
// engancharse, así que gastar una decisión de ER por cada uno de sus campos
// solo produciría ruido en er_decisions.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import type { ClaimToPersist, Confidence } from "../claims/persistence.js";
import type { MergeOutcome } from "./engine.js";
import { normalizeDisplayName } from "../normalization/entity-name.js";
import { normalizeIdentity } from "../normalization/claims.js";
import { loadResolutionCandidates, persistResolutionDecision } from "../er/repository.js";
import { resolveEntity, resolutionThresholdsFromEnv } from "../er/resolver.js";
import type { ResolutionInput } from "../er/types.js";

export const RELATION_KINDS = ["artist_membership", "album_credit", "track_credit"] as const;
export type RelationClaimKind = (typeof RELATION_KINDS)[number];

export function isRelationKind(kind: string): kind is RelationClaimKind {
  return (RELATION_KINDS as readonly string[]).includes(kind);
}

type RelationColumn = "artist_membership_id" | "album_credit_id" | "track_credit_id";

interface RelationSpec {
  kind: RelationClaimKind;
  /** Tabla puente del core. Fija por tipo: aquí vive la regla dura. */
  table: string;
  /** Columna FK homónima en ingest.claims y en ingest.merge_audit. */
  column: RelationColumn;
}

const RELATION_SPECS: Readonly<Record<RelationClaimKind, RelationSpec>> = {
  artist_membership: { kind: "artist_membership", table: "public.artist_members", column: "artist_membership_id" },
  album_credit: { kind: "album_credit", table: "public.album_credits", column: "album_credit_id" },
  track_credit: { kind: "track_credit", table: "public.track_credits", column: "track_credit_id" },
};

export type CreditType =
  | "musician" | "guest" | "writer" | "composer" | "producer" | "recording"
  | "mixing" | "mastering" | "photography" | "artwork" | "other";

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
  /(guitar|guitarra|bass|bajo|drum|bater|percussion|percusi|vocal|voz|voces|voice|sing|cant|keyboard|teclad|piano|organ|[oó]rgano|synth|sintetiz|sax|trumpet|trompeta|tromb[oó]n|trombone|flute|flauta|clarinet|oboe|viol[ií]n|violin|viola|cello|chelo|contrabajo|harp|arpa|harmonica|arm[oó]nica|accordion|acorde[oó]n|banjo|mandolin|cuatro|maracas|conga|timbal|bong[oó]|charrasca|tambor|coro|chorus|backing|palmas)/iu;

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
  /** Cómo se resolvió: heredado del claim graph o decidido por el ER. */
  via: "claim" | "er";
  ambiguous?: boolean;
}

const CLAIM_TARGET_COLUMN = {
  artist: "artist_id", person: "person_id", organization: "organization_id",
  album: "album_id", track: "track_id",
} as const;

type EntityClaimKind = keyof typeof CLAIM_TARGET_COLUMN;

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

/** Extremo acreditado: persona, organización o banda, en ese orden. */
async function resolveCredited(
  client: PoolClient,
  claim: ClaimToPersist,
  claimId: number,
  name: string,
  albumTitle: string | undefined,
): Promise<{ column: "person_id" | "organization_id" | "artist_id"; endpoint: Endpoint } | { endpoint: Endpoint }> {
  const order = [
    { column: "person_id", claimKind: "person", input: { kind: "PERSON", name, ...(albumTitle === undefined ? {} : { albumCredits: [albumTitle] }) } },
    { column: "organization_id", claimKind: "organization", input: { kind: "ORGANIZATION", name, ...(albumTitle === undefined ? {} : { associatedAlbums: [albumTitle] }) } },
    { column: "artist_id", claimKind: "artist", input: { kind: "ARTIST", name } },
  ] as const;
  let last: Endpoint | undefined;
  for (const option of order) {
    const endpoint = await resolveEndpoint(client, claim, claimId, option.input, option.claimKind, [name]);
    if (endpoint.id !== undefined) return { column: option.column, endpoint };
    last = endpoint;
  }
  return { endpoint: last! };
}

/** Traza cómo se identificó cada extremo: herencia del claim graph o ER. */
function provenance(endpoints: ReadonlyArray<readonly [string, Endpoint]>): string {
  return endpoints
    .map(([label, endpoint]) => `${label}=${endpoint.via === "claim" ? "claim_graph" : `er_decision:${endpoint.decisionId ?? "?"}`}`)
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
  relationId: number, newValue: unknown, confidence: Confidence, reason: string,
): Promise<void> {
  const saved = await client.query<{ id: string }>(
    `INSERT INTO ingest.merge_audit(run_id,entity_kind,${spec.column},field,old_value,new_value,reason,confidence,performed_by)
     VALUES($1,$2::ingest.claim_entity_kind,$3,$4,NULL,$5::jsonb,$6,$7,$8) RETURNING id`,
    [claim.runId ?? null, spec.kind, relationId, spec.table.replace("public.", ""),
      JSON.stringify(newValue), reason, confidence, claim.createdBy ?? "system"],
  );
  const auditId = saved.rows[0]?.id;
  if (!auditId) throw new Error("no se pudo crear merge_audit de relación");
  await client.query(
    "INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
    [auditId, claimId],
  );
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

type RelationResult =
  | { status: "written"; ids: number[]; created: number; detail: string }
  | { status: "pending"; reason: string; payload: Record<string, unknown> };

async function membership(context: RelationContext): Promise<RelationResult> {
  const { client, claim, claimId, spec, fields } = context;
  const artistName = fields.get("artist_name");
  const personName = fields.get("person_name");
  const role = fields.get("role");
  if (!artistName || !personName || !role) {
    return { status: "pending", reason: "faltan campos obligatorios de la membresía", payload: { artistName, personName, role } };
  }
  const from = year(fields.get("from_year"));
  const to = year(fields.get("to_year"));
  const period = { ...(from === null ? {} : { from }), ...(to === null ? {} : { to }) };
  const artist = await resolveEndpoint(client, claim, claimId,
    { kind: "ARTIST", name: artistName, members: [personName] }, "artist", [artistName]);
  // La trayectoria que afirma esta misma fila es el contexto del ER: banda,
  // función y período. No es un atajo, es la evidencia del claim.
  const person = await resolveEndpoint(client, claim, claimId,
    { kind: "PERSON", name: personName, bands: [artistName], roles: [role], ...(Object.keys(period).length === 0 ? {} : { period }) },
    "person", [personName]);
  if (artist.id === undefined || person.id === undefined) {
    return {
      status: "pending", reason: "extremo inexistente en el core; apruebe primero la entidad",
      payload: { artist: { name: artistName, action: artist.action, decisionId: artist.decisionId },
        person: { name: personName, action: person.action, decisionId: person.decisionId } },
    };
  }
  // Clave de idempotencia (artist_id, person_id, rol normalizado): el rol es
  // parte de lo que la fila afirma, así que la misma persona con dos
  // funciones en la misma banda son dos membresías, no una duplicada. Un
  // período contradictorio sobre la MISMA función no se sobrescribe ni se
  // ignora: va a revisión humana.
  const existing = await client.query<{ id: string; from_year: number | null; to_year: number | null }>(
    `SELECT id::text, from_year, to_year FROM public.artist_members
      WHERE artist_id=$1 AND person_id=$2 AND lower(role)=lower($3) LIMIT 1`,
    [artist.id, person.id, role],
  );
  const current = existing.rows[0];
  if (current) {
    const contradicts = (incoming: number | null, stored: number | null): boolean =>
      incoming !== null && stored !== null && incoming !== stored;
    if (contradicts(from, current.from_year) || contradicts(to, current.to_year)) {
      return { status: "pending", reason: "período contradictorio para una membresía ya registrada",
        payload: { membershipId: Number(current.id), stored: { from: current.from_year, to: current.to_year }, incoming: { from, to } } };
    }
    return { status: "written", ids: [Number(current.id)], created: 0, detail: "membresía ya registrada" };
  }
  // is_current no se infiere: la ausencia de año de salida no es una
  // afirmación de que la persona siga en la banda. Queda en false (default
  // del core) hasta que una decisión humana lo declare.
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO public.artist_members(artist_id,person_id,role,from_year,to_year)
     VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [artist.id, person.id, role, from, to],
  );
  const id = Number(inserted.rows[0]!.id);
  await auditRelation(client, claim, claimId, spec, id,
    { artistId: artist.id, personId: person.id, role, fromYear: from, toYear: to },
    claim.confidence, `membresía nueva; ${provenance([["artist", artist], ["person", person]])}`);
  return { status: "written", ids: [id], created: 1, detail: "membresía creada y auditada" };
}

async function albumEndpoint(context: RelationContext): Promise<Endpoint | { pending: RelationResult }> {
  const { client, claim, claimId, fields } = context;
  const albumTitle = fields.get("album_title");
  if (!albumTitle) return { pending: { status: "pending", reason: "el crédito no indica álbum", payload: {} } };
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
  const { client, claim, claimId, spec } = context;
  const existing = await client.query<{ id: string }>(
    `SELECT id::text FROM ${spec.table}
      WHERE ${parentColumn}=$1 AND ${targetColumn}=$2 AND credit_type=$3::credit_type AND lower(role)=lower($4) LIMIT 1`,
    [parentId, targetId, creditType, role],
  );
  if (existing.rows[0]) return { id: Number(existing.rows[0].id), created: false };
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO ${spec.table}(${parentColumn},${targetColumn},credit_type,role)
     VALUES($1,$2,$3::credit_type,$4) RETURNING id`,
    [parentId, targetId, creditType, role],
  );
  const id = Number(inserted.rows[0]!.id);
  await auditRelation(context.client, claim, claimId, spec, id,
    { [parentColumn]: parentId, [targetColumn]: targetId, creditType, role },
    claim.confidence, `crédito nuevo; ${trace}`);
  return { id, created: true };
}

async function albumCredit(context: RelationContext): Promise<RelationResult> {
  const { client, claim, claimId, fields } = context;
  const credited = fields.get("credited_name");
  const role = fields.get("credit_role");
  if (!credited || !role) return { status: "pending", reason: "faltan campos obligatorios del crédito", payload: { credited, role } };
  const album = await albumEndpoint(context);
  if ("pending" in album) return album.pending;
  const target = await resolveCredited(client, claim, claimId, credited, fields.get("album_title"));
  if (!("column" in target)) {
    return { status: "pending", reason: "acreditado inexistente en el core; apruebe primero la entidad",
      payload: { credited, action: target.endpoint.action, decisionId: target.endpoint.decisionId } };
  }
  const result = await insertCredit(context, "album_id", album.id!, target.column, target.endpoint.id!,
    creditTypeForRole(role), role, provenance([["album", album], ["credited", target.endpoint]]));
  return { status: "written", ids: [result.id], created: result.created ? 1 : 0,
    detail: result.created ? "crédito de álbum creado y auditado" : "crédito de álbum ya registrado" };
}

async function trackCredit(context: RelationContext): Promise<RelationResult> {
  const { client, claim, claimId, fields } = context;
  const credited = fields.get("credited_name");
  const role = fields.get("credit_role");
  if (!credited || !role) return { status: "pending", reason: "faltan campos obligatorios del crédito", payload: { credited, role } };
  const album = await albumEndpoint(context);
  if ("pending" in album) return album.pending;

  // Dos formas de acotar la pista: el título explícito, o "(tracks 01, 03)"
  // que enumera los números dentro del mismo disco. La segunda produce una
  // fila por pista; el claim conserva la FK de la primera y la auditoría
  // registra cada una por separado.
  const trackTitle = fields.get("track_title");
  const numbers = trackNumbers(fields.get("track_numbers"));
  let trackIds: number[] = [];
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

  const target = await resolveCredited(client, claim, claimId, credited, fields.get("album_title"));
  if (!("column" in target)) {
    return { status: "pending", reason: "acreditado inexistente en el core; apruebe primero la entidad",
      payload: { credited, action: target.endpoint.action, decisionId: target.endpoint.decisionId } };
  }
  const creditType = creditTypeForRole(role);
  const ids: number[] = []; let created = 0;
  for (const trackId of trackIds) {
    const result = await insertCredit(context, "track_id", trackId, target.column, target.endpoint.id!,
      creditType, role, provenance([["album", album], ["credited", target.endpoint]]));
    ids.push(result.id);
    if (result.created) created += 1;
  }
  return { status: "written", ids, created,
    detail: created > 0 ? `créditos de pista creados: ${created}` : "créditos de pista ya registrados" };
}

/**
 * Materializa un claim de relación. La compuerta `low` va primero: un claim
 * automático se queda en revisión sin gastar decisiones de ER.
 */
export async function mergeRelationClaim(claim: ClaimToPersist, claimId: number): Promise<MergeOutcome> {
  const spec = RELATION_SPECS[claim.entityKind as RelationClaimKind];
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
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
      await client.query("COMMIT");
      return { action: "candidate", relationKind: spec.kind, detail: "relación low/AI enviada a revisión; core intacto" };
    }

    const fields = await gatherFields(client, spec.kind, identityKey);
    const context: RelationContext = { client, claim, claimId, spec, fields };
    const outcome: RelationResult = fields.contradicted.length > 0
      ? { status: "pending", reason: "claims contradictorios sobre el mismo hecho", payload: { fields: fields.contradicted } }
      : spec.kind === "artist_membership" ? await membership(context)
        : spec.kind === "album_credit" ? await albumCredit(context)
          : await trackCredit(context);

    if (outcome.status === "pending") {
      await client.query("UPDATE ingest.claims SET status='candidate',updated_at=now() WHERE id=$1", [claimId]);
      const reviewId = await pendingReview(client, claimId, spec, outcome.reason, outcome.payload);
      await client.query("COMMIT");
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
    await client.query("COMMIT");
    return {
      action: outcome.created > 0 ? "applied" : "unchanged",
      relationKind: spec.kind, relationIds: outcome.ids, detail: outcome.detail,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
