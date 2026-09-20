// CRV · El detector cableado al catálogo.
//
// Tres caminos ponen a trabajar al detector sin que nadie lo pida:
//
//  1. VERIFICACIÓN DIRIGIDA tras una escritura de la API que nombra una ficha
//     (editar, fusionar, convertir, retirar, decidir una revisión). Se agrupan
//     las escrituras del mismo instante —una fusión son varias peticiones— y se
//     analiza la vecindad de esas fichas con los detectores locales: menos de
//     un segundo, y la pantalla ve enseguida si la corrección abrió otra cosa.
//  2. ANÁLISIS COMPLETO DIFERIDO (PLAN_CURADURIA E9.2, A9). Antes cada
//     escritura disparaba un análisis del catálogo entero: una sesión de 30
//     correcciones eran 30 análisis completos. Ahora el completo espera a que
//     las escrituras paren (`CRV_CURATION_FULL_SCAN_IDLE_MS`) y, si no paran,
//     se hace igual pasado `CRV_CURATION_FULL_SCAN_MAX_WAIT_MS` desde la
//     primera escritura sin analizar. Es el que mira lo global —duplicados,
//     cola, «Otros»— y el que reaprende el vocabulario.
//  3. EL VIGILANTE: compara cada `CRV_CURATION_WATCH_MS` los contadores del
//     catálogo (`catalogSignature`). Si cambiaron y se quedaron quietos durante
//     una vuelta —una ingesta ya terminó—, analiza. Cubre la CLI y los scripts.
// Al arrancar, analiza si el catálogo cambió desde el último análisis.
//
// Nada de aquí puede dejar una promesa rechazada sin manejar: se dispara desde
// escrituras de la API y un rechazo suelto termina el proceso (C5). Si otro
// proceso está analizando (`skipped`), la verificación de una escritura se
// reintenta unas veces; el vigilante lo retoma solo en su siguiente vuelta.
import { getEnv } from "../config/env.js";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { catalogSignature, runCurationScan, trackCurationWork, waitForCurationScans } from "./scan.js";
import type { FocusRef } from "./snapshot.js";

const log = moduleLogger("curation:watcher");

/** Ventana para agrupar escrituras seguidas (una fusión son varias peticiones). */
const WRITE_DEBOUNCE_MS = 1500;
/** Si otro proceso tenía el candado: cada cuánto y cuántas veces reintentar la verificación. */
const SKIPPED_RETRY_MS = 5000;
const SKIPPED_RETRIES = 6;
/** Fichas que arrastra una tanda de escrituras antes de dejarlo para el completo. */
const FOCUS_MAX = 200;

interface PendingWrite {
  timer?: NodeJS.Timeout;
  operators: Set<string>;
  routes: Set<string>;
  focus: Map<string, FocusRef>;
  /** Alguna escritura no dijo a qué ficha tocó: la dirigida no la cubre. */
  blind: boolean;
  attempt: number;
}

let pendingWrite: PendingWrite | null = null;

/** Análisis completo pendiente: el reloj de silencio y el tope desde la primera escritura. */
interface PendingFull {
  timer?: NodeJS.Timeout;
  since: number;
  operators: Set<string>;
  routes: Set<string>;
  /** Alguna de las escrituras agrupadas no admite espera (ver `WriteOptions`). */
  soon: boolean;
}

let pendingFull: PendingFull | null = null;

export interface WriteOptions {
  /**
   * `soon`: la decisión cambia lo que ven los detectores GLOBALES —declarar un
   * par distinto, resolver un conflicto— y ningún análisis dirigido puede
   * verificarla, así que el completo no espera al silencio de escrituras.
   * `deferred` (por defecto): el completo llega cuando las escrituras paren.
   */
  fullScan?: "deferred" | "soon";
}

/**
 * Una escritura del catálogo. `refs` son las fichas que tocó, cuando la ruta lo
 * dice: con ellas la verificación es dirigida; sin ellas solo queda el análisis
 * completo diferido.
 */
export function notifyCatalogWrite(
  operator: string | null, route: string, refs: readonly FocusRef[] = [], options: WriteOptions = {},
): void {
  queueWriteScan(operator ? [operator] : [], [route], refs, WRITE_DEBOUNCE_MS, 0);
  scheduleFullScan(operator, route, options.fullScan === "soon");
}

