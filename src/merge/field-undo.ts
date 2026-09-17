// CRV · Deshacer correcciones de campo (PLAN_CURADURIA E4.5, A8).
//
// `undoFieldCorrections` revierte los cambios de campo de un run del operador:
// por cada fila de `merge_audit` del run sobre una ficha (artista, persona,
// organización, disco o pista), si el valor actual sigue siendo el
// `new_value` —CAS inverso—, restaura el `old_value` EXACTO. No pasa por
// `updateEntity`: el motor normaliza el texto que afirma una persona (NFC,
// espacios colapsados) y lo que se deshace es justo el texto que la corrección
// limpió; restaurarlo normalizado no sería deshacer.
//
// Lo que la corrección cambió alrededor del valor también vuelve, siempre que
// nadie lo haya tocado después (cada paso compara con lo que dejó la corrección):
//  - el alias que el renombrado añadió con el nombre nuevo se retira;
//  - los claims que la corrección dejó `superseded` (o sacó de `conflict`)
//    recuperan su estado, y los claims humanos de la corrección quedan
//    `superseded` con la nota del deshacer: los claims no se borran;
//  - los conflictos y revisiones `field_conflict` que cerró vuelven a como
//    estaban (estado, nota, quién y cuándo);
//  - lo que abrió y sigue vivo (un conflicto, una revisión de alias ambiguo)
//    se descarta con la nota del deshacer.
// Ese entorno lo registra `withFieldJournal` en los `params` del run al
// aplicar. Un run sin diario (anterior a E4) solo recupera valor y alias.
//
// SOLO SE DESHACE LO QUE SE PUEDE DESHACER SIN MENTIR: si el valor ya no es el
// que dejó la corrección, si la ficha desapareció o si el run incluye cambios
// que no son de campo (fusiones, retiros, relaciones), se aborta con
// `OperatorError` y la transacción entera vuelve atrás.
import type { PoolClient } from "pg";
import { OperatorError, type OperatorContext } from "./operator.js";
import { ENTITY_SPECS, type ResolvableClaimKind } from "./specs.js";

const ENTITY_KINDS: readonly ResolvableClaimKind[] = ["artist", "person", "organization", "album", "track"];

function isEntityKind(kind: string): kind is ResolvableClaimKind {
  return (ENTITY_KINDS as readonly string[]).includes(kind);
}

/** Qué rodea a unos campos de una ficha: lo que una corrección humana puede cambiar además del valor. */
interface FieldTrace {
  claims: Map<number, string>;
  conflicts: Map<number, Record<string, unknown>>;
  reviews: Map<number, Record<string, unknown>>;
  aliases: Set<number>;
}

export interface FieldJournal {
  version: 1;
  kind: ResolvableClaimKind;
  id: number;
  fields: string[];
  claims: { changed: Array<{ id: number; from: string; to: string }>; created: Array<{ id: number; status: string }> };
  conflicts: { changed: Array<{ id: number; before: Record<string, unknown>; afterStatus: string }>; created: number[] };
  reviews: { changed: Array<{ id: number; before: Record<string, unknown>; afterStatus: string }>; created: number[] };
  aliasesAdded: number[];
}

async function captureTrace(client: PoolClient, kind: ResolvableClaimKind, id: number, fields: string[]): Promise<FieldTrace> {
  const spec = ENTITY_SPECS[kind];
  const claims = await client.query<{ id: string; status: string }>(
    `SELECT id::text, status::text FROM ingest.claims WHERE ${spec.targetColumn}=$1 AND field=ANY($2::text[])`, [id, fields]);
  const claimIds = claims.rows.map((row) => Number(row.id));
  const conflicts = await client.query<{ id: string; row: Record<string, unknown> }>(`
    SELECT c.id::text, to_jsonb(c) AS row FROM ingest.conflicts c
      JOIN ingest.claims a ON a.id=c.claim_a_id JOIN ingest.claims b ON b.id=c.claim_b_id
     WHERE c.entity_kind=$1::ingest.claim_entity_kind AND c.field=ANY($2::text[])
       AND (a.${spec.targetColumn}=$3 OR b.${spec.targetColumn}=$3)`, [kind, fields, id]);
  const conflictIds = conflicts.rows.map((row) => Number(row.id));
  // El mismo alcance con que `overrideFieldByHuman` aprueba revisiones, más las
  // de alias ambiguo que abre un renombrado cuyo nombre ya es alias de otra ficha.
  const reviews = await client.query<{ id: string; row: Record<string, unknown> }>(`
    SELECT r.id::text, to_jsonb(r) AS row FROM ingest.review_queue r
     WHERE (r.kind='field_conflict' AND (r.conflict_id=ANY($1::bigint[]) OR r.claim_a_id=ANY($2::bigint[]) OR r.claim_b_id=ANY($2::bigint[])
            OR (r.payload->>'entityKind'=$3 AND r.payload->>'targetId'=$4 AND r.payload->>'field'=ANY($5::text[]))))
        OR (r.kind='ambiguous_alias' AND r.claim_a_id=ANY($2::bigint[]))`, [conflictIds, claimIds, kind, String(id), fields]);
  const aliases = await client.query<{ id: string }>(
    `SELECT id::text FROM ${spec.aliasTable} WHERE ${spec.aliasTargetColumn}=$1`, [id]);
  return {
    claims: new Map(claims.rows.map((row) => [Number(row.id), row.status])),
    conflicts: new Map(conflicts.rows.map((row) => [Number(row.id), row.row])),
    reviews: new Map(reviews.rows.map((row) => [Number(row.id), row.row])),
    aliases: new Set(aliases.rows.map((row) => Number(row.id))),
  };
}

