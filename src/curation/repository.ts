// CRV · Lecturas y decisiones sobre los hallazgos de Curaduría.
import { getPool } from "../db/client.js";
import { updateEntity, withOperatorRun } from "../merge/operator.js";
import type { ResolvableClaimKind } from "../merge/specs.js";
import { DETECTOR_DEFINITIONS } from "./analyze.js";
import type { Resolution } from "./resolution.js";
import { CATEGORIES, OTHER_CATEGORY } from "./taxonomy.js";
import type { EntityRef, Severity } from "./types.js";

export type FindingStatus = "open" | "ignored" | "resolved";

/** Por qué una persona dijo «no es un problema» (PLAN_CURADURIA E2, M4): el dato de la precisión por detector. */
export const IGNORE_REASONS = ["falso_positivo", "correcto_a_proposito", "fuera_de_alcance"] as const;
export type IgnoreReason = (typeof IGNORE_REASONS)[number];

/** Tipos de ficha que admiten «son distintas» (`ingest.curation_distinct_pairs`). */
export const DISTINCT_PAIR_KINDS = ["artist", "person", "organization", "album", "track"] as const;
export type DistinctPairKind = (typeof DISTINCT_PAIR_KINDS)[number];

export interface ScanRow {
  id: number;
  status: string;
  trigger: string;
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  counters: Record<string, unknown>;
}

export interface SignatureSummary { key: string; label: string; open: number; }
export interface DetectorSummary {
  key: string; label: string; description: string;
  open: number; ignored: number; resolved: number; newInLastScan: number;
  signatures: SignatureSummary[];
}
export interface CategorySummary {
  key: string; label: string; description: string;
  open: number; ignored: number; resolved: number; newInLastScan: number; chainedOpen: number;
  severity: Record<Severity, number>;
  detectors: DetectorSummary[];
}

export interface CurationSummary {
  lastScan: ScanRow | null;
  lastCorrection: ScanRow | null;
  running: boolean;
  totals: { open: number; ignored: number; resolved: number; newInLastScan: number; chainedOpen: number };
  categories: CategorySummary[];
}

export interface FindingRow {
  id: number;
  category: string;
  detector: string;
  detectorLabel: string;
  signature: string;
  signatureLabel: string;
  severity: Severity;
  entity: EntityRef;
  field: string | null;
  value: string | null;
  title: string;
  suggestion: string | null;
  suggestedValue: string | null;
  related: EntityRef[];
  evidence: Record<string, unknown>;
  status: FindingStatus;
  isNew: boolean;
  triggeredBy: Array<{ id: number; title: string; entityKind: string; entityId: number | null }>;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  ignoredAt: string | null;
  ignoredBy: string | null;
  ignoreNote: string | null;
  /** Motivo del «no es un problema»; se conserva si luego se resolvió. null si se ignoró antes de 0020. */
  ignoreReason: IgnoreReason | null;
  /** Por qué se resolvió (null si sigue abierto, está ignorado o se resolvió antes de 0019). */
  resolution: Resolution | null;
  /** Run de escritura que cambió el valor detectado, y quién lo firmó. */
  resolvedByRunId: number | null;
  resolvedBy: string | null;
}

const DETECTOR_BY_KEY = new Map(DETECTOR_DEFINITIONS.map((detector) => [detector.key, detector]));
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

type RawScan = { id: string; status: string; trigger: string; requested_by: string | null; started_at: Date; finished_at: Date | null; error: string | null; counters: Record<string, unknown> };

function scanRow(row: RawScan): ScanRow {
  return {
    id: Number(row.id), status: row.status, trigger: row.trigger, requestedBy: row.requested_by,
    startedAt: iso(row.started_at)!, finishedAt: iso(row.finished_at), error: row.error, counters: row.counters,
  };
}

const SCAN_COLUMNS = "id::text, status, trigger, requested_by, started_at, finished_at, error, counters";

