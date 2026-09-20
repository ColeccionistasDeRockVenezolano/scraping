import { describe, expect, it } from "vitest";
import { observedPrecision, PRECISION_ALERT_THRESHOLD } from "../../src/curation/metrics.js";

describe("métricas operativas de Curaduría (E12)", () => {
  it("calcula precisión observada solo cuando hay decisiones concluyentes", () => {
    expect(observedPrecision(9, 1)).toBe(0.9);
    expect(observedPrecision(3, 2)).toBe(0.6);
    expect(observedPrecision(0, 0)).toBeNull();
  });

  it("mantiene el umbral de alerta en 80 %", () => {
    expect(PRECISION_ALERT_THRESHOLD).toBe(0.8);
  });
});
