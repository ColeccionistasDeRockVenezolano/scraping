// CRV · Lectura de claims (PHASES §E7A: "lectura de fuentes, claims...").
// La tabla es grande (cientos de miles de filas, ver PHASES "Cierre F2–F5"):
// exigimos siempre un filtro por entidad, nunca un listado sin acotar.
import { getPool } from "../../db/client.js";
import { badRequest } from "../http-errors.js";
import type { PaginationQuery } from "../pagination.js";

const ENTITY_COLUMNS = {
  artist: "artist_id", person: "person_id", organization: "organization_id",
  album: "album_id", track: "track_id",
} as const;

export type ClaimEntityFilter = keyof typeof ENTITY_COLUMNS;

export interface ClaimRow {
  id: number;
  entityKind: string;
  field: string;
  rawValue: unknown;
  normalizedValue: unknown;
  confidence: string;
  status: string;
  sourceId: number;
  sourceName: string;
  createdAt: string;
}

export async function listClaimsForEntity(
  entity: ClaimEntityFilter, entityId: number, query: PaginationQuery,
): Promise<{ rows: ClaimRow[]; total: number }> {
  const column = ENTITY_COLUMNS[entity];
  if (!column) throw badRequest(`entidad de claim desconocida: ${entity}`);
  const [rows, count] = await Promise.all([
    getPool().query<{
      id: string; entity_kind: string; field: string; raw_value: unknown; normalized_value: unknown;
      confidence: string; status: string; source_id: string; source_name: string; created_at: string;
    }>(
      `SELECT c.id, c.entity_kind, c.field, c.raw_value, c.normalized_value, c.confidence, c.status,
              c.source_id, s.name AS source_name, c.created_at::text AS created_at
         FROM ingest.claims c
         JOIN ingest.sources s ON s.id = c.source_id
        WHERE c.${column} = $1
        ORDER BY c.created_at DESC
        LIMIT $2 OFFSET $3`,
      [entityId, query.limit, query.offset],
    ),
    getPool().query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ingest.claims WHERE ${column} = $1`,
      [entityId],
    ),
  ]);
  return {
    rows: rows.rows.map((row) => ({
      id: Number(row.id), entityKind: row.entity_kind, field: row.field,
      rawValue: row.raw_value, normalizedValue: row.normalized_value,
      confidence: row.confidence, status: row.status,
      sourceId: Number(row.source_id), sourceName: row.source_name, createdAt: row.created_at,
    })),
    total: Number(count.rows[0]?.count ?? 0),
  };
}
