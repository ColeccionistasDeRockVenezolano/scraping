// CRV · Fuentes externas de géneros en la base (PLAN_GENEROS etapa 4).
//
// Fichas de evaluación y autorización, identidades resueltas, sugerencias y
// registro de importaciones. Las reglas del plan que esta capa hace cumplir:
//
//  * SIN FICHA AUTORIZADA NO SE IMPORTA, y sin muestra que alcance el umbral
//    de precisión no se importa en volumen (la base también lo exige).
//  * UNA FUENTE EXTERNA NO MODIFICA NADA CONFIRMADO. Las sugerencias entran
//    solo donde no hay ya una fila para esa pareja ficha–género; nunca pisan
//    una decisión humana ni una asignación de las reglas.
//  * SE PUEDE APAGAR SIN PERDER LO EDITORIAL. Retirar una fuente borra sus
//    propuestas sin resolver; lo que una persona confirmó o rechazó se queda.
import type { PoolClient } from "pg";
import type { GenreEntityKind } from "../rules.js";
import { GENRE_COLUMN, GENRE_TABLE } from "../store.js";
import type { MatchSignal } from "./identity.js";
import { parseTagPolicy, type ExternalTagKind, type TagPolicy } from "./mapping.js";

/** Origen de los casos que abre la importación externa (no los abre ninguna regla). */
export const EXTERNAL_REVIEW_ORIGIN = "genres-external";
export const EXTERNAL_REVIEW_KIND = "genre_unknown";

export type ExternalSourceStatus = "evaluating" | "authorized" | "blocked";

/** Ficha de evaluación y autorización de una fuente (entregable de la etapa 4). */
export interface ExternalSourceSheet {
  slug: string;
  name: string;
  homepage: string | null;
  apiBase: string | null;
  accessMode: "api" | "dump" | "sparql";
  accessNote: string;
  license: string;
  attribution: string;
  termsUrl: string | null;
  rateLimitPerMinute: number;
  levels: "artist" | "album" | "both";
  coverageNote: string;
  identifierStability: string;
  tagPolicy: TagPolicy;
  status: ExternalSourceStatus;
  precisionThreshold: number;
  reason: string;
}

export interface ExternalSourceRow extends ExternalSourceSheet {
  id: number;
  importEnabled: boolean;
  bulkEnabled: boolean;
  precisionMeasured: number | null;
  sampleSize: number;
  sampleReport: string | null;
  measuredAt: Date | null;
  authorizedBy: string | null;
  authorizedAt: Date | null;
  evaluatedBy: string | null;
  evaluatedAt: Date | null;
}

function toRow(row: Record<string, unknown>): ExternalSourceRow {
  return {
    id: Number(row["id"]),
    slug: String(row["slug"]),
    name: String(row["name"]),
    homepage: (row["homepage"] as string | null) ?? null,
    apiBase: (row["api_base"] as string | null) ?? null,
    accessMode: row["access_mode"] as ExternalSourceSheet["accessMode"],
    accessNote: String(row["access_note"]),
    license: String(row["license"]),
    attribution: String(row["attribution"]),
    termsUrl: (row["terms_url"] as string | null) ?? null,
    rateLimitPerMinute: Number(row["rate_limit_per_minute"]),
    levels: row["levels"] as ExternalSourceSheet["levels"],
    coverageNote: String(row["coverage_note"]),
    identifierStability: String(row["identifier_stability"]),
    tagPolicy: parseTagPolicy(row["tag_policy"]),
    status: row["status"] as ExternalSourceStatus,
    precisionThreshold: Number(row["precision_threshold"]),
    reason: String(row["reason"]),
    importEnabled: row["import_enabled"] === true,
    bulkEnabled: row["bulk_enabled"] === true,
    precisionMeasured: row["precision_measured"] === null ? null : Number(row["precision_measured"]),
    sampleSize: Number(row["sample_size"] ?? 0),
    sampleReport: (row["sample_report"] as string | null) ?? null,
    measuredAt: (row["measured_at"] as Date | null) ?? null,
    authorizedBy: (row["authorized_by"] as string | null) ?? null,
    authorizedAt: (row["authorized_at"] as Date | null) ?? null,
    evaluatedBy: (row["evaluated_by"] as string | null) ?? null,
    evaluatedAt: (row["evaluated_at"] as Date | null) ?? null,
  };
}

