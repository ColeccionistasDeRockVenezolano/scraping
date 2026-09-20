// CRV · Precisión de los detectores de Curaduría contra el corpus etiquetado
// (PLAN_CURADURIA E2.1, M9).
//
// El corpus es una muestra real de hallazgos de desarrollo, etiquetada a mano
// (verdadero positivo, falso positivo o discutible). Se analiza la foto
// congelada del mismo catálogo y se exige, por detector:
//  * precisión (verdaderos / verdaderos + falsos que siguen emitiéndose) no
//    menor que el umbral registrado en el corpus;
//  * ningún verdadero positivo perdido, y en su subgrupo si se reclasificó:
//    subir la precisión escondiendo problemas reales no vale;
//  * ningún falso positivo ya corregido de vuelta.
// Si una regla nueva mejora la precisión, se sube el umbral en el corpus.
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { analyzeCatalog, DETECTOR_DEFINITIONS } from "../../src/curation/analyze.js";
import { E11_DETECTORS } from "../../src/curation/detectors/advanced.js";
import { loadCatalogFixture } from "../support/curation-catalog-fixture.js";

const corpusSchema = z.object({
  precisionThresholds: z.record(z.string(), z.number().min(0).max(1)),
  findings: z.array(z.object({
    detector: z.string(),
    signature: z.string(),
    entity_kind: z.string(),
    entity_id: z.number().int(),
    value: z.string().nullable(),
    verdict: z.enum(["true_positive", "false_positive", "discutible"]),
    expectedDetector: z.string().optional(),
    expectedSignature: z.string().optional(),
    fixedIn: z.string().optional(),
  })),
});

const corpus = corpusSchema.parse(JSON.parse(readFileSync(new URL("../fixtures/curation/corpus.json", import.meta.url), "utf8")));
type Item = (typeof corpus.findings)[number];

const detectorOf = (item: Item): string => item.expectedDetector ?? item.detector;
const describeItem = (item: Item): string => `${detectorOf(item)} ${item.entity_kind}#${item.entity_id} «${item.value ?? ""}»`;

/** Firmas emitidas por detector y ficha: `detector|kind:id` → subgrupos. */
let emitted: Map<string, Set<string>>;

function signaturesFor(item: Item): Set<string> {
  return emitted.get(`${detectorOf(item)}|${item.entity_kind}:${item.entity_id}`) ?? new Set();
}

describe("precisión de los detectores de Curaduría (corpus etiquetado)", () => {
  beforeAll(() => {
    const result = analyzeCatalog(loadCatalogFixture());
    expect(result.failures).toEqual([]);
    emitted = new Map();
    for (const finding of result.findings) {
      const key = `${finding.detector}|${finding.entity.kind}:${finding.entity.id}`;
      emitted.set(key, (emitted.get(key) ?? new Set()).add(finding.signature));
    }
  }, 60_000);

  it("el corpus está entero etiquetado y cada detector etiquetado tiene umbral", () => {
    const known = new Set(DETECTOR_DEFINITIONS.map((detector) => detector.key));
    const labeled = new Set(corpus.findings.map(detectorOf));
    for (const detector of labeled) {
      expect(known.has(detector), detector).toBe(true);
      expect(corpus.precisionThresholds[detector], detector).toBeTypeOf("number");
      expect(corpus.precisionThresholds[detector], `${detector}: el cierre 20/20 exige precisión mínima de 90 %`).toBeGreaterThanOrEqual(0.9);
    }
  });

  it("todo detector E11 evaluable en la foto real tiene corpus y umbral ≥90 %", () => {
    const e11 = new Set(E11_DETECTORS.map((detector) => detector.key));
    const active = [...new Set(
      [...emitted.keys()].map((key) => key.split("|", 1)[0]!).filter((detector) => e11.has(detector)),
    )].sort();
    expect(active).toEqual([
      "disco_sin_pistas",
      "mayusculas_sostenidas",
      "pistas_sin_duracion_en_disco_con_duraciones",
      "tipo_de_organizacion_contra_nombre",
    ]);
    for (const detector of active) {
      expect(corpus.precisionThresholds[detector], `${detector}: sin umbral de precisión`).toBeGreaterThanOrEqual(0.9);
      const labeled = corpus.findings.filter((item) => detectorOf(item) === detector);
      expect(labeled.length, `${detector}: sin muestra etiquetada suficiente`).toBeGreaterThanOrEqual(3);
      expect(labeled.some((item) => item.verdict === "true_positive"), `${detector}: sin positivos reales`).toBe(true);
    }
  });

  it("ningún verdadero positivo se pierde, y los reclasificados están en su subgrupo", () => {
    const lost = corpus.findings
      .filter((item) => item.verdict === "true_positive")
      .filter((item) => {
        const signatures = signaturesFor(item);
        return !signatures.size || (item.expectedSignature !== undefined && !signatures.has(item.expectedSignature));
      })
      .map((item) => `${describeItem(item)} (esperado ${item.expectedSignature ?? "cualquier subgrupo"})`);
    expect(lost).toEqual([]);
  });

  it("los falsos positivos corregidos no vuelven", () => {
    const back = corpus.findings
      .filter((item) => item.verdict === "false_positive" && item.fixedIn)
      .filter((item) => signaturesFor(item).size > 0)
      .map(describeItem);
    expect(back).toEqual([]);
  });

  it("la precisión por detector no baja del umbral registrado", () => {
    const counts = new Map<string, { truePositives: number; falsePositives: number }>();
    for (const item of corpus.findings) {
      if (item.verdict === "discutible" || !signaturesFor(item).size) continue;
      const entry = counts.get(detectorOf(item)) ?? { truePositives: 0, falsePositives: 0 };
      if (item.verdict === "true_positive") entry.truePositives += 1; else entry.falsePositives += 1;
      counts.set(detectorOf(item), entry);
    }
    const below = Object.entries(corpus.precisionThresholds).flatMap(([detector, threshold]) => {
      const { truePositives = 0, falsePositives = 0 } = counts.get(detector) ?? {};
      const decided = truePositives + falsePositives;
      const precision = decided ? truePositives / decided : 1;
      return precision + 1e-9 < threshold ? [`${detector}: ${precision.toFixed(3)} < ${threshold}`] : [];
    });
    expect(below).toEqual([]);
  });
});