export async function listScans(limit = 20): Promise<ScanRow[]> {
  const { rows } = await getPool().query<RawScan>(`SELECT ${SCAN_COLUMNS} FROM ingest.curation_scans ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map(scanRow);
}

/** Un análisis parcial también guardó lo que miró: cuenta como análisis hecho. */
const SAVED_SCAN = "status IN ('ok', 'partial')";

async function lastOkScanId(): Promise<number | null> {
  const { rows } = await getPool().query<{ id: string }>(`SELECT id::text FROM ingest.curation_scans WHERE ${SAVED_SCAN} ORDER BY id DESC LIMIT 1`);
  return rows[0] ? Number(rows[0].id) : null;
}

export async function getCurationSummary(running: boolean): Promise<CurationSummary> {
  const pool = getPool();
  const [last, correction, counts] = await Promise.all([
    // Un análisis omitido (otro proceso analizaba) no es «el último análisis».
    pool.query<RawScan>(`SELECT ${SCAN_COLUMNS} FROM ingest.curation_scans WHERE status NOT IN ('running', 'skipped') ORDER BY id DESC LIMIT 1`),
    pool.query<RawScan>(`SELECT ${SCAN_COLUMNS} FROM ingest.curation_scans WHERE trigger = 'correccion' AND ${SAVED_SCAN} ORDER BY id DESC LIMIT 1`),
    pool.query<{ category: string; detector: string; signature: string; label: string | null; status: FindingStatus; severity: Severity; n: number; fresh: number; chained: number }>(`
      WITH last_ok AS (SELECT max(id) AS id FROM ingest.curation_scans WHERE ${SAVED_SCAN})
      SELECT category, detector, signature, max(evidence->>'signatureLabel') AS label, status, severity,
             count(*)::int AS n,
             count(*) FILTER (WHERE first_seen_scan_id = (SELECT id FROM last_ok))::int AS fresh,
             count(*) FILTER (WHERE evidence ? 'triggeredBy')::int AS chained
        FROM ingest.curation_findings
       GROUP BY category, detector, signature, status, severity`),
  ]);

  const known = new Set(CATEGORIES.map((category) => category.key));
  const categories = new Map<string, CategorySummary>(CATEGORIES.map((category) => [category.key, {
    ...category, open: 0, ignored: 0, resolved: 0, newInLastScan: 0, chainedOpen: 0,
    severity: { high: 0, medium: 0, low: 0 },
    detectors: DETECTOR_DEFINITIONS.filter((detector) => detector.category === category.key)
      .map((detector) => ({ key: detector.key, label: detector.label, description: detector.description, open: 0, ignored: 0, resolved: 0, newInLastScan: 0, signatures: [] })),
  }]));

  for (const row of counts.rows) {
    // Una categoría guardada que la taxonomía ya no conoce se muestra en «Otros».
    const category = categories.get(known.has(row.category) ? row.category : OTHER_CATEGORY)!;
    let detector = category.detectors.find((item) => item.key === row.detector);
    if (!detector) {
      const definition = DETECTOR_BY_KEY.get(row.detector);
      detector = { key: row.detector, label: definition?.label ?? row.detector, description: definition?.description ?? "", open: 0, ignored: 0, resolved: 0, newInLastScan: 0, signatures: [] };
      category.detectors.push(detector);
    }
    category[row.status] += row.n;
    detector[row.status] += row.n;
    if (row.status === "open") {
      category.severity[row.severity] += row.n;
      category.newInLastScan += row.fresh;
      category.chainedOpen += row.chained;
      detector.newInLastScan += row.fresh;
      const signature = detector.signatures.find((item) => item.key === row.signature);
      if (signature) signature.open += row.n;
      else detector.signatures.push({ key: row.signature, label: row.label ?? detector.label, open: row.n });
    }
  }

  const list = [...categories.values()];
  for (const category of list) {
    for (const detector of category.detectors) detector.signatures.sort((a, b) => b.open - a.open);
    category.detectors.sort((a, b) => b.open - a.open);
  }
  return {
    lastScan: last.rows[0] ? scanRow(last.rows[0]) : null,
    lastCorrection: correction.rows[0] ? scanRow(correction.rows[0]) : null,
    running,
    totals: {
      open: list.reduce((sum, item) => sum + item.open, 0),
      ignored: list.reduce((sum, item) => sum + item.ignored, 0),
      resolved: list.reduce((sum, item) => sum + item.resolved, 0),
      newInLastScan: list.reduce((sum, item) => sum + item.newInLastScan, 0),
      chainedOpen: list.reduce((sum, item) => sum + item.chainedOpen, 0),
    },
    categories: list,
  };
}

export interface FindingQuery {
  category?: string | undefined;
  detector?: string | undefined;
  signature?: string | undefined;
  severity?: Severity | undefined;
  entityKind?: string | undefined;
  status?: FindingStatus | "all" | undefined;
  q?: string | undefined;
  /** Solo lo que apareció en ese análisis. */
  scanId?: number | undefined;
  /** Solo lo que apareció al corregir otro hallazgo. */
  chained?: boolean | undefined;
  limit: number;
  offset: number;
}

type RawFinding = {
  id: string; category: string; detector: string; signature: string; severity: Severity; entity_kind: string; entity_id: string | null;
  entity_label: string | null; field: string | null; value: string | null; title: string; suggestion: string | null;
  suggested_value: string | null; related: EntityRef[];
  evidence: Record<string, unknown>; status: FindingStatus; first_seen_scan_id: string | null; first_seen_at: Date; last_seen_at: Date;
  resolved_at: Date | null; ignored_at: Date | null; ignored_by: string | null; ignore_note: string | null; ignore_reason: IgnoreReason | null;
  resolution: Resolution | null; resolved_by_run_id: string | null; resolved_by: string | null; total: string;
};

/** Quién firmó el run que resolvió el hallazgo sale del propio run (`params.operator`). */
const RESOLUTION_COLUMNS = `resolution, resolved_by_run_id::text,
             (SELECT r.params->>'operator' FROM ingest.scrape_runs r WHERE r.id = resolved_by_run_id) AS resolved_by`;

function findingRow(row: RawFinding, lastScan: number | null): FindingRow {
  const definition = DETECTOR_BY_KEY.get(row.detector);
  const evidence = row.evidence ?? {};
  return {
    id: Number(row.id), category: row.category, detector: row.detector, detectorLabel: definition?.label ?? row.detector,
    signature: row.signature, signatureLabel: typeof evidence["signatureLabel"] === "string" ? evidence["signatureLabel"] : definition?.label ?? row.signature,
    severity: row.severity,
    entity: { kind: row.entity_kind as EntityRef["kind"], id: row.entity_id === null ? null : Number(row.entity_id), label: row.entity_label ?? "" },
    field: row.field, value: row.value, title: row.title, suggestion: row.suggestion, suggestedValue: row.suggested_value,
    related: row.related ?? [], evidence,
    status: row.status, isNew: lastScan !== null && row.first_seen_scan_id !== null && Number(row.first_seen_scan_id) === lastScan,
    triggeredBy: Array.isArray(evidence["triggeredBy"]) ? evidence["triggeredBy"] as FindingRow["triggeredBy"] : [],
    firstSeenAt: iso(row.first_seen_at)!, lastSeenAt: iso(row.last_seen_at)!, resolvedAt: iso(row.resolved_at),
    ignoredAt: iso(row.ignored_at), ignoredBy: row.ignored_by, ignoreNote: row.ignore_note, ignoreReason: row.ignore_reason,
    resolution: row.resolution, resolvedByRunId: row.resolved_by_run_id === null ? null : Number(row.resolved_by_run_id), resolvedBy: row.resolved_by,
  };
}

export async function listFindings(query: FindingQuery): Promise<{ rows: FindingRow[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };
  if (query.category === OTHER_CATEGORY) {
    params.push(CATEGORIES.map((category) => category.key).filter((key) => key !== OTHER_CATEGORY));
    where.push(`(category = '${OTHER_CATEGORY}' OR NOT (category = ANY($${params.length}::text[])))`);
  } else if (query.category) add("category = ?", query.category);
  if (query.detector) add("detector = ?", query.detector);
  if (query.signature) add("signature = ?", query.signature);
  if (query.severity) add("severity = ?", query.severity);
  if (query.entityKind) add("entity_kind = ?", query.entityKind);
  if (query.status && query.status !== "all") add("status = ?", query.status);
  if (query.scanId !== undefined) add("first_seen_scan_id = ?", query.scanId);
  if (query.chained) where.push("evidence ? 'triggeredBy'");
  if (query.q?.trim()) {
    params.push(`%${query.q.trim().replace(/[\\%_]/gu, (char) => `\\${char}`)}%`);
    where.push(`(value ILIKE $${params.length} OR entity_label ILIKE $${params.length} OR title ILIKE $${params.length})`);
  }
  params.push(query.limit, query.offset);
  const [lastScan, result] = await Promise.all([
    lastOkScanId(),
    getPool().query<RawFinding>(`
      SELECT id::text, category, detector, signature, severity, entity_kind, entity_id::text, entity_label, field, value, title, suggestion,
             suggested_value, related, evidence, status, first_seen_scan_id::text, first_seen_at, last_seen_at, resolved_at, ignored_at, ignored_by, ignore_note, ignore_reason,
             ${RESOLUTION_COLUMNS},
             count(*) OVER ()::text AS total
        FROM ingest.curation_findings
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, first_seen_at DESC, id
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
  ]);
  return { rows: result.rows.map((row) => findingRow(row, lastScan)), total: Number(result.rows[0]?.total ?? 0) };
}