export class ExternalSourceError extends Error {
  constructor(readonly code: "not_found" | "not_authorized" | "invalid", message: string) {
    super(message);
    this.name = "ExternalSourceError";
  }
}

export async function listExternalSources(client: PoolClient): Promise<ExternalSourceRow[]> {
  const { rows } = await client.query<Record<string, unknown>>("SELECT * FROM ingest.genre_external_sources ORDER BY slug");
  return rows.map(toRow);
}

export async function getExternalSource(client: PoolClient, slug: string): Promise<ExternalSourceRow | undefined> {
  const { rows } = await client.query<Record<string, unknown>>("SELECT * FROM ingest.genre_external_sources WHERE slug = $1", [slug]);
  return rows[0] ? toRow(rows[0]) : undefined;
}

export async function requireExternalSource(client: PoolClient, slug: string): Promise<ExternalSourceRow> {
  const source = await getExternalSource(client, slug);
  if (!source) throw new ExternalSourceError("not_found", `no hay ficha de la fuente externa «${slug}»: regístrala antes de usarla`);
  return source;
}

/**
 * Registra o actualiza la ficha de evaluación. No toca lo que solo se cambia
 * con una decisión explícita (autorización, importación, volumen, precisión).
 */
export async function upsertExternalSource(
  client: PoolClient, sheet: ExternalSourceSheet, context: { actor: string; reason: string },
): Promise<ExternalSourceRow> {
  const { rows } = await client.query<Record<string, unknown>>(`
    INSERT INTO ingest.genre_external_sources(
      slug, name, homepage, api_base, access_mode, access_note, license, attribution, terms_url,
      rate_limit_per_minute, levels, coverage_note, identifier_stability, tag_policy, status,
      precision_threshold, reason, evaluated_by, evaluated_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb,$15,$16,$17,$18,now())
    ON CONFLICT (slug) DO UPDATE SET
      name = EXCLUDED.name, homepage = EXCLUDED.homepage, api_base = EXCLUDED.api_base,
      access_mode = EXCLUDED.access_mode, access_note = EXCLUDED.access_note, license = EXCLUDED.license,
      attribution = EXCLUDED.attribution, terms_url = EXCLUDED.terms_url,
      rate_limit_per_minute = EXCLUDED.rate_limit_per_minute, levels = EXCLUDED.levels,
      coverage_note = EXCLUDED.coverage_note, identifier_stability = EXCLUDED.identifier_stability,
      tag_policy = EXCLUDED.tag_policy, precision_threshold = EXCLUDED.precision_threshold,
      reason = EXCLUDED.reason, evaluated_by = EXCLUDED.evaluated_by, evaluated_at = now(), updated_at = now()
    RETURNING *`, [
    sheet.slug, sheet.name, sheet.homepage, sheet.apiBase, sheet.accessMode, sheet.accessNote, sheet.license,
    sheet.attribution, sheet.termsUrl, sheet.rateLimitPerMinute, sheet.levels, sheet.coverageNote,
    sheet.identifierStability, JSON.stringify(sheet.tagPolicy), sheet.status, sheet.precisionThreshold,
    `${context.actor}: ${context.reason}`, context.actor,
  ]);
  return toRow(rows[0]!);
}

export interface AuthorizationChange {
  status?: ExternalSourceStatus;
  importEnabled?: boolean;
  bulkEnabled?: boolean;
}

/**
 * Autoriza, bloquea o habilita una fuente. La base rechaza habilitar la
 * importación de una fuente sin autorizar (el volumen ya no exige umbral
 * desde la regla del 2026-09-26: una fuente basta):
 * aquí se traduce ese rechazo a un error entendible.
 */
