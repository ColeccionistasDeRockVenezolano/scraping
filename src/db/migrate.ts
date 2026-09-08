// CRV · Runner de migraciones (Drizzle como ejecutor + pool; el harness de
// versionado sigue siendo la tabla ingest.schema_migrations, igual que
// tests/migrate.sh). El DDL real vive en migrations/*.up.sql/.down.sql:
// este módulo NO genera SQL (no hay drizzle-kit push/generate aquí), solo
// aplica esos archivos en orden y registra qué versión quedó aplicada.
//
// Por qué no drizzle-kit: 0001-0007 están íntegramente probadas contra
// PostgreSQL 16 (tests/run_all.sh, tests/test_0004_review_kinds.sh, diff de
// pg_dump vacío). Regenerarlas desde drizzle-kit introduciría una segunda
// fuente de verdad sin ese mismo nivel de prueba. Ver ARCHITECTURE.md §1.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import { moduleLogger } from "../logger/index.js";
import { getPool, closeDb } from "./client.js";
import { assertSupportedNode } from "../config/runtime.js";

const log = moduleLogger("db:migrate");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = path.resolve(__dirname, "..", "..", "migrations");

async function ensureHarness(pool: Pool): Promise<void> {
  await pool.query("CREATE SCHEMA IF NOT EXISTS ingest;");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS ingest.schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function appliedVersions(pool: Pool): Promise<Set<string>> {
  const { rows } = await pool.query<{ version: string }>(
    "SELECT version FROM ingest.schema_migrations",
  );
  return new Set(rows.map((r) => r.version));
}

async function listMigrationFiles(dir: string, suffix: ".up.sql" | ".down.sql"): Promise<string[]> {
  const entries = await readdir(dir);
  return entries
    .filter((f) => f.endsWith(suffix))
    .sort(); // 0001_..., 0002_..., ... — orden lexicográfico = orden de versión
}

/** Aplica todas las migraciones *.up.sql pendientes, en orden, e idempotente. */
export async function migrateUp(migrationsDir = DEFAULT_MIGRATIONS_DIR): Promise<{ applied: string[] }> {
  const pool = getPool();
  await ensureHarness(pool);
  const already = await appliedVersions(pool);

  const files = await listMigrationFiles(migrationsDir, ".up.sql");
  const applied: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.up\.sql$/, "");
    if (already.has(version)) {
      log.info({ version }, "skip (ya aplicada)");
      continue;
    }
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    log.info({ version }, "aplicando");
    // Una sola query de texto plano: protocolo simple (igual que `psql -f`),
    // soporta múltiples sentencias y bloques DO $$...$$ tal cual el archivo.
    await pool.query(sql);
    await pool.query("INSERT INTO ingest.schema_migrations(version) VALUES ($1)", [version]);
    applied.push(version);
  }

  if (applied.length === 0) {
    log.info("sin migraciones pendientes");
  }
  return { applied };
}

/**
 * Aplica todos los *.down.sql en orden inverso (rollback completo). No es
 * el flujo normal de operación: existe para los contract tests y para
 * deshacer en desarrollo. Cada down.sql decide por sí mismo si es seguro
 * (p. ej. 0004 aborta si hay filas usando sus valores).
 */
export async function migrateDownAll(migrationsDir = DEFAULT_MIGRATIONS_DIR): Promise<{ reverted: string[] }> {
  const pool = getPool();
  await ensureHarness(pool);

  const files = (await listMigrationFiles(migrationsDir, ".down.sql")).reverse();
  const reverted: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.down\.sql$/, "");
    const sql = await readFile(path.join(migrationsDir, file), "utf8");
    log.info({ version }, "revirtiendo");
    // El registro de control se borra ANTES de ejecutar el down: el down de
    // 0001 elimina la propia tabla ingest.schema_migrations (bookkeeping del
    // harness, no del dominio — ver migrations/0001_ingest_core.down.sql),
    // así que intentar el DELETE después fallaría con "relation does not exist".
    await pool.query("DELETE FROM ingest.schema_migrations WHERE version = $1", [version]);
    await pool.query(sql);
    reverted.push(version);
  }
  return { reverted };
}

// Permite `tsx src/db/migrate.ts` / `npm run db:migrate` como CLI directo.
const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  assertSupportedNode();
  const mode = process.argv[2] === "down" ? "down" : "up";
  (mode === "down" ? migrateDownAll() : migrateUp())
    .then((result) => {
      log.info(result, mode === "down" ? "rollback completo" : "migración completa");
      return closeDb();
    })
    .catch(async (err: unknown) => {
      log.error({ err }, "fallo de migración");
      await closeDb();
      process.exitCode = 1;
    });
}
