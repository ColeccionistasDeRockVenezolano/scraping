// CRV · doctor — integridad operativa (ARCHITECTURE.md §4.13, PHASES F0).
// Verifica: (0) el runtime cumple engines.node, (1) el core no fue modificado
// (hash del archivo), (2) el esquema `public` de la base viva coincide
// entrada por entrada con la huella del core (enums, columnas, vistas,
// constraints, índices), (3) los schemas auxiliares existen, (4) las
// migraciones aplicadas, (5) cobertura de merge_audit, (6) estado de
// fuentes y (7) coherencia de los géneros asignados. No modifica nada.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getPool } from "../db/client.js";
import { getEnv } from "../config/env.js";
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
/**
 * Diario de cambios (0028): toda tabla registrada que exista tiene su
 * disparador, y las escrituras de los últimos 7 días quedaron ligadas a un
 * run. Una escritura sin run está en el diario pero no se puede deshacer
 * desde el historial: señala un proceso que abre transacciones sin
 * `withRunScope` (src/db/run-binding.ts).
 */
async function checkChangeJournal(pool: Pool): Promise<DoctorCheck> {
  const exists = await pool.query<{ ok: boolean }>("SELECT to_regclass('ingest.change_journal') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) return check("journal.triggers", "warn", "sin diario de cambios: falta la migración 0028_change_journal (npm run db:migrate)");
  const missing = await pool.query<{ table_name: string }>(`
    SELECT t.table_name FROM ingest.change_journal_tables t
     WHERE to_regclass(t.table_name) IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = to_regclass(t.table_name) AND g.tgname = 'crv_journal')
     ORDER BY 1`);
  if (missing.rows.length) {
    return check("journal.triggers", "fail",
      `${missing.rows.length} tabla(s) sin disparador del diario (${missing.rows.map((row) => row.table_name).join(", ")}): SELECT ingest.crv_journal_attach_all();`);
  }
  const unbound = await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM ingest.change_journal WHERE run_id IS NULL AND at > now() - interval '7 days'");
  const n = Number(unbound.rows[0]?.n ?? 0);
  // Un cambio sin run (SQL a mano, semillas) es legítimo: se informa, no se avisa.
  return check("journal.triggers", "ok", n > 0
    ? `todas las tablas registradas tienen disparador; ${n} cambio(s) de los últimos 7 días sin run (hechos fuera de la app: no se deshacen desde el historial)`
    : "todas las tablas registradas tienen disparador y los cambios recientes tienen run");
}

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

/**
 * Géneros asignados (PLAN_GENEROS §4): ninguna fila apunta a una ficha
 * fusionada, `superseded_by` no cruza de entidad, las reglas no usan géneros
 * inactivos, la evidencia existe y, con la proyección encendida,
 * `albums.genre` coincide con el principal confirmado.
 */
async function checkGenres(pool: Pool): Promise<DoctorCheck> {
  const present = await pool.query<{ ok: boolean }>("SELECT to_regclass('ingest.album_genres') IS NOT NULL AS ok");
  if (!present.rows[0]?.ok) return check("genres.assignments", "ok", "sin tablas de géneros (migración 0027 pendiente)");
  const failures: string[] = [];
  const warnings: string[] = [];
  let total = 0;
  for (const kind of ["artist", "album"] as const) {
    const table = `ingest.${kind}_genres`;
    const { rows } = await pool.query<{ total: string; merged: string; crossed: string; inactive: string; missing: string }>(`
      SELECT (SELECT count(*) FROM ${table})::text AS total,
             (SELECT count(*) FROM ${table} g JOIN ingest.entity_redirects r
                ON r.entity_kind::text = $1 AND r.from_id = g.${kind}_id)::text AS merged,
             (SELECT count(*) FROM ${table} g JOIN ${table} s ON s.id = g.superseded_by_id
               WHERE s.${kind}_id <> g.${kind}_id)::text AS crossed,
             (SELECT count(*) FROM ${table} g JOIN ingest.genres x ON x.id = g.genre_id
               WHERE NOT x.active AND g.decision_kind = 'rule' AND g.status <> 'superseded')::text AS inactive,
             (SELECT count(*) FROM ${table} g CROSS JOIN LATERAL unnest(g.claim_ids) AS c(id)
               WHERE NOT EXISTS (SELECT 1 FROM ingest.claims k WHERE k.id = c.id))::text AS missing`, [kind]);
    const row = rows[0]!;
    total += Number(row.total);
    if (Number(row.merged)) failures.push(`${row.merged} ${kind} apuntan a fichas fusionadas`);
    if (Number(row.crossed)) failures.push(`${row.crossed} ${kind} desplazadas por una fila de otra ficha`);
    if (Number(row.inactive)) warnings.push(`${row.inactive} ${kind} de reglas sobre géneros inactivos (recalcula la taxonomía)`);
    if (Number(row.missing)) warnings.push(`${row.missing} referencias de ${kind} a claims inexistentes`);
  }
  if (getEnv().GENRES_PROJECTION_ENABLED) {
    const { rows } = await pool.query<{ n: string }>(`
      SELECT count(*)::text AS n FROM ingest.album_genres ag
        JOIN ingest.genres g ON g.id = ag.genre_id
        JOIN public.albums a ON a.id = ag.album_id
       WHERE ag.role = 'primary' AND ag.status = 'confirmed' AND a.genre IS DISTINCT FROM g.name`);
    if (Number(rows[0]?.n ?? 0)) failures.push(`${rows[0]!.n} álbumes con albums.genre distinto de su principal confirmado`);
  }
  const detail = [`${total} asignaciones`, ...failures, ...warnings].join("; ");
  return check("genres.assignments", failures.length ? "fail" : warnings.length ? "warn" : "ok", detail);
}

/**
 * Fuentes externas de géneros (PLAN_GENEROS etapa 4): ninguna sugerencia
 * externa se publica sola, las identidades apuntan a fichas vivas y lo que
 * sigue en la cola viene de una fuente que aún está autorizada.
 */
async function checkExternalGenres(pool: Pool): Promise<DoctorCheck> {
  const present = await pool.query<{ ok: boolean }>("SELECT to_regclass('ingest.genre_external_sources') IS NOT NULL AS ok");
  if (!present.rows[0]?.ok) return check("genres.external", "ok", "sin fuentes externas (migración 0031 pendiente)");
  const failures: string[] = [];
  const warnings: string[] = [];
  const { rows } = await pool.query<Record<string, string>>(`
    SELECT (SELECT count(*) FROM ingest.genre_external_sources)::text AS sources,
           (SELECT count(*) FROM ingest.genre_external_sources WHERE import_enabled)::text AS importing,
           (SELECT count(*) FROM (
              SELECT 1 FROM ingest.album_genres WHERE source_kind='external' AND status='confirmed' AND decision_kind='rule'
              UNION ALL
              SELECT 1 FROM ingest.artist_genres WHERE source_kind='external' AND status='confirmed' AND decision_kind='rule') x)::text AS self_confirmed,
           (SELECT count(*) FROM ingest.genre_external_identities i
             WHERE i.entity_kind='artist' AND NOT EXISTS (SELECT 1 FROM public.artists a WHERE a.id = i.entity_id))::text AS orphan_artists,
           (SELECT count(*) FROM ingest.genre_external_identities i
             WHERE i.entity_kind='album' AND NOT EXISTS (SELECT 1 FROM public.albums a WHERE a.id = i.entity_id))::text AS orphan_albums,
           (SELECT count(*) FROM ingest.genre_external_identities i JOIN ingest.entity_redirects r
               ON r.entity_kind::text = i.entity_kind AND r.from_id = i.entity_id)::text AS merged,
           (SELECT count(*) FROM (
              SELECT external_source_id FROM ingest.album_genres WHERE source_kind='external' AND status='suggested'
              UNION ALL
              SELECT external_source_id FROM ingest.artist_genres WHERE source_kind='external' AND status='suggested') x
             JOIN ingest.genre_external_sources s ON s.id = x.external_source_id
            WHERE s.status <> 'authorized')::text AS from_revoked`);
  const row = rows[0]!;
  // Una fuente externa nunca confirma: sus filas son propuestas hasta que una persona decide.
  if (Number(row["self_confirmed"])) failures.push(`${row["self_confirmed"]} asignaciones externas confirmadas sin decisión humana`);
  if (Number(row["orphan_artists"]) + Number(row["orphan_albums"])) {
    failures.push(`${Number(row["orphan_artists"]) + Number(row["orphan_albums"])} identidades externas sobre fichas inexistentes`);
  }
  if (Number(row["merged"])) warnings.push(`${row["merged"]} identidades externas sobre fichas fusionadas`);
  if (Number(row["from_revoked"])) warnings.push(`${row["from_revoked"]} sugerencias vivas de fuentes ya no autorizadas`);
  const detail = [`${row["sources"]} fichas (${row["importing"]} importando)`, ...failures, ...warnings].join("; ");
  return check("genres.external", failures.length ? "fail" : warnings.length ? "warn" : "ok", detail);
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
  checks.push(await checkGenres(pool));
  checks.push(await checkExternalGenres(pool));
  checks.push(await checkChangeJournal(pool));

  return finish();
}
