// CRV · Rastro reconstruido de las fusiones anteriores a E11.1 (2026-09-15).
//
// Una fusión de entonces guardaba la fila que borró y CUÁNTAS filas movió,
// pero no cuáles: `undoMergeRun` no puede devolverlas sin saberlo. Aquí se
// reconstruye esa lista desde una instantánea anterior al run (un respaldo de
// `scripts/db-backup.sh` restaurado en una base desechable) y se guarda en
// `ingest.merge_traces` (migración 0030).
//
// SOLO SE DESHACE LO VERIFICADO. La reconstrucción se compara con el número
// que la propia fusión registró: si no cuadra exactamente, el rastro se
// guarda como NO verificado y la fusión sigue siendo no reversible, diciendo
// por qué. Una instantánea anterior al run no ve las filas que nacieron entre
// ella y la fusión; cuando eso pasa, los números no cuadran y se dice.
import type { PoolClient } from "pg";
import { MERGE_TABLES, type MergeKind, type MovedRef } from "../review/duplicates.js";

/** Fusión con la auditoría vieja (sin `movedRefs`). */
export interface LegacyMerge {
  auditId: number;
  runId: number;
  kind: MergeKind;
  keepId: number;
  dropId: number;
  /** Filas que la fusión dijo haber movido. */
  moved: number;
  discarded: number;
  filled: string[];
  tracksMerged: number;
  dropRow: Record<string, unknown>;
  at: string;
}

export interface MergeTrace {
  auditId: number;
  movedRefs: MovedRef[];
  source: "backup" | "audit";
  sourceLabel: string | null;
  expected: number;
  found: number;
  verified: boolean;
  reason: string | null;
}

interface AuditRow {
  id: string;
  run_id: string;
  entity_kind: MergeKind;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  at: string;
}

const isLegacy = (value: Record<string, unknown> | null): boolean =>
  !value || String(value["version"] ?? "") !== "2";

/**
 * Fusiones de auditoría vieja, de la más antigua a la más reciente (el orden
 * en que ocurrieron). Sin `runId`, las de toda la base.
 */
export async function listLegacyMerges(
  client: Pick<PoolClient, "query">, options: { runId?: number; auditId?: number } = {},
): Promise<LegacyMerge[]> {
  const where = ["field='merged_duplicate'"];
  const params: unknown[] = [];
  if (options.runId !== undefined) { params.push(options.runId); where.push(`run_id=$${params.length}`); }
  if (options.auditId !== undefined) { params.push(options.auditId); where.push(`id=$${params.length}`); }
  const { rows } = await client.query<AuditRow>(`
    SELECT id::text, run_id::text, entity_kind::text AS entity_kind, old_value, new_value, at::text
      FROM ingest.merge_audit WHERE ${where.join(" AND ")} ORDER BY id`, params);
  return rows.filter((row) => isLegacy(row.new_value) && row.old_value).map((row) => ({
    auditId: Number(row.id),
    runId: Number(row.run_id),
    kind: row.entity_kind,
    keepId: Number(row.new_value?.["keptId"] ?? 0),
    dropId: Number(row.old_value?.["id"] ?? 0),
    moved: Number(row.new_value?.["moved"] ?? 0),
    discarded: Number(row.new_value?.["discarded"] ?? 0),
    filled: Array.isArray(row.new_value?.["filled"]) ? row.new_value["filled"] as string[] : [],
    tracksMerged: Number(row.new_value?.["tracksMerged"] ?? 0),
    dropRow: row.old_value!,
    at: row.at,
  }));
}

/** Columnas que apuntan a la tabla de un tipo de ficha, tal como estaban en la instantánea. */
async function referencingColumns(
  queryable: Pick<PoolClient, "query">, kind: MergeKind,
): Promise<Array<{ table: string; column: string }>> {
  const { rows } = await queryable.query<{ table: string; column: string }>(`
    SELECT c.conrelid::regclass::text AS table, a.attname AS column
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
     WHERE c.contype='f' AND c.confrelid=$1::regclass
     ORDER BY 1,2`, [`public.${MERGE_TABLES[kind]}`]);
  return rows;
}

async function primaryKeyColumns(queryable: Pick<PoolClient, "query">, table: string): Promise<string[]> {
  const { rows } = await queryable.query<{ column: string }>(`
    SELECT a.attname AS column
      FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
     WHERE i.indrelid=$1::regclass AND i.indisprimary
     ORDER BY a.attnum`, [table]);
  return rows.map((row) => row.column);
}

const keyExpression = (columns: string[]): string =>
  `jsonb_build_object(${columns.map((column) => `'${column}', ${column}`).join(", ")})`;

/**
 * Reconstruye, desde la instantánea, qué filas apuntaban al duplicado justo
 * antes de la fusión. Las tablas que la instantánea no tenía (migraciones
 * posteriores) no pueden aportar filas: si la fusión movió alguna de ellas,
 * los números no cuadran y el rastro queda sin verificar.
 */
