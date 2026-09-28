// CRV · Historial de cambios del catálogo (migración 0028): cada run con lo
// que tocó según el diario, quién lo pidió, por qué, y si está deshecho.
// Es la lectura que alimenta la página «Historial», la barra de «Deshacer»
// tras cada cambio y la sección de cambios de cada ficha.
import { getPool } from "../../db/client.js";
import type { PaginationQuery } from "../pagination.js";
import { activeUndoOf } from "../../merge/run-undo.js";

export const CHANGE_ENTITY_TABLES = {
  artist: "public.artists", person: "public.persons", organization: "public.organizations",
  album: "public.albums", track: "public.tracks",
} as const;
export type ChangeEntityKind = keyof typeof CHANGE_ENTITY_TABLES;
const KIND_OF_TABLE = new Map<string, ChangeEntityKind>(Object.entries(CHANGE_ENTITY_TABLES).map(([kind, table]) => [table, kind as ChangeEntityKind]));

/** Qué le pasó a una ficha en un run. */
export type EntityChangeOp = "created" | "removed" | "changed";

export interface ChangeEntity {
  kind: ChangeEntityKind;
  id: number;
  label: string | null;
  op: EntityChangeOp;
}

export interface ChangeSummary {
  runId: number;
  kind: string;
  status: string;
  action: string | null;
  operator: string | null;
  note: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** El diario tiene sus cambios (runs desde la migración 0028). */
  journaled: boolean;
  /** Filas cambiadas, por tabla y operación (I/U/D). */
  counts: Record<string, { created: number; changed: number; removed: number }>;
  total: number;
  /** Fichas del catálogo tocadas (hasta 8) y cuántas en total. */
  entities: ChangeEntity[];
  entityTotal: number;
  /** Run que lo tiene deshecho ahora mismo. */
  undoneBy: number | null;
  /** Si este run es un deshacer: el run que deshizo. */
  undoOf: number | null;
  /** Si deshizo un deshacer (rehacer): el run que vuelve a quedar aplicado. */
  redoOf: number | null;
}

interface RunRow {
  id: string;
  kind: string;
  status: string;
  params: Record<string, unknown> | null;
  started_at: string;
  finished_at: string | null;
}

const ENTITY_LIMIT = 8;
const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value : null);

async function summarize(runs: RunRow[]): Promise<ChangeSummary[]> {
  if (runs.length === 0) return [];
  const ids = runs.map((run) => Number(run.id));
  const pool = getPool();
  const [counts, entityRows, undos, entityCounts] = await Promise.all([
    pool.query<{ run_id: string; table_name: string; op: "I" | "U" | "D"; n: string }>(`
      SELECT run_id::text, table_name, op, count(*)::text AS n
        FROM ingest.change_journal WHERE run_id = ANY($1::bigint[])
       GROUP BY 1, 2, 3`, [ids]),
    // Por run, las filas de fichas en orden; basta con las primeras para
    // nombrar lo tocado (el total sale del recuento de arriba).
    pool.query<{ run_id: string; table_name: string; op: "I" | "U" | "D"; entity_id: string; label: string | null }>(`
      SELECT r.id::text AS run_id, j.table_name, j.op, j.row_pk->>'id' AS entity_id,
             COALESCE(j.new_data->>'name', j.new_data->>'title', j.old_data->>'name', j.old_data->>'title') AS label
        FROM unnest($1::bigint[]) AS r(id)
        CROSS JOIN LATERAL (
          SELECT table_name, op, row_pk, new_data, old_data FROM ingest.change_journal
           WHERE run_id = r.id AND table_name = ANY($2::text[])
           ORDER BY id LIMIT 400) j`, [ids, Object.values(CHANGE_ENTITY_TABLES)]),
    pool.query<{ run_id: string; undo_run_id: string }>(`
      SELECT run_id::text, undo_run_id::text FROM ingest.run_undos
       WHERE run_id = ANY($1::bigint[]) OR undo_run_id = ANY($1::bigint[])`, [ids]),
    pool.query<{ run_id: string; n: string }>(`
      SELECT run_id::text, count(DISTINCT (table_name, row_pk))::text AS n
        FROM ingest.change_journal WHERE run_id = ANY($1::bigint[]) AND table_name = ANY($2::text[])
       GROUP BY 1`, [ids, Object.values(CHANGE_ENTITY_TABLES)]),
  ]);
  const distinctEntities = new Map(entityCounts.rows.map((row) => [row.run_id, Number(row.n)]));

  // Nombres actuales para las fichas cuyo cambio no trae nombre (una edición de otro campo).
  const unnamed = new Map<ChangeEntityKind, Set<number>>();
  for (const row of entityRows.rows) {
    const kind = KIND_OF_TABLE.get(row.table_name);
    if (kind && !row.label) unnamed.set(kind, (unnamed.get(kind) ?? new Set()).add(Number(row.entity_id)));
  }
  const names = new Map<string, string>();
  await Promise.all([...unnamed].map(async ([kind, set]) => {
    const column = kind === "album" || kind === "track" ? "title" : "name";
    const { rows } = await pool.query<{ id: string; label: string }>(
      `SELECT id::text, ${column} AS label FROM ${CHANGE_ENTITY_TABLES[kind]} WHERE id = ANY($1::bigint[])`, [[...set]]);
    for (const row of rows) names.set(`${kind}:${row.id}`, row.label);
  }));

  const undoOf = new Map(undos.rows.map((row) => [row.undo_run_id, Number(row.run_id)]));
  // Deshacer un deshacer es rehacer el run original.
  const redoOf = new Map<number, number>();
  if (undoOf.size) {
    const { rows } = await pool.query<{ run_id: string; undo_run_id: string }>(
      "SELECT run_id::text, undo_run_id::text FROM ingest.run_undos WHERE undo_run_id = ANY($1::bigint[])", [[...undoOf.values()]]);
    const original = new Map(rows.map((row) => [Number(row.undo_run_id), Number(row.run_id)]));
    for (const [id, target] of undoOf) if (original.has(target)) redoOf.set(Number(id), original.get(target)!);
  }
  const undoneBy = new Map<number, number | null>();
  await Promise.all(ids.map(async (id) => {
    if (undos.rows.some((row) => Number(row.run_id) === id)) undoneBy.set(id, await activeUndoOf(pool, id));
  }));

  return runs.map((run) => {
    const id = Number(run.id);
    const params = run.params ?? {};
    const tableCounts: ChangeSummary["counts"] = {};
    let total = 0;
    for (const row of counts.rows.filter((item) => item.run_id === run.id)) {
      const entry = tableCounts[row.table_name] ?? { created: 0, changed: 0, removed: 0 };
      const n = Number(row.n);
      if (row.op === "I") entry.created += n; else if (row.op === "U") entry.changed += n; else entry.removed += n;
      tableCounts[row.table_name] = entry;
      total += n;
    }
    const byEntity = new Map<string, ChangeEntity & { first: "I" | "U" | "D"; last: "I" | "U" | "D" }>();
    for (const row of entityRows.rows.filter((item) => item.run_id === run.id)) {
      const kind = KIND_OF_TABLE.get(row.table_name)!;
      const key = `${kind}:${row.entity_id}`;
      const existing = byEntity.get(key);
      const label = row.label ?? names.get(key) ?? null;
      if (existing) {
        existing.last = row.op;
        existing.label ??= label;
      } else {
        byEntity.set(key, { kind, id: Number(row.entity_id), label, op: "changed", first: row.op, last: row.op });
      }
    }
    const entities = [...byEntity.values()]
      .map(({ first, last, ...entity }) => ({
        ...entity,
        op: (first === "I" && last !== "D" ? "created" : last === "D" && first !== "I" ? "removed" : "changed") as EntityChangeOp,
      }));
    const entityTotal = distinctEntities.get(run.id) ?? 0;
    return {
      runId: id,
      kind: run.kind,
      status: run.status,
      action: text(params["action"]),
      operator: text(params["operator"]),
      note: text(params["note"]),
      startedAt: run.started_at,
      finishedAt: run.finished_at,
      journaled: total > 0,
      counts: tableCounts,
      total,
      entities: entities.slice(0, ENTITY_LIMIT),
      entityTotal: Math.max(entityTotal, entities.length),
      undoneBy: undoneBy.get(id) ?? null,
      undoOf: undoOf.get(run.id) ?? null,
      redoOf: redoOf.get(id) ?? null,
    };
  });
}

