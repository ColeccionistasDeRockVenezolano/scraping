// CRV · Mide la cobertura de acciones de Curaduría sobre la foto congelada
// (PLAN_CURADURIA §4: «≥70 % de los abiertos con acción de nivel ≤2 y ≥30 % con
// nivel ≤1», hallazgo A1).
//
//   npm run curation:coverage
//
// Por qué contra la foto y no contra la base: el criterio §4 habla de los
// hallazgos que el detector produce, y la foto `catalog-2026-09-16` +
// `relations-2026-09-20` es la misma vara con la que se etiquetó el corpus de
// precisión. Así la cifra del cierre es reproducible por cualquiera sin acceso
// a la base de desarrollo y sin escribir una sola fila (regla 0.1.5 del plan).
//
// Usa exactamente la misma regla que `/curation/summary` (src/curation/metrics.ts):
// nivel del hallazgo = el MÍNIMO de las acciones que se le ofrecen, y los
// detectores informativos quedan fuera del denominador porque no existe acción
// que los cierre (son datos que faltan, no defectos que corregir).
import { analyzeCatalog, DETECTOR_DEFINITIONS } from "../src/curation/analyze.js";
import { summarizeActions } from "../src/curation/actions/registry.js";
import type { ActionFinding } from "../src/curation/actions/types.js";
import { INFORMATIONAL_DETECTOR_KEYS } from "../src/curation/metrics.js";
import type { Finding } from "../src/curation/types.js";
import { loadCatalogFixture } from "../test/support/curation-catalog-fixture.js";

interface Bucket {
  total: number;
  level0: number;
  level1: number;
  level2: number;
  manual: number;
}

const empty = (): Bucket => ({ total: 0, level0: 0, level1: 0, level2: 0, manual: 0 });

/** El hallazgo tal como lo verán las acciones una vez guardado (id y estado no intervienen en el nivel). */
function asActionFinding(finding: Finding): ActionFinding {
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
    // El par viaja fuera de `evidence` en el analizador y dentro al persistir
    // (scan.ts): la medición usa la forma GUARDADA, que es la que ven las
    // acciones y `/curation/summary`.
    evidence: { ...finding.evidence, ...(finding.pair ? { pair: finding.pair } : {}) },
    title: finding.title,
  };
}

/** Nivel del hallazgo: el más seguro que alguna acción suya alcanza; `null` = sin acción. */
function bestLevel(finding: Finding): number | null {
  const levels = summarizeActions(asActionFinding(finding)).map((action) => action.level);
  return levels.length ? Math.min(...levels) : null;
}

function bump(bucket: Bucket, level: number | null): void {
  bucket.total += 1;
  if (level === 0) bucket.level0 += 1;
  else if (level === 1) bucket.level1 += 1;
  else if (level === 2) bucket.level2 += 1;
  else bucket.manual += 1;
}

const pct = (part: number, whole: number): string => (whole ? `${((part / whole) * 100).toFixed(1)} %` : "—");

function row(name: string, bucket: Bucket): string {
  const upTo1 = bucket.level0 + bucket.level1;
  const upTo2 = upTo1 + bucket.level2;
  return [
    name.padEnd(46),
    String(bucket.total).padStart(6),
    `${String(upTo1).padStart(6)} (${pct(upTo1, bucket.total).padStart(7)})`,
    `${String(upTo2).padStart(6)} (${pct(upTo2, bucket.total).padStart(7)})`,
    String(bucket.manual).padStart(7),
  ].join("  ");
}

function main(): void {
  const snapshot = loadCatalogFixture();
  const started = Date.now();
  const analysis = analyzeCatalog(snapshot);
  const elapsed = Date.now() - started;
  if (analysis.failures.length) {
    console.error("Detectores que fallaron:", analysis.failures);
    process.exitCode = 1;
    return;
  }

  const labels = new Map(DETECTOR_DEFINITIONS.map((detector) => [detector.key, detector.label]));
  const actionable = empty();
  const informational = empty();
  const byCategory = new Map<string, Bucket>();
  const byDetector = new Map<string, Bucket>();
  for (const finding of analysis.findings) {
    const level = bestLevel(finding);
    const bucket = INFORMATIONAL_DETECTOR_KEYS.has(finding.detector) ? informational : actionable;
    bump(bucket, level);
    if (bucket === informational) continue;
    bump(byCategory.get(finding.category) ?? byCategory.set(finding.category, empty()).get(finding.category)!, level);
    bump(byDetector.get(finding.detector) ?? byDetector.set(finding.detector, empty()).get(finding.detector)!, level);
  }

  const header = ["", "total", "  ≤ nivel 1", "  ≤ nivel 2", " sin acc."].join("".padEnd(1));
  console.log(`Foto: ${snapshot.takenAt.toISOString().slice(0, 10)} · detectores: ${analysis.completed.length} · análisis: ${elapsed} ms`);
  console.log(`Hallazgos: ${analysis.findings.length} (accionables ${actionable.total} · informativos ${informational.total})\n`);
  console.log(header);
  console.log(row("TOTAL ACCIONABLE", actionable));
  console.log("");
  for (const [category, bucket] of [...byCategory].sort((a, b) => b[1].total - a[1].total)) {
    console.log(row(`· ${category}`, bucket));
  }
  console.log("");
  for (const [detector, bucket] of [...byDetector].sort((a, b) => b[1].total - a[1].total)) {
    console.log(row(`  ${labels.get(detector) ?? detector} [${detector}]`, bucket));
  }
  console.log("");
  console.log(row("INFORMATIVOS (fuera del denominador)", informational));

  const upTo1 = actionable.level0 + actionable.level1;
  const upTo2 = upTo1 + actionable.level2;
  const ratio1 = upTo1 / actionable.total;
  const ratio2 = upTo2 / actionable.total;
  console.log("");
  console.log(`Criterio §4 (A1): ≤N1 ${pct(upTo1, actionable.total)} (exige ≥30 %) → ${ratio1 >= 0.3 ? "CUMPLE" : "NO CUMPLE"}`);
  console.log(`Criterio §4 (A1): ≤N2 ${pct(upTo2, actionable.total)} (exige ≥70 %) → ${ratio2 >= 0.7 ? "CUMPLE" : "NO CUMPLE"}`);
}

main();
