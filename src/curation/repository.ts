// CRV · Lecturas y decisiones sobre los hallazgos de Curaduría.
//
// Corregir ya no vive aquí: toda corrección es un lote de acciones tipadas con
// vista previa, aplicación y deshacer (src/curation/actions/, PLAN_CURADURIA
// E4). Este módulo lee hallazgos, análisis y decisiones que no tocan el core.
import type { Pool, PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { DETECTOR_DEFINITIONS } from "./analyze.js";
import { summarizeActions, type ActionSummary } from "./actions/registry.js";
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
  /** completo | dirigido (verificación de un lote de correcciones). */
  scope: string;
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
  /** Acciones de corrección que declara, por subgrupo (`*` = todos). */
  actions?: Record<string, string[]>;
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
  /** Acciones de corrección que se ofrecen (la primera es la recomendada); vacío = hay que editar la ficha. */
  actions: ActionSummary[];
}

const DETECTOR_BY_KEY = new Map(DETECTOR_DEFINITIONS.map((detector) => [detector.key, detector]));
const iso = (value: Date | string | null): string | null => (value === null ? null : new Date(value).toISOString());

type RawScan = { id: string; status: string; scope: string; trigger: string; requested_by: string | null; started_at: Date; finished_at: Date | null; error: string | null; counters: Record<string, unknown> };

function scanRow(row: RawScan): ScanRow {
  return {
    id: Number(row.id), status: row.status, scope: row.scope, trigger: row.trigger, requestedBy: row.requested_by,
    startedAt: iso(row.started_at)!, finishedAt: iso(row.finished_at), error: row.error, counters: row.counters,
  };
}

const SCAN_COLUMNS = "id::text, status, scope, trigger, requested_by, started_at, finished_at, error, counters";