function diffRows(before: Map<number, Record<string, unknown>>, after: Map<number, Record<string, unknown>>) {
  const changed: Array<{ id: number; before: Record<string, unknown>; afterStatus: string }> = [];
  const created: number[] = [];
  for (const [id, row] of after) {
    const previous = before.get(id);
    if (!previous) created.push(id);
    else if (JSON.stringify(previous) !== JSON.stringify(row)) changed.push({ id, before: previous, afterStatus: String(row["status"]) });
  }
  return { changed, created };
}

/**
 * Corre `work` (que escribe campos de UNA ficha por el motor) y guarda en el
 * run lo que cambió alrededor de esos campos, para que `undoFieldCorrections`
 * lo devuelva a su sitio.
 */
export async function withFieldJournal<T>(
  context: OperatorContext, target: { kind: ResolvableClaimKind; id: number; fields: string[] }, work: () => Promise<T>,
): Promise<{ result: T; journal: FieldJournal }> {
  const before = await captureTrace(context.client, target.kind, target.id, target.fields);
  const result = await work();
  const after = await captureTrace(context.client, target.kind, target.id, target.fields);
  const journal: FieldJournal = {
    version: 1, kind: target.kind, id: target.id, fields: target.fields,
    claims: {
      changed: [...after.claims].filter(([id, status]) => before.claims.has(id) && before.claims.get(id) !== status)
        .map(([id, status]) => ({ id, from: before.claims.get(id)!, to: status })),
      created: [...after.claims].filter(([id]) => !before.claims.has(id)).map(([id, status]) => ({ id, status })),
    },
    conflicts: diffRows(before.conflicts, after.conflicts),
    reviews: diffRows(before.reviews, after.reviews),
    aliasesAdded: [...after.aliases].filter((id) => !before.aliases.has(id)),
  };
  await context.client.query(`
    UPDATE ingest.scrape_runs
       SET params=COALESCE(params,'{}'::jsonb) || jsonb_build_object('fieldJournal', COALESCE(params->'fieldJournal','[]'::jsonb) || $2::jsonb)
     WHERE id=$1`, [context.runId, JSON.stringify([journal])]);
  return { result, journal };
}

export interface FieldUndoResult {
  /** Run deshecho (no el de la reversión: ese es el del contexto). */
  runId: number;
  restored: Array<{ kind: ResolvableClaimKind; id: number; field: string }>;
  aliasesRemoved: number;
  claimsRestored: number;
  claimsSuperseded: number;
  conflictsRestored: number;
  reviewsRestored: number;
  dismissed: number;
}

interface AuditRow {
  id: string;
  entity_kind: string;
  /** La ficha auditada; NULL si la fila apunta a una relación o a un enlace (una sola destino por fila). */
  target_id: string | null;
  field: string;
}

/** PostgreSQL rechazó restaurar el valor (p. ej. otro artista ya usa ese nombre). */
const RESTORE_REJECTED = new Set(["23505", "23514", "23502"]);

/**
 * Deshace los cambios de campo de un run, en orden inverso. Corre dentro de la
 * transacción del operador que llama (`withOperatorRun`).
 */
