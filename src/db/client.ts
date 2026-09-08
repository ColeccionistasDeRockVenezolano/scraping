// CRV · Cliente Drizzle. Un único pool `pg`, un único `db` tipado sobre el
// schema completo (core + ingest + media). El core es de solo lectura desde
// la app salvo el merge engine (CONTRACT §único escritor): no hay un cliente
// separado a nivel de conexión, la disciplina se aplica en el código que usa
// `db` (nunca hacer `db.insert(artists)` fuera de src/merge).
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { getEnv } from "../config/env.js";
import * as schema from "./schema/index.js";

const { Pool } = pg;

let pool: pg.Pool | undefined;

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new Pool({ connectionString: getEnv().DATABASE_URL });
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