export async function setExternalAuthorization(
  client: PoolClient, slug: string, change: AuthorizationChange, context: { actor: string; reason: string },
): Promise<ExternalSourceRow> {
  const source = await requireExternalSource(client, slug);
  const status = change.status ?? source.status;
  const importEnabled = change.importEnabled ?? (status === "authorized" ? source.importEnabled : false);
  const bulkEnabled = change.bulkEnabled ?? (importEnabled ? source.bulkEnabled : false);
  if (importEnabled && status !== "authorized") {
    throw new ExternalSourceError("not_authorized", `la fuente ${slug} no está autorizada: no puede importar`);
  }
  const { rows } = await client.query<Record<string, unknown>>(`
    UPDATE ingest.genre_external_sources
       SET status = $2::text, import_enabled = $3, bulk_enabled = $4, reason = $5, updated_at = now(),
           authorized_by = CASE WHEN $2::text = 'authorized' THEN $6 ELSE authorized_by END,
           authorized_at = CASE WHEN $2::text = 'authorized' THEN now() ELSE authorized_at END
     WHERE slug = $1 RETURNING *`,
  [slug, status, importEnabled, bulkEnabled, `${context.actor}: ${context.reason}`, context.actor]);
  return toRow(rows[0]!);
}

/** Guarda la precisión medida sobre una muestra revisada (punto 9 y entregable). */
export async function recordPrecision(
  client: PoolClient, slug: string, measure: { precision: number; sampleSize: number; report: string },
): Promise<ExternalSourceRow> {
  const { rows } = await client.query<Record<string, unknown>>(`
    UPDATE ingest.genre_external_sources
       SET precision_measured = $2, sample_size = $3, sample_report = $4, measured_at = now(), updated_at = now()
     WHERE slug = $1 RETURNING *`, [slug, measure.precision, measure.sampleSize, measure.report]);
  if (!rows[0]) throw new ExternalSourceError("not_found", `no hay ficha de la fuente externa «${slug}»`);
  return toRow(rows[0]);
}

// --- Identidades -----------------------------------------------------------

export interface IdentityRecord {
  kind: GenreEntityKind;
  entityId: number;
  sourceId: number;
  externalId: string;
  externalName: string;
  externalUrl: string | null;
  score: number;
  signals: MatchSignal[];
  status: "matched" | "ambiguous" | "rejected";
  decidedBy: string;
  decisionKind?: "rule" | "human";
  reason: string;
  runId?: number | undefined;
}

export interface IdentityRow extends IdentityRecord {
  id: number;
  decisionKind: "rule" | "human";
}

export async function loadIdentity(
  client: PoolClient, kind: GenreEntityKind, entityId: number, sourceId: number,
): Promise<IdentityRow | undefined> {
  const { rows } = await client.query<Record<string, unknown>>(`
    SELECT * FROM ingest.genre_external_identities
     WHERE entity_kind = $1 AND entity_id = $2 AND source_id = $3 AND status = 'matched'`, [kind, entityId, sourceId]);
  const row = rows[0];
  if (!row) return undefined;
  return {
    id: Number(row["id"]), kind, entityId, sourceId,
    externalId: String(row["external_id"]), externalName: String(row["external_name"]),
    externalUrl: (row["external_url"] as string | null) ?? null, score: Number(row["score"]),
    signals: (row["signals"] as MatchSignal[] | null) ?? [], status: row["status"] as IdentityRow["status"],
    decidedBy: String(row["decided_by"]), decisionKind: row["decision_kind"] as "rule" | "human",
    reason: String(row["reason"]),
  };
}

/**
 * Guarda una identidad resuelta. Una decisión humana sobre la identidad no la
 * pisa ningún recálculo: si ya hay una fila `human`, esta función no la toca.
 */
export async function saveIdentity(client: PoolClient, record: IdentityRecord): Promise<void> {
  await client.query(`
    INSERT INTO ingest.genre_external_identities(
      entity_kind, entity_id, source_id, external_id, external_name, external_url, score, signals,
      status, decided_by, decision_kind, reason, run_id)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13)
    ON CONFLICT (entity_kind, entity_id, source_id, external_id) DO UPDATE
       SET external_name = EXCLUDED.external_name, external_url = EXCLUDED.external_url, score = EXCLUDED.score,
           signals = EXCLUDED.signals, status = EXCLUDED.status, decided_by = EXCLUDED.decided_by,
           decision_kind = EXCLUDED.decision_kind, reason = EXCLUDED.reason, run_id = EXCLUDED.run_id, updated_at = now()
     WHERE ingest.genre_external_identities.decision_kind = 'rule'`, [
    record.kind, record.entityId, record.sourceId, record.externalId, record.externalName, record.externalUrl,
    record.score, JSON.stringify(record.signals), record.status, record.decidedBy, record.decisionKind ?? "rule",
    record.reason, record.runId ?? null,
  ]);
}

