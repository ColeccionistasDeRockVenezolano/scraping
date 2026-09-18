// CRV · doctor — integridad operativa (ARCHITECTURE.md §4.13, PHASES F0).
// Verifica: (0) el runtime cumple engines.node, (1) el core no fue modificado
// (hash del archivo), (2) el esquema `public` de la base viva coincide
// entrada por entrada con la huella del core (enums, columnas, vistas,
// constraints, índices), (3) los schemas auxiliares existen, (4) las
// migraciones aplicadas, (5) cobertura de merge_audit y (6) estado de
// fuentes. No modifica nada.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getPool } from "../db/client.js";
import { MIN_NODE_MAJOR, isSupportedNode } from "../config/runtime.js";
import { CORE_CATALOG, readCoreCatalog, diffCoreCatalog } from "./core-catalog.js";

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

export type CheckStatus = "ok" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: CheckStatus;
  /** Compatibilidad: `warn` no rompe el verde, solo `fail`. */
  ok: boolean;
  detail: string;
}

export interface DoctorReport {
  ok: boolean;
  warnings: number;
  checks: DoctorCheck[];
}

function check(name: string, status: CheckStatus, detail: string): DoctorCheck {
  return { name, status, ok: status !== "fail", detail };
}

function checkRuntime(): DoctorCheck {
  return isSupportedNode()
    ? check("runtime.node", "ok", `${process.version} (>= ${MIN_NODE_MAJOR}, engines.node)`)
    : check(
        "runtime.node",
        "fail",
        `${process.version} < v${MIN_NODE_MAJOR}: usa \`nvm use\` (.nvmrc) o los scripts npm (scripts/with-node22.sh)`,
      );
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
    return check(
      "core.hash",
      ok ? "ok" : "fail",
      ok
        ? `crv_simple_v1.sql coincide con el hash registrado (${actual.slice(0, 12)}…)`
        : `MISMATCH — registrado ${expected.slice(0, 12)}… vs actual ${actual.slice(0, 12)}…`,
    );
  } catch (err) {
    return check("core.hash", "fail", `no se pudo verificar: ${String(err)}`);
  }
}

/**
 * Compara el `public` real contra la huella commiteada. Los conteos solos
 * (7/10/3) no detectan un ALTER de columna, un CHECK borrado ni una vista
 * redefinida: la comparación es entrada por entrada.
 */
async function checkCoreCatalog(pool: Pool): Promise<DoctorCheck> {
  let counts: { enums: number; tables: number; views: number };
  try {
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
    if (!row) return check("core.catalog", "fail", "public no existe o está vacío");
    counts = { enums: Number(row.enums), tables: Number(row.tables), views: Number(row.views) };
  } catch (err) {
    return check("core.catalog", "fail", `no se pudo leer el catálogo: ${String(err)}`);
  }

  const shape =
    `enums=${counts.enums}/${EXPECTED_CORE.enums} ` +
    `tablas=${counts.tables}/${EXPECTED_CORE.tables} ` +
    `vistas=${counts.views}/${EXPECTED_CORE.views}`;

  if (CORE_CATALOG.entries.length === 0) {
    return check("core.catalog", "warn", `${shape} — huella sin generar (npm run core:catalog)`);
  }

  const actual = await readCoreCatalog(pool);
  const { missing, extra } = diffCoreCatalog(actual);
  if (missing.length === 0 && extra.length === 0) {
    return check("core.catalog", "ok", `${shape}, huella exacta (${actual.length} objetos)`);
  }

  const sample = [
    ...missing.slice(0, 3).map((e) => `- ${e}`),
    ...extra.slice(0, 3).map((e) => `+ ${e}`),
  ].join(" | ");
  return check(
    "core.catalog",
    "fail",
    `DRIFT en public — faltan ${missing.length}, sobran ${extra.length}: ${sample}`,
  );
}

async function checkAuxSchemas(pool: Pool): Promise<DoctorCheck> {
  const { rows } = await pool.query<{ nspname: string }>(
    "SELECT nspname FROM pg_namespace WHERE nspname IN ('ingest','media') ORDER BY 1",
  );
  const found = rows.map((r) => r.nspname);
  const ok = found.includes("ingest") && found.includes("media");
  return check(
    "aux.schemas",
    ok ? "ok" : "fail",
    ok ? "ingest + media presentes" : `faltan schemas auxiliares (encontrados: ${found.join(", ") || "ninguno"})`,
  );
}

async function checkMigrations(pool: Pool): Promise<DoctorCheck> {
  try {
    const { rows } = await pool.query<{ version: string }>(
      "SELECT version FROM ingest.schema_migrations ORDER BY version",
    );
    return rows.length > 0
      ? check("migrations.applied", "ok", rows.map((r) => r.version).join(", "))
      : check("migrations.applied", "fail", "ninguna migración aplicada");
  } catch {
    return check("migrations.applied", "fail", "ingest.schema_migrations no existe");
  }
}

/**
 * Cada fila materializada por el pipeline en el core (o en media_links) debe
 * tener al menos una operación de auditoría, y toda operación debe enlazar el
 * claim que la justificó. No intenta inferir historia desde el valor actual:
 * comprueba las dos relaciones estructurales que hacen esa historia
 * consultable y detecta escrituras directas que se saltaron el merge engine.
 */
