// CRV · Deshacer una fusión (PHASES E11.8; plan P6).
//
// `undoMergeRun` revierte un run de fusión completo —la persona, los créditos y
// membresías que se unificaron— usando el rastro que la auditoría guarda desde
// E11.1: `movedRefs` (clave primaria de cada fila movida), `discardedRows`
// (filas que no cabían, con su copia entera), `detachedReviews` (revisiones
// que se soltaron) y las columnas completadas.
//
// SOLO SE DESHACE LO QUE SE PUEDE DESHACER SIN MENTIR: si la ficha que quedó
// se fusionó después, si alguna fila movida ya apunta a otra entidad o si la
// fusión es anterior a E11.1 (no guardaba las filas movidas), se aborta con
// `not_open` y no se toca nada. Las correcciones de campo que una persona hizo
// durante la fusión (`fieldChoices`) no se revierten: se informan.
import type { PoolClient } from "pg";
import { OperatorError, type OperatorContext } from "./operator.js";
import { MERGE_TABLES, type DiscardedRow, type MergeKind, type MovedRef } from "../review/duplicates.js";

/** Contenido de `merge_audit.new_value` en una fusión endurecida (E11.1+). */
export interface MergeAuditData {
  keptId: number;
  filled: string[];
  moved: number;
  discarded: number;
  tracksMerged: number;
  movedRefs: MovedRef[];
  discardedRows: DiscardedRow[];
  detachedReviews: Array<Record<string, unknown>>;
  version: 2;
}

export interface UnmergeResult {
  /** Run de fusión deshecho (no el run de la reversión: ese es el del contexto). */
  mergeRunId: number;
  restored: Array<{ kind: string; id: number }>;
  /** Correcciones por `fieldChoices` hechas en ese run: se informan, no se revierten. */
  fieldsNotReverted: string[];
}

interface MergeAuditRow {
  id: string;
  entity_kind: MergeKind;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
}

/** `true` si el `id` de la tabla es `GENERATED ... AS IDENTITY` (necesita OVERRIDING SYSTEM VALUE). */
async function hasIdentity(client: PoolClient, table: string): Promise<boolean> {
  const { rows } = await client.query<{ identity: boolean }>(`
    SELECT EXISTS (
      SELECT 1 FROM pg_attribute a
        JOIN pg_class c ON c.oid=a.attrelid
       WHERE c.oid=$1::regclass AND a.attidentity IN ('a','d')) AS identity`, [table]);
  return rows[0]?.identity ?? false;
}

/** Reinserta una fila borrada tal cual estaba (con su id, usando OVERRIDING si hace falta). */
async function reinsertRow(client: PoolClient, table: string, snapshot: Record<string, unknown>): Promise<void> {
  const qualified = qualify(table);
  const overriding = await hasIdentity(client, qualified) ? "OVERRIDING SYSTEM VALUE " : "";
  await client.query(
    `INSERT INTO ${qualified} ${overriding}SELECT * FROM jsonb_populate_record(NULL::${qualified}, $1::jsonb)`, [snapshot]);
}

/** `movedRefs` ya trae `esquema.tabla`; `MERGE_TABLES` trae el nombre pelado. */
const qualify = (table: string): string => (table.includes(".") ? table : `public.${table}`);

/** Columnas cuyo «vacío» es un DEFAULT del core, no NULL. */
const EMPTY_AGAIN: Readonly<Record<string, string>> = {
  "persons.is_venezuelan": "false",
  "albums.album_type": "'other'",
};

/** Devuelve a `keep` el valor vacío que tenía antes de completarse desde `drop`. */
async function emptyAgain(client: PoolClient, kind: MergeKind, column: string, keepId: number, dropSnapshot: Record<string, unknown>): Promise<void> {
  const table = qualify(MERGE_TABLES[kind]);
  const value = EMPTY_AGAIN[`${table.split(".").pop()}.${column}`] ?? "NULL";
  // Solo si la ficha que queda sigue teniendo el valor que le vino del duplicado.
  await client.query(`
    UPDATE ${table} k SET ${column}=${value}
     WHERE k.id=$1
       AND k.${column} IS NOT DISTINCT FROM (
         SELECT r.${column} FROM jsonb_populate_record(NULL::${table}, $2::jsonb) r)`, [keepId, dropSnapshot]);
}

/**
 * Deshace todas las fusiones de un run (`merged_duplicate`), en orden inverso
 * al que se hicieron: primero las unificaciones de créditos y membresías, al
 * final la persona. Quien la use está dentro de la transacción del operador.
 */
