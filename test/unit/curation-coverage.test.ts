// CRV · Cobertura de acciones sobre la foto congelada (PLAN_CURADURIA §4, A1).
//
// `npm run curation:coverage` imprime el desglose, pero un informe que nadie
// corre no defiende nada: hasta hoy el criterio §4 solo se comprobaba a mano.
// Esta prueba lo fija en CI con la misma regla que el script y que
// `/curation/summary` (`src/curation/coverage.ts`), sobre la misma foto
// congelada que usa el corpus de precisión y sin tocar PostgreSQL.
import { beforeAll, describe, expect, it } from "vitest";
import { declaredActions } from "../../src/curation/actions/registry.js";
import { analyzeCatalog, DETECTOR_DEFINITIONS } from "../../src/curation/analyze.js";
import {
  ACTION_COVERAGE_MINIMUMS, measureActionCoverage, share, upToLevel1, upToLevel2,
  type ActionCoverage,
} from "../../src/curation/coverage.js";
import { loadCatalogFixture } from "../support/curation-catalog-fixture.js";

/**
 * Piso de regresión, no objetivo: la foto da 84,7 % / 87,0 % (2026-09-20) y aquí
 * se exige bastante menos para no bloquear trabajo legítimo —un detector nuevo
 * que emita mucho antes de tener su acción baja el porcentaje sin ser un
 * defecto—. Por debajo de esto ya no es calibración, es una acción que se
 * dejó de ofrecer.
 */
const REGRESSION_FLOOR = { level1OrLess: 0.8, level2OrLess: 0.84 } as const;

let coverage: ActionCoverage;

describe("cobertura de acciones de Curaduría (§4 · A1)", () => {
  beforeAll(() => {
    const analysis = analyzeCatalog(loadCatalogFixture());
    expect(analysis.failures).toEqual([]);
    coverage = measureActionCoverage(analysis.findings);
  }, 60_000);

  it("cumple los mínimos que exige el plan: ≥30 % con nivel ≤1 y ≥70 % con nivel ≤2", () => {
    const { actionable } = coverage;
    expect(actionable.total).toBeGreaterThan(0);
    expect(share(upToLevel1(actionable), actionable.total)).toBeGreaterThanOrEqual(ACTION_COVERAGE_MINIMUMS.level1OrLess);
    expect(share(upToLevel2(actionable), actionable.total)).toBeGreaterThanOrEqual(ACTION_COVERAGE_MINIMUMS.level2OrLess);
  });

  it("no cae por debajo del piso medido: una acción que deja de ofrecerse se nota aquí", () => {
    const { actionable } = coverage;
    expect(share(upToLevel1(actionable), actionable.total)).toBeGreaterThanOrEqual(REGRESSION_FLOOR.level1OrLess);
    expect(share(upToLevel2(actionable), actionable.total)).toBeGreaterThanOrEqual(REGRESSION_FLOOR.level2OrLess);
  });

  // El defecto §3.1 del cierre 20/20: `fusionar` estaba declarada en los
  // detectores de repetidos y no se ofrecía en NINGÚN hallazgo real, porque el
  // par no viajaba donde la acción lo busca. Declarar no es ofrecer.
  it("todo detector que declara una acción la ofrece de verdad sobre datos reales", () => {
    const declares = DETECTOR_DEFINITIONS.filter((detector) => Object.keys(detector.actions ?? {}).length > 0);
    const mudos = declares
      .map((detector) => ({ key: detector.key, bucket: coverage.byDetector.get(detector.key) }))
      .filter((item) => item.bucket !== undefined && upToLevel2(item.bucket!) === 0)
      .map((item) => `${item.key} (${item.bucket!.total} hallazgos, ninguno con acción)`);
    expect(mudos).toEqual([]);
  });

  it("los detectores informativos quedan fuera del denominador", () => {
    expect(coverage.informational.total).toBeGreaterThan(0);
    expect(coverage.informational.manual).toBe(coverage.informational.total);
    expect(coverage.byDetector.has("disco_sin_pistas")).toBe(false);
  });

  it("organizacion_sin_clasificar: los 21 hallazgos de la foto se corrigen en nivel 1", () => {
    expect(declaredActions("organizacion_sin_clasificar", "sin_clasificar")).toEqual(["fijar_tipo_de_organizacion"]);
    expect(coverage.byDetector.get("organizacion_sin_clasificar")).toEqual({
      total: 21, level0: 0, level1: 21, level2: 0, manual: 0,
    });
  });
});