export class CurationError extends Error {
  constructor(readonly code: "not_found" | "not_open" | "not_fixable" | "invalid", message: string) { super(message); }
}

/**
 * «No es un problema», con motivo. Dura mientras el detector siga viendo el
 * mismo hallazgo; si el problema desaparece, el análisis lo resuelve (scan.ts).
 */
export async function ignoreFinding(id: number, operator: string, reason: IgnoreReason, note: string | null): Promise<FindingRow> {
  const { rows } = await getPool().query<{ status: string }>("SELECT status FROM ingest.curation_findings WHERE id = $1", [id]);
  if (!rows[0]) throw new CurationError("not_found", `hallazgo inexistente: ${id}`);
  if (rows[0].status !== "open") throw new CurationError("not_open", "Solo se puede ignorar un hallazgo abierto.");
  await getPool().query(`
    UPDATE ingest.curation_findings SET status = 'ignored', ignored_at = now(), ignored_by = $2, ignore_reason = $3, ignore_note = $4 WHERE id = $1`,
  [id, operator, reason, note]);
  return (await getFinding(id))!;
}

export async function reopenFinding(id: number): Promise<FindingRow> {
  const { rows } = await getPool().query<{ status: string }>("SELECT status FROM ingest.curation_findings WHERE id = $1", [id]);
  if (!rows[0]) throw new CurationError("not_found", `hallazgo inexistente: ${id}`);
  if (rows[0].status !== "ignored") throw new CurationError("not_open", "Solo se puede reabrir un hallazgo ignorado.");
  await getPool().query(`
    UPDATE ingest.curation_findings SET status = 'open', ignored_at = NULL, ignored_by = NULL, ignore_note = NULL, ignore_reason = NULL WHERE id = $1`, [id]);
  return (await getFinding(id))!;
}

