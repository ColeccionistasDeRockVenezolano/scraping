// CRV · doctor — integridad operativa (ARCHITECTURE.md §4.13, PHASES F0).
// Verifica: (1) el core no fue modificado (hash), (2) el catálogo del core
// tiene la forma esperada (enums/tablas/vistas), (3) los schemas auxiliares
// existen, (4) estado de fuentes registradas. No modifica nada.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getPool } from "../db/client.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");

// Inventario esperado del core, verificado por auditoría manual de
// crv_simple_v1.sql (CONTRACT §2.1) — cambia solo si el core cambia, lo
// cual requiere aprobación explícita del propietario (CONTRACT §13).
const EXPECTED_CORE = {
  enums: 7,
  tables: 10,
  views: 3,
} as const;

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: DoctorCheck[];
}

async function checkCoreHash(): Promise<DoctorCheck> {
  const sqlPath = path.join(ROOT, "crv_simple_v1.sql");
  const hashFilePath = path.join(ROOT, "crv_simple_v1.sql.sha256");
  try {
    const [sql, hashFile] = await Promise.all([
      readFile(sqlPath, "utf8"),
      readFile(hashFilePath, "utf8"),
    ]);
    const expected = hashFile.trim().split(/\s+/)[0] ?? "";
    const actual = createHash("sha256").update(sql).digest("hex");
    const ok = expected.length === 64 && expected === actual;
    return {
      name: "core.hash",
      ok,
      detail: ok
        ? `crv_simple_v1.sql coincide con el hash registrado (${actual.slice(0, 12)}…)`
        : `MISMATCH — registrado ${expected.slice(0, 12)}… vs actual ${actual.slice(0, 12)}…`,
    };
  } catch (err) {
    return { name: "core.hash", ok: false, detail: `no se pudo verificar: ${String(err)}` };
  }
}

async function checkCoreCatalog(pool: Pool): Promise<DoctorCheck> {
  const { rows } = await pool.query<{ enums: string; tables: string; views: string }>(`
    SELECT
      (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = 'public' AND t.typtype = 'e')::text AS enums,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r')::text AS tables,
      (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'v')::text AS views
  `);
  const row = rows[0];
  if (!row) return { name: "core.catalog", ok: false, detail: "public no existe o está vacío" };
  const enums = Number(row.enums);
  const tables = Number(row.tables);
  const views = Number(row.views);
  const ok = enums === EXPECTED_CORE.enums && tables === EXPECTED_CORE.tables && views === EXPECTED_CORE.views;
  return {
    name: "core.catalog",
    ok,
    detail: `enums=${enums}/${EXPECTED_CORE.enums} tablas=${tables}/${EXPECTED_CORE.tables} vistas=${views}/${EXPECTED_CORE.views}`,
  };
}

async function checkAuxSchemas(pool: Pool): Promise<DoctorCheck> {
  const { rows } = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname IN ('ingest','media') ORDER BY 1",
  );
  const found = rows.map((r) => r.nspname);
  const ok = found.includes("ingest") && found.includes("media");
  return {
    name: "aux.schemas",
    ok,
    detail: ok ? "ingest + media presentes" : `faltan schemas auxiliares (encontrados: ${found.join(", ") || "ninguno"})`,
  };
}

async function checkMigrations(pool: Pool): Promise<DoctorCheck> {
  try {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM ingest.schema_migrations ORDER BY version",
    );
    return {
      name: "migrations.applied",
      ok: rows.length > 0,
      detail: rows.length > 0 ? rows.map((r) => r.version).join(", ") : "ninguna migración aplicada",
    };
  } catch {
    return { name: "migrations.applied", ok: false, detail: "ingest.schema_migrations no existe" };
  }
}

async function checkSources(pool: Pool): Promise<DoctorCheck> {
  try {
    const { rows } = await pool.query<{ total: string; enabled: string }>(
      "SELECT count(*)::text AS total, count(*) FILTER (WHERE enabled)::text AS enabled FROM ingest.sources",
    );
    const row = rows[0];
    const total = Number(row?.total ?? 0);
    const enabled = Number(row?.enabled ?? 0);
    return {
      name: "sources.status",
      ok: true, // informativo: 0 fuentes es válido antes de F1 (seed pendiente)
      detail: `${total} fuentes registradas, ${enabled} habilitadas`,
    };
  } catch {
    return { name: "sources.status", ok: false, detail: "ingest.sources no existe" };
  }
}

/** Ejecuta todos los chequeos. No requiere que la DB tenga las migraciones aplicadas. */
export async function runDoctor(): Promise<DoctorReport> {
  const pool = getPool();
  const checks: DoctorCheck[] = [await checkCoreHash()];

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    checks.push({ name: "db.connection", ok: false, detail: `no se pudo conectar: ${String(err)}` });
    return { ok: false, checks };
  }
  checks.push({ name: "db.connection", ok: true, detail: "conectado" });

  checks.push(await checkCoreCatalog(pool));
  checks.push(await checkAuxSchemas(pool));
  checks.push(await checkMigrations(pool));
  checks.push(await checkSources(pool));

  return { ok: checks.every((c) => c.ok), checks };
}
