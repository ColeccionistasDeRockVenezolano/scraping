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
// Este script IMPRIME el desglose; quien defiende los umbrales en CI es
// `test/unit/curation-coverage.test.ts`. Los dos cuentan con la misma regla
// (`src/curation/coverage.ts`), la misma que usa `/curation/summary`.
import { analyzeCatalog, DETECTOR_DEFINITIONS } from "../src/curation/analyze.js";
import {
  ACTION_COVERAGE_MINIMUMS, measureActionCoverage, share, upToLevel1, upToLevel2,
  type CoverageBucket,
} from "../src/curation/coverage.js";
import { loadCatalogFixture } from "../test/support/curation-catalog-fixture.js";

const pct = (part: number, whole: number): string => {
  const ratio = share(part, whole);
  return ratio === null ? "—" : `${(ratio * 100).toFixed(1)} %`;
};

function row(name: string, bucket: CoverageBucket): string {
  return [
    name.padEnd(46),
    String(bucket.total).padStart(6),
    `${String(upToLevel1(bucket)).padStart(6)} (${pct(upToLevel1(bucket), bucket.total).padStart(7)})`,
    `${String(upToLevel2(bucket)).padStart(6)} (${pct(upToLevel2(bucket), bucket.total).padStart(7)})`,
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
  const { actionable, informational, byCategory, byDetector } = measureActionCoverage(analysis.findings);

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

  const verdict = (part: number, minimum: number): string =>
    (share(part, actionable.total) ?? 0) >= minimum ? "CUMPLE" : "NO CUMPLE";
  console.log("");
  console.log(`Criterio §4 (A1): ≤N1 ${pct(upToLevel1(actionable), actionable.total)} (exige ≥${ACTION_COVERAGE_MINIMUMS.level1OrLess * 100} %) → ${verdict(upToLevel1(actionable), ACTION_COVERAGE_MINIMUMS.level1OrLess)}`);
  console.log(`Criterio §4 (A1): ≤N2 ${pct(upToLevel2(actionable), actionable.total)} (exige ≥${ACTION_COVERAGE_MINIMUMS.level2OrLess * 100} %) → ${verdict(upToLevel2(actionable), ACTION_COVERAGE_MINIMUMS.level2OrLess)}`);
}

main();