export async function buildTraceFromSnapshot(
  current: Pick<PoolClient, "query">, snapshot: Pick<PoolClient, "query">, merge: LegacyMerge, label: string,
): Promise<MergeTrace> {
  const refs = await referencingColumns(snapshot, merge.kind);
  const nowRefs = new Set((await referencingColumns(current, merge.kind)).map((ref) => `${ref.table}.${ref.column}`));
  const movedRefs: MovedRef[] = [];
  const missingTables: string[] = [];
  let found = 0;
  for (const ref of refs) {
    if (!nowRefs.has(`${ref.table}.${ref.column}`)) { missingTables.push(`${ref.table}.${ref.column}`); continue; }
    const pk = await primaryKeyColumns(snapshot, ref.table);
    if (pk.length === 0) { missingTables.push(`${ref.table} (sin clave primaria)`); continue; }
    const { rows } = await snapshot.query<{ key: Record<string, unknown> }>(
      `SELECT ${keyExpression(pk)} AS key FROM ${ref.table} WHERE ${ref.column}=$1 ORDER BY 1`, [merge.dropId]);
    if (rows.length === 0) continue;
    movedRefs.push({ table: ref.table, column: ref.column, keys: rows.map((row) => row.key) });
    found += rows.length;
  }
  const verified = found === merge.moved && merge.discarded === 0;
  const reason = verified ? null : reasonFor(merge, found, missingTables);
  return { auditId: merge.auditId, movedRefs, source: "backup", sourceLabel: label, expected: merge.moved, found, verified, reason };
}

function reasonFor(merge: LegacyMerge, found: number, missingTables: string[]): string {
  if (merge.discarded > 0) {
    return `la fusión descartó ${merge.discarded} fila(s) sin guardar copia: no se puede devolver lo que no quedó registrado`;
  }
  const detail = missingTables.length ? ` (la instantánea no tenía ${missingTables.join(", ")})` : "";
  return found < merge.moved
    ? `la instantánea explica ${found} de las ${merge.moved} filas que movió: faltan ${merge.moved - found}, probablemente creadas entre la instantánea y el cambio${detail}`
    : `la instantánea da ${found} filas y la fusión registró ${merge.moved}: no cuadra${detail}`;
}

export async function saveTrace(client: Pick<PoolClient, "query">, merge: LegacyMerge, trace: MergeTrace): Promise<void> {
  await client.query(`
    INSERT INTO ingest.merge_traces(audit_id, run_id, moved_refs, source, source_label, moved_expected, moved_found, verified, reason)
    VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (audit_id) DO UPDATE SET
      moved_refs=EXCLUDED.moved_refs, source=EXCLUDED.source, source_label=EXCLUDED.source_label,
      moved_expected=EXCLUDED.moved_expected, moved_found=EXCLUDED.moved_found,
      verified=EXCLUDED.verified, reason=EXCLUDED.reason, built_at=now()`,
  [merge.auditId, merge.runId, JSON.stringify(trace.movedRefs), trace.source, trace.sourceLabel,
    trace.expected, trace.found, trace.verified, trace.reason]);
}

/** Rastro verificado de una fusión vieja, o null si no lo hay (o no cuadró). */
export async function loadVerifiedTrace(client: Pick<PoolClient, "query">, auditId: number): Promise<MergeTrace | null> {
  const { rows } = await client.query<{
    moved_refs: MovedRef[]; source: "backup" | "audit"; source_label: string | null;
    moved_expected: number; moved_found: number; verified: boolean; reason: string | null;
  }>("SELECT moved_refs, source, source_label, moved_expected, moved_found, verified, reason FROM ingest.merge_traces WHERE audit_id=$1", [auditId]);
  const row = rows[0];
  if (!row || !row.verified) return null;
  return {
    auditId, movedRefs: row.moved_refs, source: row.source, sourceLabel: row.source_label,
    expected: row.moved_expected, found: row.moved_found, verified: true, reason: row.reason,
  };
}

/** Por qué una fusión vieja no se puede deshacer todavía (para decirlo en la vista previa). */
export async function traceReason(client: Pick<PoolClient, "query">, auditId: number): Promise<string> {
  const { rows } = await client.query<{ verified: boolean; reason: string | null }>(
    "SELECT verified, reason FROM ingest.merge_traces WHERE audit_id=$1", [auditId]);
  const row = rows[0];
  if (!row) {
    return "fusión anterior a E11.1 (15-09-2026): su auditoría no guardó qué filas movió y no hay rastro reconstruido "
      + "(`crv merges rebuild-traces --snapshot=<respaldo anterior>`)";
  }
  return row.reason ?? "rastro reconstruido sin verificar";
}

export interface RebuildSummary {
  merges: number;
  verified: number;
  unverified: Array<{ auditId: number; runId: number; kind: string; keepId: number; dropId: number; reason: string }>;
}

/** Reconstruye y guarda el rastro de todas las fusiones viejas que pide el filtro. */
export async function rebuildTraces(
  current: PoolClient, snapshot: Pick<PoolClient, "query">, label: string, filter: { runId?: number } = {},
): Promise<RebuildSummary> {
  const merges = await listLegacyMerges(current, filter);
  const summary: RebuildSummary = { merges: merges.length, verified: 0, unverified: [] };
  for (const merge of merges) {
    const trace = await buildTraceFromSnapshot(current, snapshot, merge, label);
    await saveTrace(current, merge, trace);
    if (trace.verified) summary.verified += 1;
    else {
      summary.unverified.push({
        auditId: merge.auditId, runId: merge.runId, kind: merge.kind, keepId: merge.keepId, dropId: merge.dropId,
        reason: trace.reason ?? "sin verificar",
      });
    }
  }
  return summary;
}
