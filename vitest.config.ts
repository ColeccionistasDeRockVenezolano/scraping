import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/unit/setup.ts"],
    // Los tests de contrato levantan contenedores Docker propios: no
    // paralelizar entre archivos evita agotar puertos/recursos en 1 máquina
    // (ARCHITECTURE.md §9 — sin infraestructura de test distribuida).
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
