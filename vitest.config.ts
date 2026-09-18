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
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "html", "json-summary"],
      reportsDirectory: "./coverage",
      // La cobertura se mide sobre las unitarias (rápidas, sin PostgreSQL):
      // los contratos ejercen los caminos de base de datos, pero su coste
      // (contenedor por archivo) los deja fuera del informe y del umbral.
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"],
      // Piso del nivel actual (35,5 % de sentencias / 80,8 % de ramas al
      // 2026-09-18), con holgura para no bloquear trabajo legítimo: cualquier
      // caída por debajo de esto es una regresión, no un cambio de estilo.
      thresholds: { statements: 35, lines: 35, functions: 45, branches: 78 },
    },
  },
});
