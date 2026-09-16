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
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { catalogSignature, runCurationScan, waitForCurationScans } from "./scan.js";

const log = moduleLogger("curation:watcher");

/** Ventana para agrupar escrituras seguidas (una fusión son varias peticiones). */
const WRITE_DEBOUNCE_MS = 1500;

let pendingWrite: { timer?: NodeJS.Timeout; operators: Set<string>; routes: Set<string> } | null = null;

export function notifyCatalogWrite(operator: string | null, route: string): void {
  const current = pendingWrite ?? { operators: new Set<string>(), routes: new Set<string>() };
  pendingWrite = current;
  if (current.timer) clearTimeout(current.timer);
  if (operator) current.operators.add(operator);
  current.routes.add(route);
  current.timer = setTimeout(() => {
    pendingWrite = null;
    void runCurationScan({
      trigger: "correccion",
      requestedBy: [...current.operators].join(", ") || null,
      detail: [...current.routes].slice(0, 20).join(" · "),
    });
  }, WRITE_DEBOUNCE_MS);
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
      "SELECT catalog_signature FROM ingest.curation_scans WHERE status = 'ok' ORDER BY id DESC LIMIT 1");
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
    if (summary.status === "ok") await readLastScanned();
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
