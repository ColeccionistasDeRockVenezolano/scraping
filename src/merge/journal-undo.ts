// CRV · Deshacer un run con el diario de cambios (migración 0028).
//
// El diario guarda, por cada fila que un run tocó, cómo estaba antes y cómo
// quedó. Deshacer no necesita saber qué acción fue (fusión, división, retiro,
// edición, un lote de la CLI): calcula el efecto NETO del run sobre cada fila
// y lo invierte.
//
//  * EFECTO NETO. Una fila puede pasar por varios cambios en un mismo run
//    (alta y después edición; edición y después baja). Solo importan dos
//    fotos: la de antes del primer cambio y la de después del último.
//      - existía y ya no existe  → se reinserta tal cual (mismo id);
//      - no existía y existe     → se retira;
//      - existía y cambió        → vuelven las columnas que el run cambió;
//      - nació y murió en el run → nada.
//  * SOLO SE DESHACE LO QUE SE PUEDE DESHACER SIN MENTIR. Antes de escribir
//    nada, cada fila se compara con la foto de después (CAS inverso). Si una
//    tabla `strict` (el catálogo) cambió después, el deshacer se niega entero
//    y dice qué fila y qué run la cambió: primero hay que deshacer ese. En una
//    tabla `soft` (colas, conflictos, claims) la fila se deja y se informa.
//  * NADA SE PIERDE. Los claims que el run creó no se borran: quedan
//    `superseded` con la nota del deshacer. Un claim que apunta a una ficha
//    que el deshacer retira se suelta antes (su FK es CASCADE).
//  * ORDEN. Primero vuelven las filas borradas (padres antes que hijos), luego
//    los valores, y al final se retiran las altas (hijos antes que padres).
//    Lo que choca con una restricción (una clave única que todavía ocupa una
//    alta del run, una FK a una fila que vuelve más tarde) se reintenta
//    mientras haya progreso.
//  * EL DESHACER TAMBIÉN VA AL DIARIO: deshacer un deshacer es rehacer.
import type { PoolClient } from "pg";
import { OperatorError, type OperatorContext } from "./operator.js";

type Op = "I" | "U" | "D";
type Row = Record<string, unknown>;

interface JournalRow {
  id: string;
  table_name: string;
  op: Op;
  row_pk: Row;
  old_data: Row | null;
  new_data: Row | null;
}

/** Lo que un run le hizo a una fila, reducido a antes y después. */
export interface NetChange {
  table: string;
  pk: Row;
  existedBefore: boolean;
  /** Fila (o columnas que el run cambió) antes del run; null si la creó el run. */
  before: Row | null;
  /** Fila (o columnas cambiadas) después del run; null si el run la borró. */
  after: Row | null;
  /** `after` es la fila entera (alta), no solo las columnas cambiadas. */
  afterFull: boolean;
  firstId: number;
  lastId: number;
}

export type UndoStep = "restore" | "revert" | "remove";

export interface UndoConflict {
  table: string;
  pk: Row;
  /** changed: la fila cambió después; missing: ya no existe; exists: ya existe otra con esa clave. */
  reason: "changed" | "missing" | "exists";
  columns: string[];
  /** Run que la cambió después, si el diario lo sabe. */
  laterRunId: number | null;
  label: string | null;
}

export interface UndoEntityRef {
  kind: EntityKind;
  id: number;
  label: string | null;
  step: UndoStep;
}

export interface JournalUndoPlan {
  runId: number;
  changes: number;
  steps: Record<UndoStep, number>;
  byTable: Record<string, Record<UndoStep, number>>;
  /** Fichas del catálogo que el deshacer devuelve, corrige o retira. */
  entities: UndoEntityRef[];
  /** Filas del catálogo que cambiaron después: impiden deshacer. */
  conflicts: UndoConflict[];
  /** Filas de trabajo (colas, claims…) que cambiaron después: se dejan como están. */
  skipped: UndoConflict[];
  /** Claims que el run creó y siguen vivos: quedarán `superseded`. */
  claimsToSupersede: number;
}

export interface JournalUndoResult extends Omit<JournalUndoPlan, "conflicts"> {
  claimsSuperseded: number;
  claimsDetached: number;
}

const ENTITY_TABLES = {
  "public.artists": "artist",
  "public.persons": "person",
  "public.organizations": "organization",
  "public.albums": "album",
  "public.tracks": "track",
} as const;
type EntityKind = (typeof ENTITY_TABLES)[keyof typeof ENTITY_TABLES];