// --- Sugerencias -----------------------------------------------------------

export interface SuggestionInput {
  kind: GenreEntityKind;
  entityId: number;
  genreId: number;
  sourceId: number;
  sourceSlug: string;
  externalId: string;
  externalUrl: string | null;
  rawValue: string;
  tagKind: ExternalTagKind;
  tagCount: number | null;
  fetchedAt: Date;
  evidenceUrl: string;
}

/**
 * Inserta la sugerencia externa. Si ya hay una fila para esa pareja
 * ficha–género (de las reglas, de una persona o de otra importación) NO se
 * toca nada: una fuente externa nunca sobrescribe.
 */
export async function insertSuggestion(client: PoolClient, input: SuggestionInput): Promise<boolean> {
  const evidence = [{
    source: "external",
    sourceSlug: input.sourceSlug,
    externalId: input.externalId,
    externalUrl: input.externalUrl,
    url: input.evidenceUrl,
    rawValue: input.rawValue,
    tagKind: input.tagKind,
    tagCount: input.tagCount,
    fetchedAt: input.fetchedAt.toISOString(),
  }];
  const { rowCount } = await client.query(`
    INSERT INTO ${GENRE_TABLE[input.kind]}(
      ${GENRE_COLUMN[input.kind]}, genre_id, role, status, confidence, source_kind, source_id, claim_ids,
      raw_value, evidence, decided_by, decision_rule, decision_kind, decision_note,
      external_source_id, external_ref)
    VALUES($1,$2,'secondary','suggested',$3,'external',NULL,'{}',$4,$5::jsonb,$6,'external_suggestion','rule',$7,$8,$9)
    ON CONFLICT (${GENRE_COLUMN[input.kind]}, genre_id) DO NOTHING`, [
    input.entityId, input.genreId,
    input.tagKind === "editorial_genre" ? "medium" : "low",
    input.rawValue, JSON.stringify(evidence), `externa:${input.sourceSlug}`,
    `sugerencia de ${input.sourceSlug} (${input.externalId})`, input.sourceId, input.externalId,
  ]);
  return (rowCount ?? 0) > 0;
}

/** Estado de géneros de la ficha, para no proponer lo que CRV ya tiene. */
export async function loadCrvState(
  client: PoolClient, kind: GenreEntityKind, entityId: number,
): Promise<{ primaryGenreId: number | null; confirmedGenreIds: number[]; suggestedGenreIds: number[]; rejectedGenreIds: number[] }> {
  const { rows } = await client.query<{ genre_id: string; role: string; status: string; derived: boolean }>(`
    SELECT genre_id::text, role, status, (source_kind = 'albums' AND decision_kind = 'rule') AS derived
      FROM ${GENRE_TABLE[kind]} WHERE ${GENRE_COLUMN[kind]} = $1`, [entityId]);
  const state = { primaryGenreId: null as number | null, confirmedGenreIds: [] as number[], suggestedGenreIds: [] as number[], rejectedGenreIds: [] as number[] };
  for (const row of rows) {
    const genreId = Number(row.genre_id);
    if (row.status === "confirmed") {
      state.confirmedGenreIds.push(genreId);
      // Lo que el artista recibe de sus discos (0036) ya se ve, pero no es su
      // principal propio: una fuente que nombra otro no lo contradice.
      if (row.role === "primary" && !row.derived) state.primaryGenreId = genreId;
    } else if (row.status === "suggested") state.suggestedGenreIds.push(genreId);
    else if (row.status === "rejected") state.rejectedGenreIds.push(genreId);
  }
  return state;
}

// --- Casos de revisión -----------------------------------------------------

