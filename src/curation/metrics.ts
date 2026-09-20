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
    open: number;
    level1OrLess: number;
    level2OrLess: number;
    level1OrLessPct: number | null;
    level2OrLessPct: number | null;
  };
  batches: {
    total: number;
    undone: number;
    autoReverted: number;
  };
  alerts: Array<{
    detector: string;
    label: string;
    precision: number;
    reviewed: number;
    threshold: number;
  }>;
}

export function observedPrecision(confirmed: number, rejected: number): number | null {
  const reviewed = confirmed + rejected;
  return reviewed > 0 ? confirmed / reviewed : null;
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

export async function getCurationMetrics(): Promise<CurationMetrics> {
  const pool = getPool();
  const [outcomes, openRows, globalTime, batchCounts] = await Promise.all([
    pool.query<OutcomeRow>(`
      SELECT detector,
             count(*) FILTER (WHERE resolution='fixed_by_curation')::int AS confirmed,
             count(*) FILTER (WHERE ignore_reason='falso_positivo')::int AS false_positives,
             count(*) FILTER (WHERE ignore_reason='correcto_a_proposito')::int AS intentional,
             avg(extract(epoch FROM (resolved_at - first_seen_at)))
               FILTER (WHERE resolution='fixed_by_curation' AND resolved_at IS NOT NULL)::float8 AS mean_correction_seconds
        FROM ingest.curation_findings
       GROUP BY detector
       ORDER BY detector`),
    pool.query<OpenRow>(`
      SELECT id::text, detector, signature, entity_kind, entity_id::text, entity_label,
             field, value, suggested_value, related, evidence, title
        FROM ingest.curation_findings
       WHERE status='open'`),
    pool.query<{ mean_correction_seconds: number | null }>(`
      SELECT avg(extract(epoch FROM (resolved_at - first_seen_at)))
               FILTER (WHERE resolution='fixed_by_curation' AND resolved_at IS NOT NULL)::float8 AS mean_correction_seconds
        FROM ingest.curation_findings`),
    pool.query<{ total: number; undone: number; auto_reverted: number }>(`
      SELECT count(*) FILTER (WHERE mode <> 'undo')::int AS total,
             count(*) FILTER (WHERE mode <> 'undo' AND status='undone')::int AS undone,
             count(*) FILTER (WHERE mode='auto' AND status='undone')::int AS auto_reverted
        FROM ingest.curation_fix_batches`),
  ]);

  const detectors = outcomes.rows.map((row): DetectorMetric => {
    const rejected = row.false_positives + row.intentional;
    return {
      detector: row.detector,
      label: labelByDetector.get(row.detector) ?? row.detector,
      reviewed: row.confirmed + rejected,
      confirmed: row.confirmed,
      rejected,
      falsePositives: row.false_positives,
      intentional: row.intentional,
      observedPrecision: observedPrecision(row.confirmed, rejected),
      meanCorrectionSeconds: row.mean_correction_seconds,
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
    metric.observedPrecision !== null && metric.observedPrecision < PRECISION_ALERT_THRESHOLD
      ? [{
        detector: metric.detector,
        label: metric.label,
        precision: metric.observedPrecision,
        reviewed: metric.reviewed,
        threshold: PRECISION_ALERT_THRESHOLD,
      }]
      : []);

  const batch = batchCounts.rows[0] ?? { total: 0, undone: 0, auto_reverted: 0 };
  return {
    detectors,
    meanCorrectionSeconds: globalTime.rows[0]?.mean_correction_seconds ?? null,
    actionCoverage: {
      open,
      level1OrLess,
      level2OrLess,
      level1OrLessPct: ratio(level1OrLess, open),
      level2OrLessPct: ratio(level2OrLess, open),
    },
    batches: { total: batch.total, undone: batch.undone, autoReverted: batch.auto_reverted },
    alerts,
  };
}