export async function undoMergeRun(context: OperatorContext, mergeRunId: number): Promise<UnmergeResult> {
  const client = context.client;
  const { rows } = await client.query<MergeAuditRow>(`
    SELECT id::text, entity_kind::text AS entity_kind, old_value, new_value
      FROM ingest.merge_audit
     WHERE run_id=$1 AND field='merged_duplicate'
     ORDER BY id DESC`, [mergeRunId]);
  if (rows.length === 0) {
    throw new OperatorError("not_open", `el run ${mergeRunId} no tiene fusiones que deshacer`, { runId: mergeRunId });
  }

  const restored: Array<{ kind: string; id: number }> = [];
  for (const audit of rows) {
    const data = audit.new_value as unknown as MergeAuditData | null;
    const drop = audit.old_value;
    if (!data || data.version !== 2 || !drop) {
      throw new OperatorError("invalid", "fusión anterior a E11.1: no guarda las filas movidas", { auditId: Number(audit.id) });
    }
    const kind = audit.entity_kind;
    const table = MERGE_TABLES[kind];
    const keepId = data.keptId;
    const dropId = Number(drop["id"]);

    // Precondiciones: la ficha que quedó sigue siendo la misma y las filas
    // movidas no se han movido otra vez. Si algo de esto falla, no se toca nada.
    const keepExists = (await client.query(`SELECT 1 FROM ${table} WHERE id=$1`, [keepId])).rowCount;
    if (!keepExists) {
      throw new OperatorError("not_open", `la ficha que quedó (${kind} ${keepId}) ya no existe; se fusionó después`, { keepId });
    }
    const redirected = (await client.query(
      "SELECT 1 FROM ingest.entity_redirects WHERE entity_kind=$1 AND from_id=$2", [kind, keepId])).rowCount;
    if (redirected) {
      throw new OperatorError("not_open", `la ficha que quedó (${kind} ${keepId}) se fusionó después en otra`, { keepId });
    }
    for (const ref of data.movedRefs) {
      for (const key of ref.keys) {
        const pk = Object.keys(key)[0]!;
        const stillThere = (await client.query(
          `SELECT 1 FROM ${ref.table} WHERE ${pk}=$1 AND ${ref.column}=$2`, [key[pk], keepId])).rowCount;
        if (!stillThere) {
          throw new OperatorError("not_open",
            `una fila movida por la fusión (${ref.table}.${ref.column}) ya no apunta a ${keepId}: se movió otra vez`, { keepId });
        }
      }
    }

    // 1. La fila borrada vuelve tal cual (la persona primero: lo demás la referencia).
    await reinsertRow(client, table, drop);
    // 2. Cada fila movida vuelve a apuntar al duplicado.
    for (const ref of data.movedRefs) {
      for (const key of ref.keys) {
        const pk = Object.keys(key)[0]!;
        await client.query(
          `UPDATE ${ref.table} SET ${ref.column}=$1 WHERE ${pk}=$2 AND ${ref.column}=$3`, [dropId, key[pk], keepId]);
      }
    }
    // 3. Las filas descartadas vuelven (claims superseded recuperan destino y estado).
    for (const discarded of data.discardedRows) {
      if (discarded.policy === "superseded") {
        await client.query(`
          UPDATE ingest.claims
             SET ${discarded.column}=$2, status=$3::ingest.claim_status, updated_at=now()
           WHERE id=$1`, [discarded.row["id"], discarded.row[discarded.column] ?? null, discarded.row["status"]]);
      } else {
        await reinsertRow(client, discarded.table, discarded.row);
      }
    }
    // 4. Las revisiones que se soltaron vuelven a su fila anterior.
    for (const review of data.detachedReviews) {
      // `updated_at` se reescribe con ahora: es el sello de esta reversión.
      const entries = Object.entries(review).filter(([key]) => key !== "id" && key !== "created_at" && key !== "updated_at");
      const assignments = entries.map(([key], index) => `${key}=$${index + 2}`).join(", ");
      await client.query(
        `UPDATE ingest.review_queue SET ${assignments}, updated_at=now() WHERE id=$1`,
        [review["id"], ...entries.map(([, value]) => value)]);
    }
    // 5. Las columnas que se completaron desde el duplicado vuelven a estar vacías.
    for (const column of data.filled) await emptyAgain(client, kind, column, keepId, drop);
    // 6. El alias que dejó la fusión no debería sobrevivir a la fusión.
    const aliasTable = kind === "person" ? "ingest.person_aliases" : undefined;
    if (aliasTable) {
      await client.query(
        `DELETE FROM ${aliasTable} WHERE person_id=$1 AND alias=$2 AND notes='Nombre de un duplicado fusionado'`,
        [keepId, String(drop["name"])]);
    }
    // 7. La redirección del id desaparecido.
    await client.query(
      "DELETE FROM ingest.entity_redirects WHERE entity_kind=$1 AND from_id=$2 AND to_id=$3", [kind, dropId, keepId]);
    // 8. El rastro de la reversión, con los mismos claims que probaban la fusión.
    const auditRow = await client.query<{ id: string }>(`
      INSERT INTO ingest.merge_audit(run_id,entity_kind,${kind}_id,field,old_value,new_value,reason,confidence,performed_by)
      VALUES($1,$2::ingest.claim_entity_kind,$3,'unmerged_duplicate',$4::jsonb,NULL,$5,'high','human') RETURNING id::text`,
    [context.runId, kind, keepId, JSON.stringify({ undoneAuditId: Number(audit.id), restoredDropId: dropId, ...data }), context.note]);
    await client.query(
      "INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) SELECT $1, claim_id FROM ingest.merge_audit_claims WHERE merge_audit_id=$2 ON CONFLICT DO NOTHING",
      [Number(auditRow.rows[0]!.id), Number(audit.id)]);
    restored.push({ kind, id: dropId });
  }

  // Las correcciones de campo del run (updateEntity por fieldChoices) no se
  // revierten: cambiar el valor otra vez sería afirmar algo que nadie decidió.
  const corrections = (await client.query<{ field: string }>(`
    SELECT DISTINCT field FROM ingest.merge_audit
     WHERE run_id=$1 AND field NOT IN ('merged_duplicate','unmerged_duplicate')
     ORDER BY field`, [mergeRunId])).rows.map((row) => row.field);
  return { mergeRunId, restored, fieldsNotReverted: corrections };
}