/** Columnas que se mueven solas con cualquier escritura: no cuentan como «cambió después». */
const NOISE_COLUMNS = new Set(["updated_at"]);

/** Códigos de PostgreSQL que un reintento puede resolver (orden entre pasos). */
const RETRYABLE = new Set(["23503", "23505", "23P01"]);

const TABLE_NAME = /^[a-z_]+\.[a-z_]+$/u;

function qualified(table: string): string {
  if (!TABLE_NAME.test(table)) throw new Error(`tabla del diario con nombre inesperado: ${table}`);
  const [schema, name] = table.split(".") as [string, string];
  return `"${schema}"."${name}"`;
}

const ident = (column: string): string => `"${column.replace(/"/gu, '""')}"`;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson((value as Row)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const sameValue = (left: unknown, right: unknown): boolean => stableJson(left) === stableJson(right);
const rowKey = (table: string, pk: Row): string => `${table}|${stableJson(pk)}`;

/** Reduce los cambios de un run a antes/después por fila, en el orden del diario. */
export function netChanges(rows: ReadonlyArray<Pick<JournalRow, "table_name" | "op" | "row_pk" | "old_data" | "new_data"> & { id: string | number }>): NetChange[] {
  const byRow = new Map<string, NetChange>();
  for (const row of rows) {
    const key = rowKey(row.table_name, row.row_pk);
    const id = Number(row.id);
    let change = byRow.get(key);
    if (!change) {
      change = {
        table: row.table_name, pk: row.row_pk, existedBefore: row.op !== "I",
        before: row.op === "I" ? null : {}, after: null, afterFull: false, firstId: id, lastId: id,
      };
      byRow.set(key, change);
    }
    change.lastId = id;
    if (row.op === "I") {
      change.after = { ...(row.new_data ?? {}) };
      change.afterFull = true;
    } else if (row.op === "U") {
      const old = row.old_data ?? {};
      if (change.before) {
        // La primera foto de cada columna gana: es la de antes del run.
        for (const [column, value] of Object.entries(old)) if (!(column in change.before)) change.before[column] = value;
      }
      change.after = { ...(change.after ?? {}), ...(row.new_data ?? {}) };
    } else {
      // Una baja trae la fila entera: completa la foto de antes con las
      // columnas que el run no había tocado todavía.
      if (change.before) change.before = { ...(row.old_data ?? {}), ...change.before };
      change.after = null;
      change.afterFull = false;
    }
  }
  return [...byRow.values()].filter((change) => change.existedBefore || change.after !== null);
}

function stepOf(change: NetChange): UndoStep {
  if (!change.existedBefore) return "remove";
  return change.after === null ? "restore" : "revert";
}

interface TableInfo {
  policy: "strict" | "soft";
  pkColumns: string[];
  identity: boolean;
  depth: number;
  /** Columnas de ingest.claims que apuntan a esta tabla con ON DELETE CASCADE. */
  claimColumns: string[];
}

async function loadTableInfo(client: PoolClient, tables: string[]): Promise<Map<string, TableInfo>> {
  const info = new Map<string, TableInfo>();
  if (tables.length === 0) return info;
  const policies = new Map((await client.query<{ table_name: string; policy: "strict" | "soft" }>(
    "SELECT table_name, policy FROM ingest.change_journal_tables")).rows.map((row) => [row.table_name, row.policy]));
  const meta = await client.query<{ name: string; pk: string[] | null; identity: boolean }>(`
    SELECT t.name,
           (SELECT array_agg(a.attname::text ORDER BY array_position(i.indkey::int2[], a.attnum))
              FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
             WHERE i.indrelid=to_regclass(t.name) AND i.indisprimary) AS pk,
           EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass(t.name) AND a.attidentity IN ('a','d')) AS identity
      FROM unnest($1::text[]) AS t(name)
     WHERE to_regclass(t.name) IS NOT NULL`, [tables]);
  // Profundidad por FKs: un padre siempre antes que sus hijos al reinsertar.
  const fks = await client.query<{ child: string; parent: string }>(`
    SELECT DISTINCT cn.nspname||'.'||c.relname AS child, pn.nspname||'.'||p.relname AS parent
      FROM pg_constraint k
      JOIN pg_class c ON c.oid=k.conrelid JOIN pg_namespace cn ON cn.oid=c.relnamespace
      JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
     WHERE k.contype='f' AND k.conrelid<>k.confrelid
       AND cn.nspname IN ('public','media','ingest') AND pn.nspname IN ('public','media','ingest')`);
  const parents = new Map<string, string[]>();
  for (const fk of fks.rows) parents.set(fk.child, [...(parents.get(fk.child) ?? []), fk.parent]);
  const depthMemo = new Map<string, number>();
  const depth = (table: string, seen = new Set<string>()): number => {
    const known = depthMemo.get(table);
    if (known !== undefined) return known;
    if (seen.has(table)) return 0;
    seen.add(table);
    const value = Math.max(0, ...(parents.get(table) ?? []).map((parent) => depth(parent, seen) + 1));
    depthMemo.set(table, value);
    return value;
  };
  const claimFks = await client.query<{ parent: string; column: string }>(`
    SELECT pn.nspname||'.'||p.relname AS parent, a.attname AS column
      FROM pg_constraint k
      JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace pn ON pn.oid=p.relnamespace
      JOIN pg_attribute a ON a.attrelid=k.conrelid AND a.attnum=k.conkey[1]
     WHERE k.contype='f' AND k.conrelid='ingest.claims'::regclass AND k.confdeltype='c'`);
  for (const row of meta.rows) {
    if (!row.pk?.length) throw new OperatorError("invalid", `la tabla ${row.name} no tiene clave primaria: no se puede deshacer`);
    info.set(row.name, {
      policy: policies.get(row.name) ?? "strict",
      pkColumns: row.pk,
      identity: row.identity,
      depth: depth(row.name),
      claimColumns: claimFks.rows.filter((fk) => fk.parent === row.name).map((fk) => fk.column),
    });
  }
  return info;
}

/** Filas actuales de las claves pedidas, por clave. */
async function currentRows(client: PoolClient, table: string, info: TableInfo, pks: Row[]): Promise<Map<string, Row>> {
  const found = new Map<string, Row>();
  const columns = info.pkColumns.map(ident).join(", ");
  for (let start = 0; start < pks.length; start += 1000) {
    const chunk = pks.slice(start, start + 1000);
    const { rows } = await client.query<{ row: Row }>(`
      SELECT to_jsonb(t) AS row FROM ${qualified(table)} t
       WHERE (${info.pkColumns.map((column) => `t.${ident(column)}`).join(", ")}) IN (
         SELECT ${columns} FROM jsonb_populate_recordset(NULL::${qualified(table)}, $1::jsonb))`, [JSON.stringify(chunk)]);
    for (const { row } of rows) {
      const pk = Object.fromEntries(info.pkColumns.map((column) => [column, row[column]]));
      found.set(rowKey(table, pk), row);
    }
  }
  return found;
}

function labelOf(row: Row | null | undefined): string | null {
  if (!row) return null;
  for (const key of ["name", "title", "alias", "role", "credit_role", "format"]) {
    const value = row[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

async function laterRun(client: PoolClient, change: NetChange): Promise<number | null> {
  const { rows } = await client.query<{ run_id: string | null }>(`
    SELECT run_id::text FROM ingest.change_journal
     WHERE table_name=$1 AND row_pk=$2::jsonb AND id>$3
     ORDER BY id LIMIT 1`, [change.table, JSON.stringify(change.pk), change.lastId]);
  return rows[0]?.run_id ? Number(rows[0].run_id) : null;
}

interface Evaluated {
  change: NetChange;
  step: UndoStep;
  current: Row | undefined;
  conflict: Omit<UndoConflict, "laterRunId"> | null;
}

function evaluate(change: NetChange, current: Row | undefined): Evaluated {
  const step = stepOf(change);
  const base = { table: change.table, pk: change.pk, label: labelOf(current ?? change.after ?? change.before) };
  if (step === "restore") {
    return { change, step, current, conflict: current ? { ...base, reason: "exists", columns: [] } : null };
  }
  if (!current) return { change, step, current, conflict: { ...base, reason: "missing", columns: [] } };
  const expected = change.after ?? {};
  const changed = Object.keys(expected)
    .filter((column) => !NOISE_COLUMNS.has(column) && !sameValue(current[column], expected[column]));
  return { change, step, current, conflict: changed.length ? { ...base, reason: "changed", columns: changed } : null };
}

interface Prepared {
  runId: number;
  info: Map<string, TableInfo>;
  evaluated: Evaluated[];
  plan: JournalUndoPlan;
}

async function prepare(client: PoolClient, runId: number): Promise<Prepared> {
  const journal = await client.query<JournalRow>(`
    SELECT id::text, table_name, op, row_pk, old_data, new_data
      FROM ingest.change_journal WHERE run_id=$1 ORDER BY id`, [runId]);
  const changes = netChanges(journal.rows);
  const info = await loadTableInfo(client, [...new Set(changes.map((change) => change.table))]);
  const evaluated: Evaluated[] = [];
  for (const [table, tableInfo] of info) {
    const ofTable = changes.filter((change) => change.table === table);
    const current = await currentRows(client, table, tableInfo, ofTable.map((change) => change.pk));
    for (const change of ofTable) evaluated.push(evaluate(change, current.get(rowKey(table, change.pk))));
  }
  const missingTables = changes.filter((change) => !info.has(change.table)).map((change) => change.table);
  if (missingTables.length) {
    throw new OperatorError("not_open", `el run toca tablas que ya no existen (${[...new Set(missingTables)].join(", ")})`, { runId });
  }

  const steps: Record<UndoStep, number> = { restore: 0, revert: 0, remove: 0 };
  const byTable: JournalUndoPlan["byTable"] = {};
  const entities: UndoEntityRef[] = [];
  const conflicts: UndoConflict[] = [];
  const skipped: UndoConflict[] = [];
  for (const item of evaluated) {
    if (item.conflict) {
      const full = { ...item.conflict, laterRunId: await laterRun(client, item.change) };
      (info.get(item.change.table)!.policy === "strict" ? conflicts : skipped).push(full);
      continue;
    }
    steps[item.step] += 1;
    const counts = byTable[item.change.table] ?? { restore: 0, revert: 0, remove: 0 };
    counts[item.step] += 1;
    byTable[item.change.table] = counts;
    const kind = ENTITY_TABLES[item.change.table as keyof typeof ENTITY_TABLES];
    if (kind) {
      const label = item.step === "restore" ? labelOf(item.change.before) : labelOf(item.current);
      entities.push({ kind, id: Number(item.change.pk["id"]), label, step: item.step });
    }
  }
  const claims = await client.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM ingest.claims WHERE run_id=$1 AND status IN ('accepted','candidate','conflict')", [runId]);
  return {
    runId, info, evaluated,
    plan: {
      runId, changes: changes.length, steps, byTable, entities, conflicts, skipped,
      claimsToSupersede: Number(claims.rows[0]?.n ?? 0),
    },
  };
}

/** Qué haría deshacer el run, sin escribir nada. */
export async function planJournalUndo(client: PoolClient, runId: number): Promise<JournalUndoPlan> {
  return (await prepare(client, runId)).plan;
}

/** `true` si el diario tiene cambios de ese run. */
export async function runHasJournal(client: Pick<PoolClient, "query">, runId: number): Promise<boolean> {
  const { rows } = await client.query<{ found: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM ingest.change_journal WHERE run_id=$1) AS found", [runId]);
  return rows[0]?.found ?? false;
}

function pkJoin(table: string, info: TableInfo): string {
  return `jsonb_populate_record(NULL::${qualified(table)}, $1::jsonb) k WHERE ${info.pkColumns.map((column) => `t.${ident(column)} = k.${ident(column)}`).join(" AND ")}`;
}

async function applyStep(client: PoolClient, item: Evaluated, info: TableInfo, note: string): Promise<number> {
  const { change } = item;
  const table = qualified(change.table);
  if (item.step === "restore") {
    await client.query(
      `INSERT INTO ${table} ${info.identity ? "OVERRIDING SYSTEM VALUE " : ""}SELECT * FROM jsonb_populate_record(NULL::${table}, $1::jsonb)`,
      [JSON.stringify(change.before)]);
    return 0;
  }
  if (item.step === "revert") {
    const columns = Object.keys(change.before ?? {}).filter((column) => !info.pkColumns.includes(column));
    if (columns.length === 0) return 0;
    await client.query(`
      UPDATE ${table} t SET ${columns.map((column) => `${ident(column)} = r.${ident(column)}`).join(", ")}
        FROM jsonb_populate_record(NULL::${table}, $2::jsonb) r, ${pkJoin(change.table, info)}`,
    [JSON.stringify(change.pk), JSON.stringify(change.before)]);
    return 0;
  }
  // remove: los claims que apuntan a la fila se sueltan antes (FK CASCADE).
  let detached = 0;
  const id = change.pk["id"];
  if (info.claimColumns.length && info.pkColumns.length === 1 && id !== undefined) {
    for (const column of info.claimColumns) {
      const result = await client.query(`
        UPDATE ingest.claims
           SET ${ident(column)}=NULL,
               status=CASE WHEN status IN ('rejected','superseded') THEN status ELSE 'superseded'::ingest.claim_status END,
               updated_at=now(), notes=concat_ws(' · ', notes, $2::text)
         WHERE ${ident(column)}=$1`, [id, note]);
      detached += result.rowCount ?? 0;
    }
  }
  await client.query(`DELETE FROM ${table} t USING ${pkJoin(change.table, info)}`, [JSON.stringify(change.pk)]);
  return detached;
}

/**
 * Deshace un run con el diario, dentro de la transacción del operador que
 * llama. Si una fila del catálogo cambió después, no escribe nada y responde
 * `not_open` con cada fila y el run que la cambió.
 */
export async function undoRunWithJournal(context: OperatorContext, runId: number): Promise<JournalUndoResult> {
  const client = context.client;
  const prepared = await prepare(client, runId);
  const { plan, info } = prepared;
  if (plan.conflicts.length) {
    const first = plan.conflicts[0]!;
    const later = [...new Set(plan.conflicts.map((conflict) => conflict.laterRunId).filter((id): id is number => id !== null))];
    throw new OperatorError("not_open",
      `${plan.conflicts.length === 1 ? "una ficha cambió" : `${plan.conflicts.length} filas del catálogo cambiaron`} después de este cambio`
        + ` (${first.table.split(".").pop()} ${stableJson(first.pk)}${first.label ? ` «${first.label}»` : ""})`
        + (later.length ? `: deshaz primero ${later.length === 1 ? "el cambio" : "los cambios"} ${later.map((id) => `#${id}`).join(", ")}` : ""),
      { runId, conflicts: plan.conflicts.slice(0, 50), laterRunIds: later });
  }

  const note = `deshecho por el run ${context.runId}: ${context.note}`;
  const phase: Record<UndoStep, number> = { restore: 0, revert: 1, remove: 2 };
  const pending = prepared.evaluated
    .filter((item) => !item.conflict)
    .sort((left, right) => {
      if (phase[left.step] !== phase[right.step]) return phase[left.step] - phase[right.step];
      const depthLeft = info.get(left.change.table)!.depth;
      const depthRight = info.get(right.change.table)!.depth;
      // Reinsertar: padres primero y en el orden original. Retirar: hijos
      // primero y del último al primero.
      if (left.step === "remove") return depthRight - depthLeft || right.change.firstId - left.change.firstId;
      return depthLeft - depthRight || left.change.firstId - right.change.firstId;
    });

  let claimsDetached = 0;
  let queue = pending;
  let lastError: { item: Evaluated; error: Error & { code?: string } } | undefined;
  while (queue.length) {
    const failed: Evaluated[] = [];
    for (const item of queue) {
      await client.query("SAVEPOINT crv_undo_step");
      try {
        claimsDetached += await applyStep(client, item, info.get(item.change.table)!, note);
        await client.query("RELEASE SAVEPOINT crv_undo_step");
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT crv_undo_step");
        const code = (error as { code?: string }).code;
        if (!code || !RETRYABLE.has(code)) throw error;
        lastError = { item, error: error as Error & { code?: string } };
        failed.push(item);
      }
    }
    if (failed.length === queue.length) {
      const { item, error } = lastError!;
      throw new OperatorError("not_open",
        `no se pudo devolver ${item.change.table.split(".").pop()} ${stableJson(item.change.pk)} a como estaba: ${error.message}`,
        { runId, table: item.change.table, pk: item.change.pk, pending: failed.length });
    }
    queue = failed;
  }

  // Los claims que el run creó y siguen vivos: sustituidos, nunca borrados.
  const superseded = await client.query(`
    UPDATE ingest.claims SET status='superseded', updated_at=now(), notes=concat_ws(' · ', notes, $2::text)
     WHERE run_id=$1 AND status IN ('accepted','candidate','conflict')`, [runId, note]);

  // La historia de cada ficha que vuelve o cambia dice que se deshizo.
  for (const entity of plan.entities) {
    if (entity.step === "remove") continue;
    await client.query(`
      INSERT INTO ingest.merge_audit(run_id,entity_kind,${entity.kind}_id,field,old_value,new_value,reason,confidence,performed_by)
      VALUES($1,$2::ingest.claim_entity_kind,$3,'undo_run',$4::jsonb,NULL,$5,'high','human')`,
    [context.runId, entity.kind, entity.id, JSON.stringify({ undoneRunId: runId, step: entity.step }), `deshacer el cambio #${runId}: ${context.note}`]);
  }

  const { conflicts: _conflicts, ...rest } = plan;
  void _conflicts;
  return { ...rest, claimsSuperseded: superseded.rowCount ?? 0, claimsDetached };
}