async function checkMergeAudit(pool: Pool): Promise<DoctorCheck> {
  try {
    const { rows } = await pool.query<{ unaudited: string; orphan_audits: string; runless: string; runless_recent: string }>(`
      WITH unaudited AS (
        SELECT a.id FROM public.artists a
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.artist_id=a.id)
        UNION ALL SELECT p.id FROM public.persons p
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.person_id=p.id)
        UNION ALL SELECT o.id FROM public.organizations o
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.organization_id=o.id)
        UNION ALL SELECT a.id FROM public.albums a
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.album_id=a.id)
        UNION ALL SELECT t.id FROM public.tracks t
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.track_id=t.id)
        UNION ALL SELECT am.id FROM public.artist_members am
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.artist_membership_id=am.id)
        UNION ALL SELECT po.id FROM public.person_organizations po
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.person_organization_id=po.id)
        UNION ALL SELECT ac.id FROM public.album_credits ac
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.album_credit_id=ac.id)
        UNION ALL SELECT tc.id FROM public.track_credits tc
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.track_credit_id=tc.id)
        UNION ALL SELECT af.id FROM public.album_formats af
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.album_format_id=af.id)
        UNION ALL SELECT ml.id FROM media.media_links ml
         WHERE NOT EXISTS (SELECT 1 FROM ingest.merge_audit ma WHERE ma.media_link_id=ml.id)
      )
      SELECT
        (SELECT count(*) FROM unaudited)::text AS unaudited,
        (SELECT count(*) FROM ingest.merge_audit ma
          WHERE NOT EXISTS (
            SELECT 1 FROM ingest.merge_audit_claims mac WHERE mac.merge_audit_id=ma.id
          ))::text AS orphan_audits,
        -- Sin run: la corrección quedó auditada pero sin enlace a la ejecución
        -- que la hizo (pasó masivamente el 2026-09-13/14, cierre F2–F5). El
        -- histórico se tolera; una fila NUEVA sin run es una regresión.
        (SELECT count(*) FROM ingest.merge_audit WHERE run_id IS NULL)::text AS runless,
        (SELECT count(*) FROM ingest.merge_audit WHERE run_id IS NULL AND at >= now() - interval '3 days')::text AS runless_recent
    `);
    const unaudited = Number(rows[0]?.unaudited ?? 0);
    const orphanAudits = Number(rows[0]?.orphan_audits ?? 0);
    const runless = Number(rows[0]?.runless ?? 0);
    const runlessRecent = Number(rows[0]?.runless_recent ?? 0);
    const ok = unaudited === 0 && orphanAudits === 0;
    if (!ok) return check("merge_audit.coverage", "fail", `${unaudited} filas canónicas sin auditoría; ${orphanAudits} auditorías sin claim`);
    const base = "todas las filas canónicas tienen auditoría y toda auditoría enlaza claims";
    if (runlessRecent > 0) {
      return check("merge_audit.coverage", "warn", `${base}; ${runlessRecent} auditorías de los últimos 3 días sin run — ¿escritura fuera de withOperatorRun?`);
    }
    return check("merge_audit.coverage", "ok", runless > 0 ? `${base} (${runless} históricas sin run, anteriores al cierre F2–F5)` : base);
  } catch (err) {
    return check("merge_audit.coverage", "fail", `no se pudo verificar: ${String(err)}`);
  }
}

/**
 * Estado de fuentes. No es un `ok` fijo: una base migrada pero sin sembrar, o
 * con fuentes pero ninguna habilitada, no puede scrapear nada — es un aviso
 * accionable, no un fallo (ambos estados son válidos y reversibles).
 */
async function checkSources(pool: Pool): Promise<DoctorCheck> {
  try {
    const { rows } = await pool.query<{ total: string; enabled: string }>(
      "SELECT count(*)::text AS total, count(*) FILTER (WHERE enabled)::text AS enabled FROM ingest.sources",
    );
    const row = rows[0];
    const total = Number(row?.total ?? 0);
    const enabled = Number(row?.enabled ?? 0);
    const detail = `${total} fuentes registradas, ${enabled} habilitadas`;
    if (total === 0) return check("sources.status", "warn", `${detail} — ejecuta \`npm run cli -- sources:seed\``);
    if (enabled === 0) return check("sources.status", "warn", `${detail} — ninguna fuente es scrapeable`);
    return check("sources.status", "ok", detail);
  } catch {
    return check("sources.status", "fail", "ingest.sources no existe");
  }
}

/** Ejecuta todos los chequeos. No requiere que la DB tenga las migraciones aplicadas. */
export async function runDoctor(): Promise<DoctorReport> {
  const pool = getPool();
  const checks: DoctorCheck[] = [checkRuntime(), await checkCoreHash()];

  const finish = (): DoctorReport => ({
    ok: checks.every((c) => c.status !== "fail"),
    warnings: checks.filter((c) => c.status === "warn").length,
    checks,
  });

  try {
    await pool.query("SELECT 1");
  } catch (err) {
    checks.push(check("db.connection", "fail", `no se pudo conectar: ${String(err)}`));
    return finish();
  }
  checks.push(check("db.connection", "ok", "conectado"));

  checks.push(await checkCoreCatalog(pool));
  checks.push(await checkAuxSchemas(pool));
  checks.push(await checkMigrations(pool));
  checks.push(await checkMergeAudit(pool));
  checks.push(await checkSources(pool));

  return finish();
}