/** Ignora de una vez todo un grupo abierto (detector y, si se indica, subgrupo). */
export async function ignoreGroup(
  input: { category: string; detector: string; signature?: string | undefined }, operator: string, reason: IgnoreReason, note: string,
): Promise<number> {
  const params: unknown[] = [operator, note, reason, input.category, input.detector];
  let signatureClause = "";
  if (input.signature) { params.push(input.signature); signatureClause = `AND signature = $${params.length}`; }
  const result = await getPool().query(`
    UPDATE ingest.curation_findings SET status = 'ignored', ignored_at = now(), ignored_by = $1, ignore_note = $2, ignore_reason = $3
     WHERE status = 'open' AND category = $4 AND detector = $5 ${signatureClause}`, params);
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// «Son distintas»: un par de fichas del mismo tipo que el detector de
// duplicados no debe volver a proponer, aunque cambie el grupo o el nombre.
// No toca el core: es una decisión sobre el detector, con quién y por qué.
// ---------------------------------------------------------------------------

export interface DistinctPairRow {
  id: number;
  kind: DistinctPairKind;
  aId: number;
  bId: number;
  decidedBy: string;
  note: string;
  createdAt: string;
}

/** Tabla del core de cada tipo (nombres fijos, no vienen del usuario). */
const CORE_TABLE: Readonly<Record<DistinctPairKind, string>> = {
  artist: "public.artists", person: "public.persons", organization: "public.organizations", album: "public.albums", track: "public.tracks",
};

type RawDistinctPair = { id: string; kind: DistinctPairKind; a_id: string; b_id: string; decided_by: string; note: string; created_at: Date };

function distinctPairRow(row: RawDistinctPair): DistinctPairRow {
  return { id: Number(row.id), kind: row.kind, aId: Number(row.a_id), bId: Number(row.b_id), decidedBy: row.decided_by, note: row.note, createdAt: iso(row.created_at)! };
}

/** Declara distinto un par. Repetir la declaración devuelve la que ya existía, sin duplicarla. */
export async function declareDistinctPair(
  input: { kind: DistinctPairKind; aId: number; bId: number }, operator: string, note: string,
): Promise<{ pair: DistinctPairRow; created: boolean }> {
  if (input.aId === input.bId) throw new CurationError("invalid", "Un par necesita dos fichas distintas.");
  const [a, b] = input.aId < input.bId ? [input.aId, input.bId] : [input.bId, input.aId];
  const found = await getPool().query<{ id: string }>(`SELECT id::text FROM ${CORE_TABLE[input.kind]} WHERE id = ANY($1::bigint[])`, [[a, b]]);
  if (found.rows.length !== 2) throw new CurationError("not_found", `alguna de las fichas ${a} y ${b} no existe`);
  const inserted = await getPool().query<RawDistinctPair>(`
    INSERT INTO ingest.curation_distinct_pairs (kind, a_id, b_id, decided_by, note) VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (kind, a_id, b_id) DO NOTHING
    RETURNING id::text, kind, a_id::text, b_id::text, decided_by, note, created_at`, [input.kind, a, b, operator, note]);
  if (inserted.rows[0]) return { pair: distinctPairRow(inserted.rows[0]), created: true };
  const existing = await getPool().query<RawDistinctPair>(`
    SELECT id::text, kind, a_id::text, b_id::text, decided_by, note, created_at FROM ingest.curation_distinct_pairs
     WHERE kind = $1 AND a_id = $2 AND b_id = $3`, [input.kind, a, b]);
  return { pair: distinctPairRow(existing.rows[0]!), created: false };
}

export async function listDistinctPairs(query: { kind?: DistinctPairKind | undefined; limit: number; offset: number }): Promise<{ rows: DistinctPairRow[]; total: number }> {
  const { rows } = await getPool().query<RawDistinctPair & { total: string }>(`
    SELECT id::text, kind, a_id::text, b_id::text, decided_by, note, created_at, count(*) OVER ()::text AS total
      FROM ingest.curation_distinct_pairs
     WHERE ($1::text IS NULL OR kind = $1)
     ORDER BY id DESC LIMIT $2 OFFSET $3`, [query.kind ?? null, query.limit, query.offset]);
  return { rows: rows.map(distinctPairRow), total: Number(rows[0]?.total ?? 0) };
}

/** Retira la declaración: el detector puede volver a proponer el par. */
export async function removeDistinctPair(id: number): Promise<DistinctPairRow> {
  const { rows } = await getPool().query<RawDistinctPair>(`
    DELETE FROM ingest.curation_distinct_pairs WHERE id = $1
    RETURNING id::text, kind, a_id::text, b_id::text, decided_by, note, created_at`, [id]);
  if (!rows[0]) throw new CurationError("not_found", `par declarado inexistente: ${id}`);
  return distinctPairRow(rows[0]);
}

// ---------------------------------------------------------------------------
// Corregir: a diferencia de «ignorar», esto SÍ cambia el catálogo. Solo se
// ofrece donde el detector ya calculó un reemplazo determinista del campo
// (`suggested_value`, hoy solo «nombres sucios»): el mismo campo, el mismo
// tipo de dato, sin ambigüedad. Cada corrección pasa por `merge/operator.ts`
// (un `withOperatorRun` por ficha), así que cada una queda en `merge_audit`
// con su propia nota, igual que si se hubiera editado la ficha a mano.
// ---------------------------------------------------------------------------

const FIXABLE_FIELDS = new Set(["name", "title"]);
const REAL_ENTITY_KINDS = new Set<string>(["artist", "person", "organization", "album", "track"]);

function isFixableKind(kind: string): kind is ResolvableClaimKind {
  return REAL_ENTITY_KINDS.has(kind);
}

interface FixableRow {
  id: string;
  status: FindingStatus;
  field: string | null;
  entity_kind: string;
  entity_id: string | null;
  suggested_value: string | null;
}

const FIXABLE_COLUMNS = "id::text, status, field, entity_kind, entity_id::text, suggested_value";

function assertFixable(row: FixableRow, valueOverride?: string): { kind: ResolvableClaimKind; id: number; field: string; value: string } {
  if (row.entity_kind === "") throw new CurationError("not_found", `hallazgo inexistente: ${row.id}`);
  if (row.status !== "open") throw new CurationError("not_open", `el hallazgo ${row.id} no está abierto`);
  if (!row.field || !FIXABLE_FIELDS.has(row.field) || !isFixableKind(row.entity_kind) || row.entity_id === null) {
    throw new CurationError("not_fixable", `el hallazgo ${row.id} no tiene una corrección disponible: hay que editar la ficha`);
  }
  const value = (valueOverride ?? row.suggested_value ?? "").trim();
  if (!value) throw new CurationError("not_fixable", `el hallazgo ${row.id} no tiene un valor sugerido`);
  return { kind: row.entity_kind, id: Number(row.entity_id), field: row.field, value };
}

/** Corrige la ficha de un hallazgo: aplica `value` (o su `suggested_value`) al campo detectado. */
export async function fixFinding(id: number, operator: string, note: string, value?: string): Promise<FindingRow> {
  const { rows } = await getPool().query<FixableRow>(`SELECT ${FIXABLE_COLUMNS} FROM ingest.curation_findings WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) throw new CurationError("not_found", `hallazgo inexistente: ${id}`);
  const fix = assertFixable(row, value);
  await withOperatorRun({
    name: "api:curation:fix", operator, note,
    params: { findingId: id, kind: fix.kind, id: fix.id, field: fix.field, value: fix.value },
  }, (context) => updateEntity(context, fix.kind, fix.id, { [fix.field]: fix.value }));
  return (await getFinding(id))!;
}

export interface FixOutcome { id: number; ok: boolean; error: string | null; }

async function applyFixRows(rows: FixableRow[], operator: string, note: string): Promise<FixOutcome[]> {
  const outcomes: FixOutcome[] = [];
  for (const row of rows) {
    try {
      const fix = assertFixable(row);
      await withOperatorRun({
        name: "api:curation:fix", operator, note,
        params: { findingId: row.id, kind: fix.kind, id: fix.id, field: fix.field, value: fix.value },
      }, (context) => updateEntity(context, fix.kind, fix.id, { [fix.field]: fix.value }));
      outcomes.push({ id: Number(row.id), ok: true, error: null });
    } catch (error) {
      outcomes.push({ id: Number(row.id), ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcomes;
}

/** Corrige varios hallazgos elegidos a mano (selección en la lista), cada uno con su propio valor sugerido. */
export async function fixFindingsSelected(ids: number[], operator: string, note: string): Promise<FixOutcome[]> {
  if (ids.length === 0) return [];
  const { rows } = await getPool().query<FixableRow>(`SELECT ${FIXABLE_COLUMNS} FROM ingest.curation_findings WHERE id = ANY($1::bigint[])`, [ids]);
  const byId = new Map(rows.map((row) => [row.id, row]));
  const found = ids.map((id): FixableRow => byId.get(String(id))
    ?? { id: String(id), status: "resolved", field: null, entity_kind: "", entity_id: null, suggested_value: null });
  return applyFixRows(found, operator, note);
}

const FIX_GROUP_LIMIT = 500;

/** Corrige de una vez todo un grupo abierto y corregible (detector y, si se indica, subgrupo). */
export async function fixFindingsGroup(
  input: { category: string; detector: string; signature?: string | undefined }, operator: string, note: string,
): Promise<{ outcomes: FixOutcome[]; more: boolean }> {
  const params: unknown[] = [input.category, input.detector];
  let signatureClause = "";
  if (input.signature) { params.push(input.signature); signatureClause = `AND signature = $${params.length}`; }
  params.push([...FIXABLE_FIELDS]);
  const fieldParamIndex = params.length;
  params.push([...REAL_ENTITY_KINDS]);
  const kindParamIndex = params.length;
  params.push(FIX_GROUP_LIMIT + 1);
  const { rows } = await getPool().query<FixableRow>(`
    SELECT ${FIXABLE_COLUMNS} FROM ingest.curation_findings
     WHERE status = 'open' AND category = $1 AND detector = $2 ${signatureClause}
       AND field = ANY($${fieldParamIndex}::text[]) AND entity_kind = ANY($${kindParamIndex}::text[])
       AND entity_id IS NOT NULL AND suggested_value IS NOT NULL AND btrim(suggested_value) <> ''
     ORDER BY id
     LIMIT $${params.length}`, params);
  const more = rows.length > FIX_GROUP_LIMIT;
  const outcomes = await applyFixRows(rows.slice(0, FIX_GROUP_LIMIT), operator, note);
  return { outcomes, more };
}

export async function getFinding(id: number): Promise<FindingRow | undefined> {
  const [lastScan, result] = await Promise.all([
    lastOkScanId(),
    getPool().query<RawFinding>(`
      SELECT id::text, category, detector, signature, severity, entity_kind, entity_id::text, entity_label, field, value, title, suggestion,
             suggested_value, related, evidence, status, first_seen_scan_id::text, first_seen_at, last_seen_at, resolved_at, ignored_at, ignored_by, ignore_note, ignore_reason,
             ${RESOLUTION_COLUMNS}, '1' AS total
        FROM ingest.curation_findings WHERE id = $1`, [id]),
  ]);
  return result.rows[0] ? findingRow(result.rows[0], lastScan) : undefined;
}
