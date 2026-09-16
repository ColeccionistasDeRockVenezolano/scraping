// CRV · Entrypoint HTTP (npm run api). ARCHITECTURE.md §4.14: API en
// 127.0.0.1:8080 por defecto, configurable por PORT/HOST.
import { assertSupportedNode } from "../config/runtime.js";
import { getEnv } from "../config/env.js";
import { moduleLogger } from "../logger/index.js";
import { buildApp } from "./app.js";
import { startCurationWatcher } from "../curation/watcher.js";

const log = moduleLogger("api-server");

async function main(): Promise<void> {
  assertSupportedNode();
  const env = getEnv();
  const app = await buildApp();
  await app.listen({ port: env.PORT, host: env.HOST });
  log.info({ port: env.PORT, host: env.HOST }, "API de lectura escuchando");
  // El detector de conflictos queda cableado al catálogo: analiza al arrancar
  // si algo cambió y vigila los cambios hechos fuera de la API.
  const stopCurationWatcher = startCurationWatcher(env.CRV_CURATION_WATCH_MS);

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopCurationWatcher();
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((error: unknown) => {
  log.error({ err: error }, "la API no pudo arrancar");
  process.exitCode = 1;
});
