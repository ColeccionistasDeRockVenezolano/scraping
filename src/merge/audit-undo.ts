// CRV · Deshacer un cambio suelto del historial de una ficha.
//
// Lo anterior al diario (22-09-2026) no se deshace run por run —un run de
// entonces podía fusionar 177 personas de una vez—, sino decisión por
// decisión: una fusión (`merged_duplicate`) o una conversión
// (`absorbed_person`) de `ingest.merge_audit`.
//
// La vista previa no adivina: hace el deshacer de verdad dentro de un
// SAVEPOINT y lo deshace, así que lo que dice es exactamente lo que pasaría.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { undoAbsorption, type AbsorptionUndoResult } from "./absorption-undo.js";
import { OperatorError, type OperatorContext } from "./operator.js";
import { undoMergeAudit } from "./unmerge.js";

export type UndoableAuditKind = "merge" | "absorption";

export interface AuditEntry {
  auditId: number;
  runId: number | null;
  kind: UndoableAuditKind;
  entityKind: string;
  field: string;
  reason: string;
  at: string;
  /** Qué vuelve al catálogo: la ficha que la fusión borró o la persona absorbida. */
  restores: { kind: string; id: number; label: string | null };
  /** Auditoría del deshacer, si ya se deshizo. */
  undoneByAuditId: number | null;
  undoneByRunId: number | null;
}

interface Row {
  id: string;
  run_id: string | null;
  entity_kind: string;
  field: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  reason: string;
  at: string;
  undone_audit_id: string | null;
  undone_run_id: string | null;
}

/** Un cambio del historial que se puede deshacer por sí solo, o null. */
export async function loadAuditEntry(client: Pick<PoolClient, "query">, auditId: number): Promise<AuditEntry | null> {
  const { rows } = await client.query<Row>(`
    SELECT a.id::text, a.run_id::text, a.entity_kind::text AS entity_kind, a.field, a.old_value, a.new_value,
           a.reason, a.at::text, u.id::text AS undone_audit_id, u.run_id::text AS undone_run_id
      FROM ingest.merge_audit a
      LEFT JOIN LATERAL (
        SELECT id, run_id FROM ingest.merge_audit u
         WHERE u.field IN ('unmerged_duplicate','unabsorbed_person')
           AND u.old_value->>'undoneAuditId' = a.id::text
         ORDER BY id DESC LIMIT 1) u ON true
     WHERE a.id=$1 AND a.field IN ('merged_duplicate','absorbed_person')`, [auditId]);
  const row = rows[0];
  if (!row) return null;
  const kind: UndoableAuditKind = row.field === "merged_duplicate" ? "merge" : "absorption";
  const restored = kind === "merge" ? row.old_value : (row.old_value?.["person"] as Record<string, unknown> | undefined) ?? null;
  return {
    auditId: Number(row.id),
    runId: row.run_id === null ? null : Number(row.run_id),
    kind,
    entityKind: row.entity_kind,
    field: row.field,
    reason: row.reason,
    at: row.at,
    restores: {
      kind: kind === "merge" ? row.entity_kind : "person",
      id: Number(restored?.["id"] ?? 0),
      label: (restored?.["name"] ?? restored?.["title"] ?? null) as string | null,
    },
    undoneByAuditId: row.undone_audit_id === null ? null : Number(row.undone_audit_id),
    undoneByRunId: row.undone_run_id === null ? null : Number(row.undone_run_id),
  };
}

export interface AuditUndoResult {
  auditId: number;
  kind: UndoableAuditKind;
  restored: { kind: string; id: number };
  absorption?: AbsorptionUndoResult;
}

/** Deshace la entrada dentro de la transacción del operador. */
export async function undoAuditEntry(context: OperatorContext, auditId: number): Promise<AuditUndoResult> {
  const client = context.client;
  const entry = await loadAuditEntry(client, auditId);
  if (!entry) {
    throw new OperatorError("not_found", `el cambio #${auditId} del historial no existe o no se deshace por separado`, { auditId });
  }
  if (entry.undoneByAuditId !== null) {
    throw new OperatorError("not_open",
      `ese cambio ya se deshizo (cambio #${entry.undoneByRunId ?? "?"}); para volver a aplicarlo, deshaz ese`,
      { auditId, undoneByRunId: entry.undoneByRunId });
  }
  if (entry.kind === "merge") {
    const restored = await undoMergeAudit(context, auditId);
    return { auditId, kind: "merge", restored };
  }
  const absorption = await undoAbsorption(context, auditId);
  return { auditId, kind: "absorption", restored: { kind: "person", id: absorption.personId }, absorption };
}

export interface AuditUndoPreview extends AuditEntry {
  undoable: boolean;
  reason_not: string | null;
  result: AuditUndoResult | null;
}

/**
 * Qué pasaría al deshacer, sin dejar rastro: el deshacer se ejecuta de verdad
 * dentro de una transacción que SIEMPRE vuelve atrás. Así la vista previa no
 * repite las comprobaciones (ni se queda corta).
 */
export async function previewAuditUndo(auditId: number): Promise<AuditUndoPreview | null> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const entry = await loadAuditEntry(client, auditId);
    if (!entry) return null;
    if (entry.undoneByAuditId !== null) {
      return { ...entry, undoable: false, result: null,
        reason_not: `ya se deshizo (cambio #${entry.undoneByRunId ?? "?"}); para volver a aplicarlo, deshaz ese` };
    }
    // Un run de mentira, que se va con el ROLLBACK igual que todo lo demás.
    const source = await client.query<{ id: string }>(
      "SELECT id::text FROM ingest.sources ORDER BY id LIMIT 1");
    const sourceId = Number(source.rows[0]?.id ?? 0);
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind,source_id,status,params)
      VALUES ('manual',$1,'running','{"action":"preview:undo:audit"}'::jsonb) RETURNING id::text`, [sourceId || null]);
    const context: OperatorContext = {
      client, runId: Number(run.rows[0]!.id), sourceId, operator: "vista previa", note: "vista previa",
    };
    try {
      const result = await undoAuditEntry(context, auditId);
      return { ...entry, undoable: true, reason_not: null, result };
    } catch (error) {
      if (error instanceof OperatorError) return { ...entry, undoable: false, reason_not: error.message, result: null };
      throw error;
    }
  } finally {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
  }
}
