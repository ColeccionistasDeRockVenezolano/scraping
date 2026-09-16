// CRV · Retención del detector de Curaduría (PLAN_CURADURIA E1, A9).
//
// Cada escritura de la API dispara un análisis, así que `curation_scans` y los
// hallazgos `resolved` crecen sin techo. Se conservan los últimos 500 análisis
// y los resueltos de los últimos 180 días. Lo abierto y lo ignorado nunca se
// poda: es trabajo pendiente o una decisión humana.
//
// Borrar toma el mismo candado que el análisis: un análisis que reabre un
// resuelto mientras la poda lo borra contaría mal lo nuevo y lo reabierto.
import { getPool } from "../db/client.js";
import { CURATION_SCAN_LOCK } from "./scan.js";

export const KEEP_SCANS = 500;
export const KEEP_RESOLVED_DAYS = 180;

export interface PruneOptions {
  dryRun: boolean;
  keepScans?: number;
  resolvedDays?: number;
}

export interface PruneResult {
  dryRun: boolean;
  /** skipped = otro proceso estaba analizando; no se borró nada. */
  status: "ok" | "skipped";
  keepScans: number;
  resolvedDays: number;
  scans: number;
  resolvedFindings: number;
}

const OLD_SCANS = "id < (SELECT min(id) FROM (SELECT id FROM ingest.curation_scans ORDER BY id DESC LIMIT $1) kept)";
const OLD_RESOLVED = "status = 'resolved' AND resolved_at < now() - make_interval(days => $1::int)";

export async function pruneCuration(options: PruneOptions): Promise<PruneResult> {
  const keepScans = Math.max(1, options.keepScans ?? KEEP_SCANS);
  const resolvedDays = Math.max(0, options.resolvedDays ?? KEEP_RESOLVED_DAYS);
  const base = { dryRun: options.dryRun, keepScans, resolvedDays };
  const client = await getPool().connect();
  let locked = false;
  try {
    if (options.dryRun) {
      const findings = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ingest.curation_findings WHERE ${OLD_RESOLVED}`, [resolvedDays]);
      const scans = await client.query<{ n: string }>(`SELECT count(*)::text AS n FROM ingest.curation_scans WHERE ${OLD_SCANS}`, [keepScans]);
      return { ...base, status: "ok", scans: Number(scans.rows[0]?.n ?? 0), resolvedFindings: Number(findings.rows[0]?.n ?? 0) };
    }
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [CURATION_SCAN_LOCK]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { ...base, status: "skipped", scans: 0, resolvedFindings: 0 };
    await client.query("BEGIN");
    try {
      // Primero los hallazgos: así borrar análisis no reescribe filas que igual se van.
      const findings = await client.query(`DELETE FROM ingest.curation_findings WHERE ${OLD_RESOLVED}`, [resolvedDays]);
      const scans = await client.query(`DELETE FROM ingest.curation_scans WHERE ${OLD_SCANS}`, [keepScans]);
      await client.query("COMMIT");
      return { ...base, status: "ok", scans: scans.rowCount ?? 0, resolvedFindings: findings.rowCount ?? 0 };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    }
  } finally {
    let reusable = true;
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [CURATION_SCAN_LOCK]).catch(() => { reusable = false; });
    client.release(!reusable);
  }
}
