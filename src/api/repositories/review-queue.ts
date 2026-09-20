// CRV · Lectura paginada de la cola de revisión (PHASES §E7A). Solo lectura:
// aceptar/rechazar/resolver conflicto es E7B (pasa por el merge engine).
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";

export interface ReviewQueueListRow {
  id: number;
  kind: string;
  status: string;
  priority: number;
  notes: string | null;
  createdAt: string;
}

export async function listReviewQueue(
  query: PaginationQuery & { status?: string | undefined; kind?: string | undefined },
): Promise<{ rows: ReviewQueueListRow[]; total: number }> {
  const status = query.status ?? null;
  const kind = query.kind ?? null;
  const [rows, count] = await Promise.all([
    getPool().query<{ id: string; kind: string; status: string; priority: number; notes: string | null; created_at: string }>(
      `SELECT id, kind, status, priority, notes, created_at::text AS created_at
         FROM ingest.review_queue
        WHERE ($1::text IS NULL OR status::text = $1)
          AND ($2::text IS NULL OR kind::text = $2)
        ORDER BY priority DESC, created_at DESC
        LIMIT $3 OFFSET $4`,
      [status, kind, query.limit, query.offset],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM ingest.review_queue
        WHERE ($1::text IS NULL OR status::text = $1)
          AND ($2::text IS NULL OR kind::text = $2)`,
      [status, kind],
    ),
  ]);
  return {
    rows: rows.rows.map((row) => ({
      id: Number(row.id), kind: row.kind, status: row.status, priority: row.priority,
      notes: row.notes, createdAt: row.created_at,
    })),
    total: Number(count.rows[0]?.count ?? 0),
  };
}

export interface ReviewQueueDetail extends ReviewQueueListRow {
  claimAId: number | null;
  claimBId: number | null;
  conflictId: number | null;
  artistAId: number | null;
  artistBId: number | null;
  personAId: number | null;
  personBId: number | null;
  organizationAId: number | null;
  organizationBId: number | null;
  albumId: number | null;
  trackId: number | null;
  videoId: number | null;
  payload: unknown;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolutionNote: string | null;
  claims: ReviewEvidenceClaim[];
}

export interface ReviewEvidenceClaim {
  id: number;
  field: string;
  rawValue: unknown;
  normalizedValue: unknown;
  confidence: string;
  status: string;
  sourceName: string;
  /** Confianza declarada de la fuente (PLAN_CURADURIA E7.1), distinta de `confidence` del claim. */
  sourceTrustLevel: string;
  sourceUrl: string | null;
  evidenceUrl: string | null;
}

function num(value: string | null): number | null {
  return value === null ? null : Number(value);
}

export async function getReviewQueueDetail(id: number): Promise<ReviewQueueDetail | null> {
  const pool = getPool();
  const { rows } = await pool.query<Record<string, string | number | null>>(
    `SELECT id, kind, status, priority, notes, created_at::text AS created_at,
            claim_a_id, claim_b_id, conflict_id,
            artist_a_id, artist_b_id, person_a_id, person_b_id,
            organization_a_id, organization_b_id, album_id, track_id, video_id,
            payload, resolved_at::text AS resolved_at, resolved_by, resolution_note
       FROM ingest.review_queue
      WHERE id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  const claimIds = [num(row["claim_a_id"] as string | null), num(row["claim_b_id"] as string | null)]
    .filter((claimId): claimId is number => claimId !== null);
  const evidence = claimIds.length === 0 ? { rows: [] } : await pool.query<{
    id: string; field: string; raw_value: unknown; normalized_value: unknown; confidence: string; status: string;
    source_name: string; source_trust_level: string; source_url: string | null; evidence_url: string | null;
  }>(
    `SELECT c.id::text, c.field, c.raw_value, c.normalized_value, c.confidence::text, c.status::text,
            s.name AS source_name, s.trust_level::text AS source_trust_level, s.url AS source_url, COALESCE(rp.canonical_url, rp.url) AS evidence_url
       FROM ingest.claims c
       JOIN ingest.sources s ON s.id = c.source_id
       LEFT JOIN ingest.raw_pages rp ON rp.id = c.raw_page_id
      WHERE c.id = ANY($1::bigint[])
      ORDER BY array_position($1::bigint[], c.id)`,
    [claimIds],
  );
  return {
    id: Number(row["id"]), kind: row["kind"] as string, status: row["status"] as string,
    priority: Number(row["priority"]), notes: row["notes"] as string | null, createdAt: row["created_at"] as string,
    claimAId: num(row["claim_a_id"] as string | null), claimBId: num(row["claim_b_id"] as string | null),
    conflictId: num(row["conflict_id"] as string | null),
    artistAId: num(row["artist_a_id"] as string | null), artistBId: num(row["artist_b_id"] as string | null),
    personAId: num(row["person_a_id"] as string | null), personBId: num(row["person_b_id"] as string | null),
    organizationAId: num(row["organization_a_id"] as string | null), organizationBId: num(row["organization_b_id"] as string | null),
    albumId: num(row["album_id"] as string | null), trackId: num(row["track_id"] as string | null),
    videoId: num(row["video_id"] as string | null),
    payload: row["payload"],
    resolvedAt: row["resolved_at"] as string | null, resolvedBy: row["resolved_by"] as string | null,
    resolutionNote: row["resolution_note"] as string | null,
    claims: evidence.rows.map((claim) => ({
      id: Number(claim.id), field: claim.field, rawValue: claim.raw_value, normalizedValue: claim.normalized_value,
      confidence: claim.confidence, status: claim.status, sourceName: claim.source_name, sourceTrustLevel: claim.source_trust_level,
      sourceUrl: claim.source_url, evidenceUrl: claim.evidence_url,
    })),
  };
}