export type ExternalCase =
  | "external_ambiguous_identity"
  | "external_disagreement"
  | "external_unmapped_term"
  | "external_too_generic";

const CASE_PRIORITY: Readonly<Record<ExternalCase, number>> = {
  external_disagreement: 4,
  external_ambiguous_identity: 5,
  external_unmapped_term: 5,
  external_too_generic: 6,
};

/**
 * Abre un caso de la importación externa, sin duplicar. Una decisión humana
 * sobre la misma huella permanece cerrada en importaciones posteriores.
 */
export async function openExternalCase(
  client: PoolClient, kind: GenreEntityKind, entityId: number,
  item: { genreCase: ExternalCase; fingerprint: string; detail: Record<string, unknown>; note: string },
): Promise<number | null> {
  const column = kind === "album" ? "album_id" : "artist_a_id";
  const existing = await client.query(`
    SELECT 1 FROM ingest.review_queue
     WHERE kind = $1::ingest.review_kind
       AND (status IN ('open','in_progress')
         OR (status IN ('approved','dismissed') AND resolved_by = 'human'))
       AND payload->>'origin' = $2 AND payload->>'fingerprint' = $3`,
  [EXTERNAL_REVIEW_KIND, EXTERNAL_REVIEW_ORIGIN, item.fingerprint]);
  if (existing.rowCount) return null;
  const { rows } = await client.query<{ id: string }>(`
    INSERT INTO ingest.review_queue(kind, priority, ${column}, payload, notes)
    VALUES($1::ingest.review_kind, $2, $3, $4::jsonb, $5) RETURNING id::text`, [
    EXTERNAL_REVIEW_KIND, CASE_PRIORITY[item.genreCase], entityId,
    JSON.stringify({
      origin: EXTERNAL_REVIEW_ORIGIN, entityKind: kind, entityId,
      genreCase: item.genreCase, fingerprint: item.fingerprint, ...item.detail,
    }),
    item.note.slice(0, 500),
  ]);
  return Number(rows[0]!.id);
}

// --- Registro y apagado ----------------------------------------------------

export async function recordImport(
  client: PoolClient, entry: {
    sourceId: number; mode: "sample" | "bulk"; level: GenreEntityKind; dryRun: boolean;
    stats: Record<string, unknown>; actor: string; reason: string; runId?: number | undefined;
  },
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(`
    INSERT INTO ingest.genre_external_imports(source_id, mode, level, dry_run, stats, actor, reason, run_id)
    VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8) RETURNING id::text`,
  [entry.sourceId, entry.mode, entry.level, entry.dryRun, JSON.stringify(entry.stats), entry.actor, entry.reason, entry.runId ?? null]);
  return Number(rows[0]!.id);
}

export interface PurgeResult { artist: number; album: number; cases: number }

/**
 * Retira las propuestas sin resolver de una fuente. Lo que una persona
 * confirmó o rechazó (`decision_kind = 'human'`) NO se toca: apagar la
 * importación no borra decisiones editoriales.
 */
export async function purgeSuggestions(client: PoolClient, sourceId: number): Promise<PurgeResult> {
  const counts: PurgeResult = { artist: 0, album: 0, cases: 0 };
  for (const kind of ["artist", "album"] as const) {
    const { rowCount } = await client.query(`
      DELETE FROM ${GENRE_TABLE[kind]}
       WHERE external_source_id = $1 AND source_kind = 'external' AND status = 'suggested' AND decision_kind = 'rule'`, [sourceId]);
    counts[kind] = rowCount ?? 0;
  }
  const { rowCount } = await client.query(`
    UPDATE ingest.review_queue
       SET status = 'dismissed', resolved_by = 'system', resolved_at = now(), updated_at = now(),
           resolution_note = concat_ws(' · ', resolution_note, 'la fuente externa se retiró')
     WHERE kind = $1::ingest.review_kind AND status IN ('open','in_progress')
       AND payload->>'origin' = $2 AND (payload->>'externalSourceId')::bigint = $3`,
  [EXTERNAL_REVIEW_KIND, EXTERNAL_REVIEW_ORIGIN, sourceId]);
  counts.cases = rowCount ?? 0;
  return counts;
}