export async function undoFieldCorrections(context: OperatorContext, runId: number): Promise<FieldUndoResult> {
  const client = context.client;
  const run = await client.query<{ params: Record<string, unknown> | null }>("SELECT params FROM ingest.scrape_runs WHERE id=$1", [runId]);
  if (!run.rows[0]) throw new OperatorError("not_found", `run ${runId} inexistente`, { runId });
  const audits = await client.query<AuditRow>(`
    SELECT id::text, entity_kind::text AS entity_kind, field,
           COALESCE(artist_id, person_id, organization_id, album_id, track_id)::text AS target_id
      FROM ingest.merge_audit
     WHERE run_id=$1
     ORDER BY id DESC`, [runId]);
  if (audits.rows.length === 0) {
    throw new OperatorError("not_open", `el run ${runId} no cambió ningún campo que deshacer`, { runId });
  }
  for (const audit of audits.rows) {
    const spec = isEntityKind(audit.entity_kind) ? ENTITY_SPECS[audit.entity_kind] : undefined;
    if (!spec || audit.target_id === null || !spec.fields[audit.field]) {
      throw new OperatorError("invalid", `el run ${runId} incluye cambios que no son de campo (${audit.entity_kind}.${audit.field}): este deshacer no los revierte`, { runId, auditId: Number(audit.id) });
    }
  }

  const note = `deshecho por el run ${context.runId}: ${context.note}`;
  const restored: FieldUndoResult["restored"] = [];
  for (const audit of audits.rows) {
    const kind = audit.entity_kind as ResolvableClaimKind;
    const spec = ENTITY_SPECS[kind];
    const column = spec.fields[audit.field]!;
    const id = Number(audit.target_id);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`merge:${kind}:${id}:${audit.field}`]);
    // CAS inverso, en SQL: jsonb contra jsonb, sin pasar por la forma que el
    // driver le da a un número, una fecha o un NULL.
    const current = await client.query<{ same: boolean }>(`
      SELECT (to_jsonb(t.${column}) IS NOT DISTINCT FROM a.new_value OR (a.new_value='null'::jsonb AND t.${column} IS NULL)) AS same
        FROM ${spec.table} t, ingest.merge_audit a
       WHERE t.id=$1 AND a.id=$2
       FOR UPDATE OF t`, [id, Number(audit.id)]);
    if (!current.rows[0]) {
      throw new OperatorError("not_open", `${kind} ${id} ya no existe: no hay valor que restaurar`, { entity: kind, id });
    }
    if (!current.rows[0].same) {
      throw new OperatorError("not_open", `${kind} ${id}.${audit.field} cambió después de la corrección: deshacerla pisaría ese cambio`, {
        entity: kind, id, field: audit.field, auditId: Number(audit.id),
      });
    }
    // El valor exacto que había: `jsonb_populate_record` le da el tipo de la columna.
    try {
      await client.query(`
        UPDATE ${spec.table} t SET ${column}=r.${column}
          FROM ingest.merge_audit a, LATERAL jsonb_populate_record(NULL::${spec.table}, jsonb_build_object('${column}', a.old_value)) r
         WHERE t.id=$1 AND a.id=$2`, [id, Number(audit.id)]);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (typeof code === "string" && RESTORE_REJECTED.has(code)) {
        throw new OperatorError("not_open", `${kind} ${id}.${audit.field} no admite el valor anterior: ${(error as Error).message}`, {
          entity: kind, id, field: audit.field, auditId: Number(audit.id),
        });
      }
      throw error;
    }
    const saved = await client.query<{ id: string }>(`
      INSERT INTO ingest.merge_audit(run_id,entity_kind,${spec.targetColumn},field,old_value,new_value,reason,confidence,performed_by)
      SELECT $1, a.entity_kind, $2, a.field, a.new_value, a.old_value, $3, 'high', 'human' FROM ingest.merge_audit a WHERE a.id=$4
      RETURNING id::text`, [context.runId, id, `deshacer la corrección del run ${runId} (auditoría ${audit.id}): ${context.note}`, Number(audit.id)]);
    await client.query(
      "INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) SELECT $1, claim_id FROM ingest.merge_audit_claims WHERE merge_audit_id=$2 ON CONFLICT DO NOTHING",
      [Number(saved.rows[0]!.id), Number(audit.id)]);
    restored.push({ kind, id, field: audit.field });
  }

  const result: FieldUndoResult = {
    runId, restored, aliasesRemoved: 0, claimsRestored: 0, claimsSuperseded: 0, conflictsRestored: 0, reviewsRestored: 0, dismissed: 0,
  };
  const journals = Array.isArray(run.rows[0].params?.["fieldJournal"]) ? run.rows[0].params["fieldJournal"] as FieldJournal[] : [];
  if (journals.length === 0) {
    await undoWithoutJournal(client, runId, restored, note, result);
    return result;
  }
  for (const journal of [...journals].reverse()) await undoJournal(client, journal, note, result);
  return result;
}

