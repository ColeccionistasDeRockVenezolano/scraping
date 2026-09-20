// CRV · Observabilidad operativa de Curaduría (PLAN_CURADURIA E12).
//
// "Precisión observada" NO sustituye la precisión del corpus etiquetado de E2.
// Esta métrica usa decisiones humanas acumuladas en la base: una corrección
// aplicada cuenta como confirmación del detector; "falso positivo" y
// "correcto a propósito" cuentan como rechazo. "Fuera de alcance" no decide
// si el detector acertó y queda fuera del denominador.
import { getPool } from "../db/client.js";
import { DETECTOR_DEFINITIONS } from "./analyze.js";
import { summarizeActions } from "./actions/registry.js";
import type { ActionFinding } from "./actions/types.js";
import type { EntityRef } from "./types.js";

export const PRECISION_ALERT_THRESHOLD = 0.8;
/** Una alerta de precisión necesita muestra; por debajo se publica el n, pero no se alarma. */
export const PRECISION_ALERT_MIN_REVIEWED = 20;
/** /summary se consulta durante un análisis cada pocos segundos: no releemos miles de filas en cada poll. */
export const CURATION_METRICS_CACHE_MS = 10_000;

export const INFORMATIONAL_DETECTOR_KEYS: ReadonlySet<string> = new Set(
  DETECTOR_DEFINITIONS.filter((detector) => detector.actionability === "informational").map((detector) => detector.key),
);

export interface DetectorMetric {
  detector: string;
  label: string;
  reviewed: number;
  confirmed: number;
  rejected: number;
  falsePositives: number;
  intentional: number;
  observedPrecision: number | null;
  meanCorrectionSeconds: number | null;
}

export interface CurationMetrics {
  detectors: DetectorMetric[];
  meanCorrectionSeconds: number | null;
  actionCoverage: {
    /** Solo hallazgos accionables; los informativos se reportan aparte. */
    open: number;
    excludedInformational: number;
    level1OrLess: number;
    level2OrLess: number;
    level1OrLessPct: number | null;
    level2OrLessPct: number | null;
  };
  batches: {
    /** Todos los lotes no-undo, incluidas vistas previas. */
    total: number;
    previewed: number;
    /** Lotes que llegaron a aplicar al menos un ítem (aunque luego se deshicieran). */
    applied: number;
    undone: number;
    /** Ítems de autocorrección que siguen aplicados / que fueron revertidos. */
    autoApplied: number;
    autoReverted: number;
  };
  alerts: Array<{
    detector: string;
    label: string;
    precision: number;
    reviewed: number;
    threshold: number;
    minimumReviewed: number;
  }>;
}

export function observedPrecision(confirmed: number, rejected: number): number | null {
  const reviewed = confirmed + rejected;
  return reviewed > 0 ? confirmed / reviewed : null;
}

export function shouldAlertPrecision(precision: number | null, reviewed: number): boolean {
  return precision !== null && reviewed >= PRECISION_ALERT_MIN_REVIEWED && precision < PRECISION_ALERT_THRESHOLD;
}

const labelByDetector = new Map(DETECTOR_DEFINITIONS.map((detector) => [detector.key, detector.label]));

interface OutcomeRow {
  detector: string;
  confirmed: number;
  false_positives: number;
  intentional: number;
  mean_correction_seconds: number | null;
}

interface OpenRow {
  id: string;
  detector: string;
  signature: string;
  entity_kind: string;
  entity_id: string | null;
  entity_label: string | null;
  field: string | null;
  value: string | null;
  suggested_value: string | null;
  related: EntityRef[] | null;
  evidence: Record<string, unknown> | null;
  title: string;
}

interface GlobalRow {
  mean_correction_seconds: number | null;
  excluded_informational: number;
}

interface BatchRow {
  total: number;
  previewed: number;
  applied: number;
  undone: number;
  auto_applied: number;
  auto_reverted: number;
}

function actionFinding(row: OpenRow): ActionFinding {
  return {
    id: Number(row.id),
    detector: row.detector,
    signature: row.signature,
    status: "open",
    entity: {
      kind: row.entity_kind as EntityRef["kind"],
      id: row.entity_id === null ? null : Number(row.entity_id),
      label: row.entity_label ?? "",
    },
    field: row.field,
    value: row.value,
    suggestedValue: row.suggested_value,
    related: row.related ?? [],
    evidence: row.evidence ?? {},
    title: row.title,
  };
}

const ratio = (count: number, total: number): number | null => (total > 0 ? count / total : null);
const informational = [...INFORMATIONAL_DETECTOR_KEYS];

let cache: { at: number; value: CurationMetrics } | null = null;
export function clearCurationMetricsCache(): void { cache = null; }