function queueWriteScan(
  operators: Iterable<string>, routes: Iterable<string>, refs: readonly FocusRef[], delayMs: number, attempt: number,
): void {
  const current: PendingWrite = pendingWrite ?? { operators: new Set(), routes: new Set(), focus: new Map(), blind: false, attempt };
  pendingWrite = current;
  if (current.timer) clearTimeout(current.timer);
  for (const operator of operators) current.operators.add(operator);
  for (const route of routes) current.routes.add(route);
  if (!refs.length) current.blind = true;
  for (const ref of refs) {
    if (current.focus.size >= FOCUS_MAX) { current.blind = true; break; }
    current.focus.set(`${ref.kind}:${ref.id}`, ref);
  }
  // Una escritura nueva reinicia la cuenta: hay algo más que verificar.
  current.attempt = Math.min(current.attempt, attempt);
  current.timer = setTimeout(() => {
    pendingWrite = null;
    const focus = [...current.focus.values()];
    // Sin fichas que mirar no hay verificación dirigida posible: el análisis
    // completo diferido es quien lo recoge.
    if (!focus.length) return;
    void trackCurationWork(runCurationScan({
      trigger: "correccion",
      requestedBy: [...current.operators].join(", ") || null,
      detail: [...current.routes].slice(0, 20).join(" · "),
      focus,
    }).then((summary) => {
      if (summary.status === "skipped" && current.attempt < SKIPPED_RETRIES) {
        queueWriteScan(current.operators, current.routes, focus, SKIPPED_RETRY_MS, current.attempt + 1);
      }
    }).catch((error: unknown) => log.error({ err: error }, "no se pudo verificar la escritura con el detector de curaduría")));
  }, delayMs);
  current.timer.unref();
}

/**
 * Programa el análisis completo: espera a que las escrituras paren, pero no
 * más allá del tope desde la primera escritura sin analizar (si no, una ingesta
 * larga lo aplazaría indefinidamente).
 */
function scheduleFullScan(operator: string | null, route: string, soon: boolean): void {
  const env = getEnv();
  const now = Date.now();
  const current: PendingFull = pendingFull ?? { since: now, operators: new Set(), routes: new Set(), soon: false };
  pendingFull = current;
  if (operator) current.operators.add(operator);
  current.routes.add(route);
  current.soon ||= soon;
  if (current.timer) clearTimeout(current.timer);
  const waited = now - current.since;
  const idle = current.soon ? Math.min(WRITE_DEBOUNCE_MS, env.CRV_CURATION_FULL_SCAN_IDLE_MS) : env.CRV_CURATION_FULL_SCAN_IDLE_MS;
  const delay = Math.max(0, Math.min(idle, Math.max(0, env.CRV_CURATION_FULL_SCAN_MAX_WAIT_MS - waited)));
  current.timer = setTimeout(() => {
    pendingFull = null;
    void trackCurationWork(runCurationScan({
      // Sigue siendo la verificación de esas escrituras, solo que la completa:
      // el panorama la muestra como «tras una corrección».
      trigger: "correccion",
      requestedBy: [...current.operators].join(", ") || null,
      detail: `${current.routes.size === 1 ? "" : `${current.routes.size} escrituras · `}${[...current.routes].slice(0, 20).join(" · ")}`,
    }).catch((error: unknown) => log.error({ err: error }, "no se pudo analizar el catálogo tras las escrituras")));
  }, delay);
  current.timer.unref();
}

/** Cancela lo pendiente y espera lo que esté corriendo (cierre de la API). */
export async function flushCurationWork(): Promise<void> {
  if (pendingWrite?.timer) clearTimeout(pendingWrite.timer);
  pendingWrite = null;
  if (pendingFull?.timer) clearTimeout(pendingFull.timer);
  pendingFull = null;
  await waitForCurationScans();
}

/** Solo para pruebas: ¿queda un análisis completo esperando su turno? */
export function fullScanPending(): boolean {
  return pendingFull !== null;
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
    // Las escrituras de la API ya tienen su análisis completo programado: el
    // vigilante no se adelanta a él, solo cubre lo que pasa fuera de la API.
    if (trigger === "cambio_en_catalogo" && pendingFull) return;
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