async function undoJournal(client: PoolClient, journal: FieldJournal, note: string, result: FieldUndoResult): Promise<void> {
  if (journal.version !== 1 || !isEntityKind(journal.kind)) {
    throw new OperatorError("invalid", "diario de corrección desconocido: no se puede deshacer con seguridad", { journal: journal.version });
  }
  const spec = ENTITY_SPECS[journal.kind];
  if (journal.aliasesAdded.length) {
    const removed = await client.query(
      `DELETE FROM ${spec.aliasTable} WHERE id=ANY($1::bigint[]) AND ${spec.aliasTargetColumn}=$2`, [journal.aliasesAdded, journal.id]);
    result.aliasesRemoved += removed.rowCount ?? 0;
  }
  for (const claim of journal.claims.changed) {
    const restored = await client.query(
      "UPDATE ingest.claims SET status=$2::ingest.claim_status,updated_at=now() WHERE id=$1 AND status=$3::ingest.claim_status",
      [claim.id, claim.from, claim.to]);
    result.claimsRestored += restored.rowCount ?? 0;
  }
  if (journal.claims.created.length) {
    const superseded = await client.query(`
      UPDATE ingest.claims SET status='superseded',updated_at=now(),notes=concat_ws(' · ',notes,$2::text)
       WHERE id=ANY($1::bigint[]) AND status IN ('accepted','candidate','conflict')`,
    [journal.claims.created.map((claim) => claim.id), note]);
    result.claimsSuperseded += superseded.rowCount ?? 0;
  }
  // Los conflictos antes que sus revisiones: una revisión apunta a su conflicto.
  for (const conflict of journal.conflicts.changed) {
    const restored = await client.query(`
      UPDATE ingest.conflicts c
         SET status=r.status, resolution_note=r.resolution_note, resolved_by=r.resolved_by, resolved_at=r.resolved_at,
             value_a=r.value_a, value_b=r.value_b
        FROM jsonb_populate_record(NULL::ingest.conflicts, $2::jsonb) r
       WHERE c.id=$1 AND c.status=$3::ingest.conflict_status`, [conflict.id, JSON.stringify(conflict.before), conflict.afterStatus]);
    result.conflictsRestored += restored.rowCount ?? 0;
  }
  if (journal.conflicts.created.length) {
    const dismissed = await client.query(`
      UPDATE ingest.conflicts SET status='dismissed',resolved_by='human',resolution_note=$2,resolved_at=now()
       WHERE id=ANY($1::bigint[]) AND status='open'`, [journal.conflicts.created, note]);
    result.dismissed += dismissed.rowCount ?? 0;
  }
  for (const review of journal.reviews.changed) {
    // `updated_at` se reescribe con ahora: es el sello de esta reversión (igual que al deshacer una fusión).
    const restored = await client.query(`
      UPDATE ingest.review_queue q
         SET status=r.status, resolved_by=r.resolved_by, resolution_note=r.resolution_note, resolved_at=r.resolved_at,
             payload=r.payload, updated_at=now()
        FROM jsonb_populate_record(NULL::ingest.review_queue, $2::jsonb) r
       WHERE q.id=$1 AND q.status=$3::ingest.review_status`, [review.id, JSON.stringify(review.before), review.afterStatus]);
    result.reviewsRestored += restored.rowCount ?? 0;
  }
  if (journal.reviews.created.length) {
    const dismissed = await client.query(`
      UPDATE ingest.review_queue SET status='dismissed',resolved_by='human',resolution_note=$2,resolved_at=now(),updated_at=now()
       WHERE id=ANY($1::bigint[]) AND status IN ('open','in_progress')`, [journal.reviews.created, note]);
    result.dismissed += dismissed.rowCount ?? 0;
  }
}

/** Run sin diario (anterior a E4): el valor ya volvió; se retira el alias del nombre nuevo y sus claims quedan sustituidos. */
async function undoWithoutJournal(
  client: PoolClient, runId: number, restored: FieldUndoResult["restored"], note: string, result: FieldUndoResult,
): Promise<void> {
  for (const target of new Map(restored.map((item) => [`${item.kind}:${item.id}`, item])).values()) {
    const spec = ENTITY_SPECS[target.kind];
    const removed = await client.query(`
      DELETE FROM ${spec.aliasTable}
       WHERE ${spec.aliasTargetColumn}=$1 AND claim_id IN (SELECT id FROM ingest.claims WHERE run_id=$2)`, [target.id, runId]);
    result.aliasesRemoved += removed.rowCount ?? 0;
  }
  const superseded = await client.query(`
    UPDATE ingest.claims SET status='superseded',updated_at=now(),notes=concat_ws(' · ',notes,$2::text)
     WHERE run_id=$1 AND status IN ('accepted','candidate','conflict')`, [runId, note]);
  result.claimsSuperseded += superseded.rowCount ?? 0;
}
