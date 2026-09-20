import { describe, expect, it } from "vitest";
import {
  INFORMATIONAL_DETECTOR_KEYS,
  PRECISION_ALERT_MIN_REVIEWED,
  PRECISION_ALERT_THRESHOLD,
  observedPrecision,
  shouldAlertPrecision,
} from "../../src/curation/metrics.js";

describe("métricas operativas de Curaduría (E12)", () => {
  it("calcula precisión observada solo cuando hay decisiones concluyentes", () => {
    expect(observedPrecision(9, 1)).toBe(0.9);
    expect(observedPrecision(3, 2)).toBe(0.6);
    expect(observedPrecision(0, 0)).toBeNull();
  });

  it("mantiene el umbral en 80 %, pero no alarma con muestras pequeñas", () => {
    expect(PRECISION_ALERT_THRESHOLD).toBe(0.8);
    expect(PRECISION_ALERT_MIN_REVIEWED).toBe(20);
    expect(shouldAlertPrecision(0.5, 3)).toBe(false);
    expect(shouldAlertPrecision(0.79, 19)).toBe(false);
    expect(shouldAlertPrecision(0.79, 20)).toBe(true);
    expect(shouldAlertPrecision(0.8, 100)).toBe(false);
  });

  it("saca disco_sin_pistas del denominador de cobertura accionable", () => {
    expect(INFORMATIONAL_DETECTOR_KEYS.has("disco_sin_pistas")).toBe(true);
    expect(INFORMATIONAL_DETECTOR_KEYS.has("mayusculas_sostenidas")).toBe(false);
  });
});
