// CRV · El detector cableado al catálogo.
//
// Dos caminos disparan un análisis sin que nadie lo pida:
//  1. Una escritura correcta de la API (editar, fusionar, convertir, retirar,
//     decidir una revisión): `notifyCatalogWrite` la agrupa con las que lleguen
//     en el mismo instante y analiza enseguida para verificar la corrección.
//  2. El vigilante: compara cada `CRV_CURATION_WATCH_MS` los contadores del
//     catálogo (`catalogSignature`). Si cambiaron y se quedaron quietos durante
//     una vuelta —una ingesta ya terminó—, analiza. Cubre la CLI y los scripts.
// Al arrancar, analiza si el catálogo cambió desde el último análisis.
//
// Nada de aquí puede dejar una promesa rechazada sin manejar: se dispara desde
// escrituras de la API y un rechazo suelto termina el proceso (C5). Si otro
// proceso está analizando (`skipped`), la verificación de una escritura se
// reintenta unas veces; el vigilante lo retoma solo en su siguiente vuelta.
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { catalogSignature, runCurationScan, waitForCurationScans } from "./scan.js";

const log = moduleLogger("curation:watcher");

/** Ventana para agrupar escrituras seguidas (una fusión son varias peticiones). */
const WRITE_DEBOUNCE_MS = 1500;
/** Si otro proceso tenía el candado: cada cuánto y cuántas veces reintentar la verificación. */
const SKIPPED_RETRY_MS = 5000;
const SKIPPED_RETRIES = 6;

let pendingWrite: { timer?: NodeJS.Timeout; operators: Set<string>; routes: Set<string>; attempt: number } | null = null;

export function notifyCatalogWrite(operator: string | null, route: string): void {
  queueWriteScan(operator ? [operator] : [], [route], WRITE_DEBOUNCE_MS, 0);
}

function queueWriteScan(operators: Iterable<string>, routes: Iterable<string>, delayMs: number, attempt: number): void {
  const current = pendingWrite ?? { operators: new Set<string>(), routes: new Set<string>(), attempt };
  pendingWrite = current;
  if (current.timer) clearTimeout(current.timer);
  for (const operator of operators) current.operators.add(operator);
  for (const route of routes) current.routes.add(route);
  // Una escritura nueva reinicia la cuenta: hay algo más que verificar.
  current.attempt = Math.min(current.attempt, attempt);
  current.timer = setTimeout(() => {
    pendingWrite = null;
    runCurationScan({
      trigger: "correccion",
      requestedBy: [...current.operators].join(", ") || null,
      detail: [...current.routes].slice(0, 20).join(" · "),
    }).then((summary) => {
      if (summary.status === "skipped" && current.attempt < SKIPPED_RETRIES) {
        queueWriteScan(current.operators, current.routes, SKIPPED_RETRY_MS, current.attempt + 1);
      }
    }).catch((error: unknown) => log.error({ err: error }, "no se pudo verificar la escritura con el detector de curaduría"));
  }, delayMs);
  current.timer.unref();
}

/** Cancela la escritura pendiente y espera lo que esté corriendo (cierre de la API). */
export async function flushCurationWork(): Promise<void> {
  if (pendingWrite?.timer) clearTimeout(pendingWrite.timer);
  pendingWrite = null;
  await waitForCurationScans();
}

export function startCurationWatcher(intervalMs: number): () => void {
  let stopped = false;
  let lastSeen = "";
  let lastScanned = "";

  const readLastScanned = async (): Promise<void> => {
    const { rows } = await getPool().query<{ catalog_signature: string | null }>(
      // Una verificación dirigida no miró todo el catálogo: su firma no cuenta como «ya analizado».
      "SELECT catalog_signature FROM ingest.curation_scans WHERE status IN ('ok', 'partial') AND scope = 'completo' ORDER BY id DESC LIMIT 1");
    lastScanned = rows[0]?.catalog_signature ?? "";
  };

  const tick = async (trigger: "inicio" | "cambio_en_catalogo"): Promise<void> => {
    if (stopped) return;
    const signature = await catalogSignature();
    const stable = signature === lastSeen;
    lastSeen = signature;
    if (signature === lastScanned) return;
    if (trigger === "cambio_en_catalogo" && !stable) return;
    const summary = await runCurationScan({ trigger });
    // Un análisis parcial también cuenta: un detector roto no se arregla
    // repitiendo el análisis cada vuelta. Uno omitido se retoma en la siguiente.
    if (summary.status === "ok" || summary.status === "partial") await readLastScanned();
  };

  const guard = (trigger: "inicio" | "cambio_en_catalogo") => {
    tick(trigger).catch((error: unknown) => log.error({ err: error }, "el vigilante de curaduría no pudo comprobar el catálogo"));
  };

  const boot = setTimeout(() => {
    readLastScanned().then(() => guard("inicio"), (error: unknown) => log.error({ err: error }, "no se pudo leer el último análisis de curaduría"));
  }, 3000);
  boot.unref();
  const interval = intervalMs > 0 ? setInterval(() => guard("cambio_en_catalogo"), intervalMs) : null;
  interval?.unref();
  log.info({ intervalMs }, "vigilante de curaduría activo");

  return () => {
    stopped = true;
    clearTimeout(boot);
    if (interval) clearInterval(interval);
  };
}
