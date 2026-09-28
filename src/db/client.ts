// CRV · Cliente Drizzle. Un único pool `pg`, un único `db` tipado sobre el
// schema completo (core + ingest + media). El core es de solo lectura desde
// la app salvo el merge engine (CONTRACT §único escritor): no hay un cliente
// separado a nivel de conexión, la disciplina se aplica en el código que usa
// `db` (nunca hacer `db.insert(artists)` fuera de src/merge).
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getEnv } from "../config/env.js";
import * as schema from "./schema/index.js";
import { currentRunScope, syncSessionRun } from "./run-binding.js";

const { Pool } = pg;

type ConnectCallback = (err: Error | undefined, client: pg.PoolClient | undefined, done: (release?: unknown) => void) => void;

/**
 * El pool de siempre, más una cosa: cada conexión que presta lleva `crv.run_id`
 * con el run de quien la pide (`withRunScope`, src/db/run-binding.ts), para
 * que el diario de cambios (0028) sepa a qué run pertenece cada escritura.
 * `pool.query` y Drizzle pasan también por aquí.
 */
class RunAwarePool extends Pool {
  override connect(): Promise<pg.PoolClient>;
  override connect(callback: ConnectCallback): void;
  override connect(callback?: ConnectCallback): Promise<pg.PoolClient> | void {
    // El run se lee aquí, en el contexto de quien pide la conexión: el
    // préstamo puede resolverse más tarde desde el contexto de otro.
    const runId = currentRunScope();
    if (callback) {
      super.connect((err, client, done) => {
        if (err || !client) return callback(err, client, done);
        syncSessionRun(client, runId).then(
          () => callback(undefined, client, done),
          (syncError: Error) => { done(syncError); callback(syncError, undefined, done); },
        );
      });
      return;
    }
    return super.connect().then(async (client) => {
      try {
        await syncSessionRun(client, runId);
      } catch (error) {
        client.release(error as Error);
        throw error;
      }
      return client;
    });
  }
}

// DATE sin zona: `pg` lo convierte a un Date en hora local, y la fecha
// guardada (birth_date = 1970-05-02) deja de ser comparable con la afirmada
// ("1970-05-02"). El merge compara valores; se entrega el texto ISO tal cual.
pg.types.setTypeParser(pg.types.builtins.DATE, (value) => value);

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new RunAwarePool({ connectionString: getEnv().DATABASE_URL });
  }
  return pool;
}

export function getDb() {
  return drizzle(getPool(), { schema });
}

export async function closeDb(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export type Database = ReturnType<typeof getDb>;
