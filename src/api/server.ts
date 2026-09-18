// CRV · Entrypoint HTTP (npm run api). ARCHITECTURE.md §4.14: API en
// 127.0.0.1:8080 por defecto, configurable por PORT/HOST.
import { assertSupportedNode } from "../config/runtime.js";
import { getEnv } from "../config/env.js";
import { moduleLogger } from "../logger/index.js";
import { buildApp } from "./app.js";
import { startCurationWatcher } from "../curation/watcher.js";
import { startEntityResolutionRetention } from "../er/retention.js";

const log = moduleLogger("api-server");

// Una promesa rechazada sin manejador no puede tumbar la API: Node 22 termina
// el proceso por defecto, y trabajo de fondo como la verificación de Curaduría
// corre sin que ninguna petición lo espere. Se registra y el servicio sigue.
process.on("unhandledRejection", (reason: unknown) => {
  log.error({ err: reason }, "promesa rechazada sin manejar");
});

async function main(): Promise<void> {
  assertSupportedNode();
  const env = getEnv();
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
  log.info({ port: env.PORT, host: env.HOST }, "API de lectura escuchando");
  // El detector de conflictos queda cableado al catálogo: analiza al arrancar
  // si algo cambió y vigila los cambios hechos fuera de la API.
  const stopCurationWatcher = startCurationWatcher(env.CRV_CURATION_WATCH_MS);
  // La retención de decisiones ER corre sola cada ER_RETENTION_INTERVAL_HOURS
  // con tope de filas (la CLI puede forzarla con `crv er:prune`).
  const stopErRetention = startEntityResolutionRetention(
    env.ER_RETENTION_INTERVAL_HOURS * 60 * 60 * 1000, env.ER_RETENTION_MAX_ROWS);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopCurationWatcher();
      stopErRetention();
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  log.error({ err: error }, "la API no pudo arrancar");
  process.exitCode = 1;
});