export async function listScans(limit = 20): Promise<ScanRow[]> {
  const { rows } = await getPool().query<RawScan>(`SELECT ${SCAN_COLUMNS} FROM ingest.curation_scans ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map(scanRow);
}

/** Un análisis parcial también guardó lo que miró: cuenta como análisis hecho. */
const SAVED_SCAN = "status IN ('ok', 'partial')";
/**
 * Solo un análisis del catálogo entero es «el último análisis»: una
 * verificación dirigida (E4.6) solo miró las fichas de un lote, y lo que
 * encontró no es «nuevo en el último análisis».
 */
const COMPLETE_SCAN = `${SAVED_SCAN} AND scope = 'completo'`;

type CurationQueryable = Pick<Pool | PoolClient, "query">;

async function lastOkScanId(queryable: CurationQueryable = getPool()): Promise<number | null> {
  const { rows } = await queryable.query<{ id: string }>(`SELECT id::text FROM ingest.curation_scans WHERE ${COMPLETE_SCAN} ORDER BY id DESC LIMIT 1`);
  return rows[0] ? Number(rows[0].id) : null;
}

export async function getCurationSummary(running: boolean): Promise<CurationSummary> {
  const pool = getPool();
  const [last, correction, counts] = await Promise.all([
    // Un análisis omitido (otro proceso analizaba) no es «el último análisis», ni una verificación dirigida.
    pool.query<RawScan>(`SELECT ${SCAN_COLUMNS} FROM ingest.curation_scans WHERE status NOT IN ('running', 'skipped') AND scope = 'completo' ORDER BY id DESC LIMIT 1`),
    // La última verificación tras una corrección sí puede ser dirigida: es lo que verificó el último lote.
    pool.query<RawScan>(`SELECT ${SCAN_COLUMNS} FROM ingest.curation_scans WHERE trigger = 'correccion' AND ${SAVED_SCAN} ORDER BY id DESC LIMIT 1`),
    pool.query<{ category: string; detector: string; signature: string; label: string | null; status: FindingStatus; severity: Severity; n: number; fresh: number; chained: number }>(`
      WITH last_ok AS (SELECT max(id) AS id FROM ingest.curation_scans WHERE ${COMPLETE_SCAN})
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
      .map((detector) => ({
        key: detector.key, label: detector.label, description: detector.description, open: 0, ignored: 0, resolved: 0, newInLastScan: 0, signatures: [],
        ...(detector.actions ? { actions: Object.fromEntries(Object.entries(detector.actions).map(([signature, keys]) => [signature, [...keys]])) } : {}),
      })),
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

/** Filtros del listado, sin paginar: los mismos que aceptan las acciones de grupo (C3, PLAN_CURADURIA E3). */
export interface FindingFilter {
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
}

export interface FindingQuery extends FindingFilter {
  limit: number;
  offset: number;
}

/**
 * Construye el WHERE de `FindingFilter`. Lo comparten `listFindings` y las
 * acciones de grupo (`ignoreGroup`, los lotes de correcciones de grupo): antes, esas acciones
 * solo miraban `category/detector/signature` y afectaban más de lo que la
 * pantalla mostraba (C3, PLAN_CURADURIA E3.1) — un filtro de gravedad, tipo de
 * ficha, texto, análisis o encadenados quedaba fuera de la escritura.
 */
function buildFindingsWhere(filter: FindingFilter): { where: string[]; params: unknown[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); where.push(sql.replace("?", `$${params.length}`)); };
  if (filter.category === OTHER_CATEGORY) {
    params.push(CATEGORIES.map((category) => category.key).filter((key) => key !== OTHER_CATEGORY));
    where.push(`(category = '${OTHER_CATEGORY}' OR NOT (category = ANY($${params.length}::text[])))`);
  } else if (filter.category) add("category = ?", filter.category);
  if (filter.detector) add("detector = ?", filter.detector);
  if (filter.signature) add("signature = ?", filter.signature);
  if (filter.severity) add("severity = ?", filter.severity);
  if (filter.entityKind) add("entity_kind = ?", filter.entityKind);
  if (filter.status && filter.status !== "all") add("status = ?", filter.status);
  if (filter.scanId !== undefined) add("first_seen_scan_id = ?", filter.scanId);
  if (filter.chained) where.push("evidence ? 'triggeredBy'");
  if (filter.q?.trim()) {
    params.push(`%${filter.q.trim().replace(/[\\%_]/gu, (char) => `\\${char}`)}%`);
    where.push(`(value ILIKE $${params.length} OR entity_label ILIKE $${params.length} OR title ILIKE $${params.length})`);
  }
  return { where, params };
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
  const finding: Omit<FindingRow, "actions"> = {
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
  return { ...finding, actions: summarizeActions(finding) };
}

const FINDING_COLUMNS = `id::text, category, detector, signature, severity, entity_kind, entity_id::text, entity_label, field, value, title, suggestion,
             suggested_value, related, evidence, status, first_seen_scan_id::text, first_seen_at, last_seen_at, resolved_at, ignored_at, ignored_by, ignore_note, ignore_reason,
             ${RESOLUTION_COLUMNS}`;

export async function listFindings(query: FindingQuery): Promise<{ rows: FindingRow[]; total: number }> {
  const { where, params } = buildFindingsWhere(query);
  params.push(query.limit, query.offset);
  const [lastScan, result] = await Promise.all([
    lastOkScanId(),
    getPool().query<RawFinding>(`
      SELECT ${FINDING_COLUMNS},
             count(*) OVER ()::text AS total
        FROM ingest.curation_findings
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, first_seen_at DESC, id
       LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
  ]);
  return { rows: result.rows.map((row) => findingRow(row, lastScan)), total: Number(result.rows[0]?.total ?? 0) };
}

/**
 * Fallo esperado de Curaduría. stale = la ficha cambió desde el análisis (C4);
 * stale_preview = el hash no es el de la vista previa del lote; busy = otro
 * proceso aplica o deshace ese lote; not_fixable = no hay nada que aplicar.
 */
export type CurationErrorCode = "not_found" | "not_open" | "not_fixable" | "invalid" | "stale" | "stale_preview" | "busy";

export class CurationError extends Error {
  constructor(readonly code: CurationErrorCode, message: string, readonly details?: Record<string, unknown>) { super(message); }
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

/**
 * Filtro de una acción de grupo: el mismo `FindingFilter` que el listado,
 * siempre sobre `open` y siempre anclado a un detector (los botones de grupo
 * de la web solo aparecen dentro de una categoría › detector concretos).
 */
export interface FindingGroupFilter {
  category: string;
  detector: string;
  signature?: string | undefined;
  severity?: Severity | undefined;
  entityKind?: string | undefined;
  q?: string | undefined;
  scanId?: number | undefined;
  chained?: boolean | undefined;
}

/** Ignora de una vez todo hallazgo abierto que cumpla exactamente el filtro (igual que el listado, C3). */
export async function ignoreGroup(
  filter: FindingGroupFilter, operator: string, reason: IgnoreReason, note: string,
): Promise<number> {
  const { where, params } = buildFindingsWhere({ ...filter, status: "open" });
  params.push(operator, note, reason);
  const [operatorIdx, noteIdx, reasonIdx] = [params.length - 2, params.length - 1, params.length];
  const result = await getPool().query(`
    UPDATE ingest.curation_findings SET status = 'ignored', ignored_at = now(), ignored_by = $${operatorIdx}, ignore_note = $${noteIdx}, ignore_reason = $${reasonIdx}
     WHERE ${where.join(" AND ")}`, params);
  return result.rowCount ?? 0;
}

// ---------------------------------------------------------------------------
// «Surgidos tras corregir», dados por revisados (M2, PLAN_CURADURIA E8.7).
//
// `evidence.triggeredBy` marca el hallazgo que nació donde otro se acababa de
// resolver. Hasta ahora esa marca era permanente: la lista de «surgidos tras
// corregir» solo crecía y nadie podía decir «ya lo miré» sin cerrar el
// hallazgo, que es otra cosa (el problema sigue ahí). Darlo por revisado mueve
// la marca a `evidence.triggeredHistory` —no se pierde quién lo desencadenó ni
// cuándo— y lo saca del filtro `chained`, que pregunta por `triggeredBy`.
//
// Es duradero: un análisis posterior conserva `triggeredBy` tal como esté
// (scan.ts lo copia con `jsonb_strip_nulls`, así que una clave ausente no
// vuelve), y solo se vuelve a marcar si el hallazgo se resuelve y reaparece
// tras otra corrección, que es una aparición nueva y merece revisarse otra vez.
// ---------------------------------------------------------------------------

/** Mueve `triggeredBy`/`triggeredInScan` al historial, anotando quién lo revisó y cuándo. */
const ACKNOWLEDGE_CHAIN_SQL = `
  evidence = (evidence - 'triggeredBy' - 'triggeredInScan') || jsonb_build_object(
    'triggeredHistory',
    coalesce(evidence->'triggeredHistory', '[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'at', to_jsonb(now()),
      'by', to_jsonb($OPERATOR::text),
      'scanId', evidence->'triggeredInScan',
      'causes', coalesce(evidence->'triggeredBy', '[]'::jsonb))))`;

export async function acknowledgeChain(id: number, operator: string): Promise<FindingRow> {
  const { rows } = await getPool().query<{ chained: boolean }>(
    "SELECT (evidence ? 'triggeredBy') AS chained FROM ingest.curation_findings WHERE id = $1", [id]);
  if (!rows[0]) throw new CurationError("not_found", `hallazgo inexistente: ${id}`);
  if (!rows[0].chained) throw new CurationError("invalid", "Ese hallazgo no está marcado como surgido tras corregir.");
  await getPool().query(
    `UPDATE ingest.curation_findings SET ${ACKNOWLEDGE_CHAIN_SQL.replace("$OPERATOR", "$2")} WHERE id = $1`, [id, operator]);
  return (await getFinding(id))!;
}

/**
 * Da por revisados de una vez los que cumplen exactamente el filtro de la
 * pantalla (C3), siempre dentro de los encadenados: «marcar como revisado» no
 * puede alcanzar un hallazgo que la lista no estaba mostrando.
 */
export async function acknowledgeChainGroup(filter: FindingFilter, operator: string): Promise<number> {
  const { where, params } = buildFindingsWhere({ ...filter, chained: true });
  params.push(operator);
  const result = await getPool().query(
    `UPDATE ingest.curation_findings SET ${ACKNOWLEDGE_CHAIN_SQL.replace("$OPERATOR", `$${params.length}`)}
      WHERE ${where.join(" AND ")}`, params);
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

/** Hallazgos por id, en cualquier estado (los lotes de correcciones deciden qué hacer con cada uno). */
export async function getFindingsByIds(ids: readonly number[], queryable: CurationQueryable = getPool()): Promise<FindingRow[]> {
  if (ids.length === 0) return [];
  const [lastScan, result] = await Promise.all([
    lastOkScanId(queryable),
    queryable.query<RawFinding>(`SELECT ${FINDING_COLUMNS}, '0' AS total FROM ingest.curation_findings WHERE id = ANY($1::bigint[])`, [ids]),
  ]);
  return result.rows.map((row) => findingRow(row, lastScan));
}

/**
 * Los hallazgos ABIERTOS que cumplen exactamente el filtro de un grupo (C3),
 * en orden estable, hasta `limit`; `total` = cuántos cumplen el filtro.
 */
export async function listGroupFindings(
  filter: FindingGroupFilter, limit: number, queryable: CurationQueryable = getPool(),
): Promise<{ rows: FindingRow[]; total: number }> {
  const { where, params } = buildFindingsWhere({ ...filter, status: "open" });
  params.push(limit);
  const [lastScan, result] = await Promise.all([
    lastOkScanId(queryable),
    queryable.query<RawFinding>(`
      SELECT ${FINDING_COLUMNS}, count(*) OVER ()::text AS total
        FROM ingest.curation_findings
       WHERE ${where.join(" AND ")}
       ORDER BY id
       LIMIT $${params.length}`, params),
  ]);
  return { rows: result.rows.map((row) => findingRow(row, lastScan)), total: Number(result.rows[0]?.total ?? 0) };
}

export async function getFinding(id: number): Promise<FindingRow | undefined> {
  const [lastScan, result] = await Promise.all([
    lastOkScanId(),
    getPool().query<RawFinding>(`SELECT ${FINDING_COLUMNS}, '1' AS total FROM ingest.curation_findings WHERE id = $1`, [id]),
  ]);
  return result.rows[0] ? findingRow(result.rows[0], lastScan) : undefined;
}

/**
 * Lee y bloquea un hallazgo dentro de la transacción de una corrección. La
 * vista previa es solo una promesa: entre ella y su turno otro operador puede
 * ignorar, resolver o borrar el hallazgo. El candado hace que la acción use el
 * estado que sigue vigente al escribir, no una copia anterior del lote.
 */
export async function getFindingForUpdate(id: number, client: PoolClient): Promise<FindingRow | undefined> {
  const lastScan = await lastOkScanId(client);
  const result = await client.query<RawFinding>(
    `SELECT ${FINDING_COLUMNS}, '1' AS total FROM ingest.curation_findings WHERE id = $1 FOR UPDATE`, [id]);
  return result.rows[0] ? findingRow(result.rows[0], lastScan) : undefined;
}
