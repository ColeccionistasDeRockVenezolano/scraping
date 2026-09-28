// CRV · A qué run pertenece cada escritura (migración 0028, diario de cambios).
//
// El disparador `crv_journal` anota cada fila que cambia con `crv.run_id`, una
// variable de PostgreSQL. Hay tres formas de fijarla, de la más automática a
// la más explícita:
//
//  * CREAR EL RUN. `ingest.crv_bind_run()` la fija para la transacción que
//    inserta la fila en `scrape_runs`: `withOperatorRun`, los planes de la CLI
//    y cualquier proceso que abra su run en la misma transacción que escribe
//    quedan ligados sin hacer nada.
//  * `withRunScope(runId, fn)`. Para los procesos que abren el run y después
//    escriben en muchas transacciones (lotes, sincronizaciones). Todo cliente
//    que `fn` saque del pool —también los de `pool.query` y Drizzle— entra con
//    la variable fijada a nivel de sesión. El pool la cambia o la vacía al
//    prestar la conexión a otro, así que no se filtra a quien no la pidió.
//  * `bindRun(client, runId)`. Para una transacción concreta que ya sabe su
//    run (el motor de merge, con el `runId` de cada claim).
import { AsyncLocalStorage } from "node:async_hooks";
import type pg from "pg";

const scope = new AsyncLocalStorage<number>();

/** El run en curso de este flujo asíncrono, si alguien lo abrió con `withRunScope`. */
export function currentRunScope(): number | undefined {
  return scope.getStore();
}

/** Corre `fn` con toda escritura a la base ligada a `runId`. */
export function withRunScope<T>(runId: number, fn: () => Promise<T>): Promise<T> {
  if (!Number.isSafeInteger(runId) || runId <= 0) throw new Error(`run inválido para el diario: ${runId}`);
  return scope.run(runId, fn);
}

/** Liga la transacción abierta en `client` a `runId` (hasta su COMMIT o ROLLBACK). */
export async function bindRun(client: Pick<pg.PoolClient, "query">, runId: number | undefined | null): Promise<void> {
  if (runId === undefined || runId === null || !Number.isSafeInteger(runId) || runId <= 0) return;
  await client.query("SELECT set_config('crv.run_id', $1, true)", [String(runId)]);
}

/** Valor de sesión que ya lleva cada conexión, para no repetir el SET si no cambia. */
const sessionRun = new WeakMap<object, number | undefined>();

/**
 * Deja la conexión con el run del flujo que la pide (o sin run). Solo cuesta
 * una ida y vuelta cuando cambia: la mayoría de las conexiones nunca tienen
 * run y nunca lo pagan.
 */
export async function syncSessionRun(client: pg.PoolClient, runId: number | undefined): Promise<void> {
  if (sessionRun.get(client) === runId) return;
  await client.query("SELECT set_config('crv.run_id', $1, false)", [runId === undefined ? "" : String(runId)]);
  if (runId === undefined) sessionRun.delete(client);
  else sessionRun.set(client, runId);
}
