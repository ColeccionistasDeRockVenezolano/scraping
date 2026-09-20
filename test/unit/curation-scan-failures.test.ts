// CRV · Una base caída no tumba el proceso que analiza (PLAN_CURADURIA E1, C5).
//
// Antes, `executeScan` leía la huella del catálogo e insertaba el análisis
// fuera del `try`, y `notifyCatalogWrite` lanzaba el análisis con `void`: si la
// base parpadeaba, la promesa quedaba rechazada sin manejador y Node 22
// termina el proceso (la API entera) por defecto.
import { describe, expect, it, vi } from "vitest";

const broken = vi.hoisted(() => {
  const fail = () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5433"));
  return { query: vi.fn(fail), connect: vi.fn(fail) };
});

vi.mock("../../src/db/client.js", () => ({ getPool: () => broken, closeDb: async () => undefined }));

const { runCurationScan, waitForCurationScans } = await import("../../src/curation/scan.js");
const { notifyCatalogWrite } = await import("../../src/curation/watcher.js");

describe("análisis de Curaduría con la base caída (C5)", () => {
  it("el análisis responde «failed» en vez de rechazar la promesa", async () => {
    await expect(runCurationScan({ trigger: "manual" })).resolves.toMatchObject({ status: "failed" });
    await expect(runCurationScan({ trigger: "cli", dryRun: true })).resolves.toMatchObject({ status: "failed" });
  });

  it("una escritura notificada con la base caída no deja promesas rechazadas sin manejar", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", listener);
    broken.query.mockClear();
    broken.connect.mockClear();
    try {
      vi.useFakeTimers();
      // La escritura nombra la ficha: verificación dirigida enseguida (E9.1) y
      // análisis completo diferido detrás (E9.2). Las dos con la base caída.
      notifyCatalogWrite("Tester Curaduria", "PATCH /artists/:id", [{ kind: "artist", id: 7 }]);
      await vi.advanceTimersByTimeAsync(2_000);
      const afterDirected = broken.query.mock.calls.length + broken.connect.mock.calls.length;
      expect(afterDirected).toBeGreaterThan(0);
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await waitForCurationScans();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(broken.query.mock.calls.length + broken.connect.mock.calls.length).toBeGreaterThan(afterDirected);
      expect(unhandled).toEqual([]);
    } finally {
      vi.useRealTimers();
      process.off("unhandledRejection", listener);
    }
  });

  it("una escritura que no nombra ninguna ficha se queda con el análisis completo diferido (E9.2)", async () => {
    broken.query.mockClear();
    broken.connect.mockClear();
    try {
      vi.useFakeTimers();
      notifyCatalogWrite("Tester Curaduria", "POST /album-credits");
      // La ventana de la verificación dirigida pasa sin que nadie analice: no
      // hay ficha que mirar y un análisis completo por escritura es justo lo
      // que E9 quita.
      await vi.advanceTimersByTimeAsync(5_000);
      expect(broken.query.mock.calls.length + broken.connect.mock.calls.length).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      vi.useRealTimers();
      await waitForCurationScans();
      expect(broken.query.mock.calls.length + broken.connect.mock.calls.length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