export interface ChangeFilter extends PaginationQuery {
  entity?: ChangeEntityKind | undefined;
  id?: number | undefined;
  /** Solo runs con diario (los que se pueden deshacer con él). */
  journaled?: boolean | undefined;
}

export async function listChanges(filter: ChangeFilter): Promise<{ rows: ChangeSummary[]; total: number }> {
  const where: string[] = [];
  const params: unknown[] = [];
  if (filter.entity && filter.id !== undefined) {
    // Una ficha: runs que la tocaron según el diario o, antes de él, según su auditoría.
    params.push(CHANGE_ENTITY_TABLES[filter.entity], JSON.stringify({ id: filter.id }), filter.id);
    where.push(`(r.id IN (SELECT run_id FROM ingest.change_journal WHERE table_name=$1 AND row_pk=$2::jsonb AND run_id IS NOT NULL)
              OR r.id IN (SELECT run_id FROM ingest.merge_audit WHERE ${filter.entity}_id=$3 AND run_id IS NOT NULL))`);
  }
  if (filter.journaled) where.push("EXISTS (SELECT 1 FROM ingest.change_journal j WHERE j.run_id=r.id)");
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const pool = getPool();
  const [rows, count] = await Promise.all([
    pool.query<RunRow>(`
      SELECT r.id::text, r.kind::text, r.status::text, r.params, r.started_at::text, r.finished_at::text
        FROM ingest.scrape_runs r ${clause}
       ORDER BY r.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, filter.limit, filter.offset]),
    pool.query<{ n: string }>(`SELECT count(*)::text AS n FROM ingest.scrape_runs r ${clause}`, params),
  ]);
  return { rows: await summarize(rows.rows), total: Number(count.rows[0]?.n ?? 0) };
}

export async function getChange(runId: number): Promise<ChangeSummary | null> {
  const { rows } = await getPool().query<RunRow>(`
    SELECT id::text, kind::text, status::text, params, started_at::text, finished_at::text
      FROM ingest.scrape_runs WHERE id=$1`, [runId]);
  return (await summarize(rows))[0] ?? null;
}

/** Run que retiró la ficha (la última baja del diario), para ofrecer deshacer el retiro desde su 404. */
export async function removedBy(kind: ChangeEntityKind, id: number): Promise<number | null> {
  const { rows } = await getPool().query<{ run_id: string | null }>(`
    SELECT run_id::text FROM ingest.change_journal
     WHERE table_name=$1 AND row_pk=$2::jsonb AND op='D'
     ORDER BY id DESC LIMIT 1`, [CHANGE_ENTITY_TABLES[kind], JSON.stringify({ id })]);
  return rows[0]?.run_id ? Number(rows[0].run_id) : null;
}
