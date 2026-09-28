// CRV · Cobertura de acciones de Curaduría (PLAN_CURADURIA §4, hallazgo A1).
//
// El nivel de un hallazgo es el MÍNIMO de las acciones que se le ofrecen, y los
// detectores informativos quedan fuera del denominador porque no existe acción
// que los cierre (son datos que faltan, no defectos que corregir).
//
// Esa regla se calculaba por separado en `/curation/summary`, en el escaneo seco
// y en el medidor de la foto. Que divergieran fue el defecto §3.1 del cierre
// 20/20: el par de un hallazgo de duplicados viaja FUERA de `evidence` en el
// analizador y DENTRO al persistir, así que una copia contaba «sin acción» lo
// que la otra ofrecía en nivel 1. Vive aquí una sola vez.
import { summarizeActions } from "./actions/registry.js";
import type { ActionFinding, ActionLevel } from "./actions/types.js";
import { DETECTOR_DEFINITIONS } from "./analyze.js";
import type { Finding } from "./types.js";

/** Los mínimos que exige §4 del plan sobre los hallazgos abiertos accionables. */
export const ACTION_COVERAGE_MINIMUMS = { level1OrLess: 0.3, level2OrLess: 0.7 } as const;

export const INFORMATIONAL_DETECTOR_KEYS: ReadonlySet<string> = new Set(
  DETECTOR_DEFINITIONS.filter((detector) => detector.actionability === "informational").map((detector) => detector.key),
);

/** Nivel del hallazgo: el más seguro que alguna de sus acciones alcanza; `null` = sin acción. */
export function findingActionLevel(finding: ActionFinding): ActionLevel | null {
  const levels = summarizeActions(finding).map((action) => action.level);
  return levels.length ? (Math.min(...levels) as ActionLevel) : null;
}

/**
 * El hallazgo del analizador tal como lo verán las acciones una vez guardado
 * (id y estado no intervienen en el nivel). El `pair` entra en `evidence`: esa
 * es la forma que `persist` deja en la base y la única que lee `fusionar`.
 */
export function actionFindingOf(finding: Finding): ActionFinding {
  return {
    id: 0,
    status: "open",
    detector: finding.detector,
    signature: finding.signature,
    entity: finding.entity,
    field: finding.field ?? null,
    value: finding.value ?? null,
    suggestedValue: finding.suggestedValue ?? null,
    related: finding.related,
    evidence: { ...finding.evidence, ...(finding.pair ? { pair: finding.pair } : {}) },
    title: finding.title,
  };
}

export interface CoverageBucket {
  total: number;
  level0: number;
  level1: number;
  level2: number;
  /** Sin acción de nivel ≤2: nivel 3 o ninguna acción declarada. */
  manual: number;
}

export interface ActionCoverage {
  actionable: CoverageBucket;
  informational: CoverageBucket;
  byCategory: Map<string, CoverageBucket>;
  byDetector: Map<string, CoverageBucket>;
}

export const emptyBucket = (): CoverageBucket => ({ total: 0, level0: 0, level1: 0, level2: 0, manual: 0 });

export const upToLevel1 = (bucket: CoverageBucket): number => bucket.level0 + bucket.level1;
export const upToLevel2 = (bucket: CoverageBucket): number => upToLevel1(bucket) + bucket.level2;
export const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

function bump(bucket: CoverageBucket, level: ActionLevel | null): void {
  bucket.total += 1;
  if (level === 0) bucket.level0 += 1;
  else if (level === 1) bucket.level1 += 1;
  else if (level === 2) bucket.level2 += 1;
  else bucket.manual += 1;
}

const into = (map: Map<string, CoverageBucket>, key: string): CoverageBucket => {
  const existing = map.get(key);
  if (existing) return existing;
  const created = emptyBucket();
  map.set(key, created);
  return created;
};

/** Reparte los hallazgos del analizador por nivel de acción, categoría y detector. */
export function measureActionCoverage(findings: readonly Finding[]): ActionCoverage {
  const coverage: ActionCoverage = {
    actionable: emptyBucket(),
    informational: emptyBucket(),
    byCategory: new Map(),
    byDetector: new Map(),
  };
  for (const finding of findings) {
    const level = findingActionLevel(actionFindingOf(finding));
    if (INFORMATIONAL_DETECTOR_KEYS.has(finding.detector)) {
      bump(coverage.informational, level);
      continue;
    }
    bump(coverage.actionable, level);
    bump(into(coverage.byCategory, finding.category), level);
    bump(into(coverage.byDetector, finding.detector), level);
  }
  return coverage;
}