export async function getCurationMetrics(options: { fresh?: boolean } = {}): Promise<CurationMetrics> {
  if (!options.fresh && cache && Date.now() - cache.at < CURATION_METRICS_CACHE_MS) return cache.value;

  const pool = getPool();
  const [outcomes, openRows, global, batchCounts] = await Promise.all([
    pool.query<OutcomeRow>(`
      SELECT detector,
             count(*) FILTER (WHERE resolution='fixed_by_curation')::int AS confirmed,
             count(*) FILTER (WHERE ignore_reason='falso_positivo')::int AS false_positives,
             count(*) FILTER (WHERE ignore_reason='correcto_a_proposito')::int AS intentional,
             (avg(extract(epoch FROM (resolved_at - first_seen_at)))
               FILTER (WHERE resolution='fixed_by_curation' AND resolved_at IS NOT NULL))::float8 AS mean_correction_seconds
        FROM ingest.curation_findings
       GROUP BY detector
       ORDER BY detector`),
    pool.query<OpenRow>(`
      SELECT id::text, detector, signature, entity_kind, entity_id::text, entity_label,
             field, value, suggested_value, related, evidence, title
        FROM ingest.curation_findings
       WHERE status='open' AND NOT (detector = ANY($1::text[]))`, [informational]),
    pool.query<GlobalRow>(`
      SELECT (avg(extract(epoch FROM (resolved_at - first_seen_at)))
               FILTER (WHERE resolution='fixed_by_curation' AND resolved_at IS NOT NULL))::float8 AS mean_correction_seconds,
             count(*) FILTER (WHERE status='open' AND detector = ANY($1::text[]))::int AS excluded_informational
        FROM ingest.curation_findings`, [informational]),
    pool.query<BatchRow>(`
      SELECT count(DISTINCT b.id) FILTER (WHERE b.mode <> 'undo')::int AS total,
             count(DISTINCT b.id) FILTER (WHERE b.mode <> 'undo' AND b.status='previewed')::int AS previewed,
             count(DISTINCT b.id) FILTER (WHERE b.mode <> 'undo' AND i.status IN ('applied','undone'))::int AS applied,
             count(DISTINCT b.id) FILTER (WHERE b.mode <> 'undo' AND b.status='undone')::int AS undone,
             count(i.id) FILTER (WHERE b.mode='auto' AND i.status='applied')::int AS auto_applied,
             count(i.id) FILTER (WHERE b.mode='auto' AND i.status='undone')::int AS auto_reverted
        FROM ingest.curation_fix_batches b
        LEFT JOIN ingest.curation_fix_items i ON i.batch_id=b.id`),
  ]);

  const outcomeByDetector = new Map(outcomes.rows.map((row) => [row.detector, row]));
  const detectorKeys = new Set([
    ...DETECTOR_DEFINITIONS.map((detector) => detector.key),
    ...outcomes.rows.map((row) => row.detector),
  ]);
  const detectors = [...detectorKeys].map((detector): DetectorMetric => {
    const row = outcomeByDetector.get(detector);
    const confirmed = row?.confirmed ?? 0;
    const falsePositives = row?.false_positives ?? 0;
    const intentional = row?.intentional ?? 0;
    const rejected = falsePositives + intentional;
    return {
      detector,
      label: labelByDetector.get(detector) ?? detector,
      reviewed: confirmed + rejected,
      confirmed,
      rejected,
      falsePositives,
      intentional,
      observedPrecision: observedPrecision(confirmed, rejected),
      meanCorrectionSeconds: row?.mean_correction_seconds ?? null,
    };
  });

  let level1OrLess = 0;
  let level2OrLess = 0;
  for (const row of openRows.rows) {
    const actions = summarizeActions(actionFinding(row));
    const level = actions.length ? Math.min(...actions.map((action) => action.level)) : Number.POSITIVE_INFINITY;
    if (level <= 1) level1OrLess += 1;
    if (level <= 2) level2OrLess += 1;
  }
  const open = openRows.rows.length;

  const alerts = detectors.flatMap((metric) =>
    shouldAlertPrecision(metric.observedPrecision, metric.reviewed)
      ? [{
        detector: metric.detector,
        label: metric.label,
        precision: metric.observedPrecision!,
        reviewed: metric.reviewed,
        threshold: PRECISION_ALERT_THRESHOLD,
        minimumReviewed: PRECISION_ALERT_MIN_REVIEWED,
      }]
      : []);

  const batch = batchCounts.rows[0] ?? {
    total: 0, previewed: 0, applied: 0, undone: 0, auto_applied: 0, auto_reverted: 0,
  };
  const result: CurationMetrics = {
    detectors,
    meanCorrectionSeconds: global.rows[0]?.mean_correction_seconds ?? null,
    actionCoverage: {
      open,
      excludedInformational: global.rows[0]?.excluded_informational ?? 0,
      level1OrLess,
      level2OrLess,
      level1OrLessPct: ratio(level1OrLess, open),
      level2OrLessPct: ratio(level2OrLess, open),
    },
    batches: {
      total: batch.total,
      previewed: batch.previewed,
      applied: batch.applied,
      undone: batch.undone,
      autoApplied: batch.auto_applied,
      autoReverted: batch.auto_reverted,
    },
    alerts,
  };
  cache = { at: Date.now(), value: result };
  return result;
}
