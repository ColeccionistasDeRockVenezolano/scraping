// CRV · Historial de cambios del core (PHASES §E7B: "audit trail"). Lectura
// de ingest.merge_audit por entidad y de los runs que agrupan cada edición.
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";

export const AUDIT_COLUMN = {
  artist: "artist_id", person: "person_id", organization: "organization_id", album: "album_id", track: "track_id",
  artist_membership: "artist_membership_id", person_organization: "person_organization_id",
  album_credit: "album_credit_id", track_credit: "track_credit_id", album_format: "album_format_id",
} as const;

export type AuditEntity = keyof typeof AUDIT_COLUMN;

export interface AuditRow {
  id: number;
  runId: number | null;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
  confidence: string;
  performedBy: string;
  at: string;
  claimIds: number[];
}

export async function listAudit(entity: AuditEntity, id: number, page: PaginationQuery): Promise<{ rows: AuditRow[]; total: number }> {
  const column = AUDIT_COLUMN[entity];
  const [rows, count] = await Promise.all([
    getPool().query<{
      id: string; run_id: string | null; field: string; old_value: unknown; new_value: unknown; reason: string;
      confidence: string; performed_by: string; at: string; claim_ids: string[];
    }>(`
      SELECT ma.id::text, ma.run_id::text, ma.field, ma.old_value, ma.new_value, ma.reason,
             ma.confidence::text, ma.performed_by::text, ma.at::text,
             ARRAY(SELECT mac.claim_id::text FROM ingest.merge_audit_claims mac WHERE mac.merge_audit_id=ma.id ORDER BY mac.claim_id) AS claim_ids
        FROM ingest.merge_audit ma
       WHERE ma.${column}=$1
       ORDER BY ma.at DESC, ma.id DESC
       LIMIT $2 OFFSET $3`, [id, page.limit, page.offset]),
    getPool().query<{ count: string }>(`SELECT count(*)::text AS count FROM ingest.merge_audit WHERE ${column}=$1`, [id]),
  ]);
  return {
    rows: rows.rows.map((row) => ({
      id: Number(row.id), runId: row.run_id === null ? null : Number(row.run_id), field: row.field,
      oldValue: row.old_value, newValue: row.new_value, reason: row.reason, confidence: row.confidence,
      performedBy: row.performed_by, at: row.at, claimIds: row.claim_ids.map(Number),
    })),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export interface RunDetail {
  id: number;
  kind: string;
  status: string;
  sourceId: number | null;
  startedAt: string;
  finishedAt: string | null;
  params: unknown;
  counters: unknown;
  errorLog: string | null;
}

export async function getRun(id: number): Promise<RunDetail | null> {
  const { rows } = await getPool().query<{
    id: string; kind: string; status: string; source_id: string | null; started_at: string; finished_at: string | null;
    params: unknown; counters: unknown; error_log: string | null;
  }>(`
    SELECT id::text, kind::text, status::text, source_id::text, started_at::text, finished_at::text, params, counters, error_log
      FROM ingest.scrape_runs WHERE id=$1`, [id]);
  const row = rows[0];
  if (!row) return null;
  return {
    id: Number(row.id), kind: row.kind, status: row.status, sourceId: row.source_id === null ? null : Number(row.source_id),
    startedAt: row.started_at, finishedAt: row.finished_at, params: row.params, counters: row.counters, errorLog: row.error_log,
  };
}
