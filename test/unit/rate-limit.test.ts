import { afterEach, describe, expect, it, vi } from "vitest";
import { createWindowLimiter } from "../../src/api/rate-limit.js";

// Auditoría #10: el límite de ráfaga de escrituras (auth.ts lo usa por cuenta).
describe("límite de ráfaga por ventana", () => {
  afterEach(() => vi.useRealTimers());

  it("permite hasta el tope, bloquea el siguiente y libera al reiniciar la ventana", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-18T10:00:00Z"));
    const limiter = createWindowLimiter({ max: 3, windowMs: 60_000 });
    expect([limiter.take("a"), limiter.take("a"), limiter.take("a")]).toEqual([true, true, true]);
    expect(limiter.take("a")).toBe(false);
    expect(limiter.remaining("a")).toBe(0);
    expect(limiter.take("b")).toBe(true); // claves independientes

    vi.advanceTimersByTime(60_001);
    expect(limiter.take("a")).toBe(true);
    expect(limiter.remaining("a")).toBe(2);
  });

  it("max 0 apaga el límite", () => {
    const unlimited = createWindowLimiter({ max: 0, windowMs: 60_000 });
    for (let i = 0; i < 50; i += 1) expect(unlimited.take("x")).toBe(true);
  });

  it("el mapa de claves está acotado: la más vieja se poda", () => {
    const bounded = createWindowLimiter({ max: 5, windowMs: 60_000, maxKeys: 2 });
    expect(bounded.take("k1")).toBe(true);
    expect(bounded.take("k2")).toBe(true);
    expect(bounded.take("k3")).toBe(true);
    expect(bounded.take("k1")).toBe(true);
  });
});
