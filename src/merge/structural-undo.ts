// CRV · Deshacer de acciones estructurales (PLAN_CURADURIA E6).
//
// Complementa a `field-undo.ts` (restaura campos) y a `unmerge.ts` (deshace fusiones):
//   * `undoRelationCreation`: elimina la relación creada y deshace campos asociados.
//   * `undoEntityRemoval`: reinstala la fila eliminada desde su snapshot de auditoría,
//     restaura alias y claims rechazados.
import { undoFieldCorrections } from "./field-undo.js";
import { OperatorError, type OperatorContext } from "./operator.js";
import { RELATION_SPECS, type RelationClaimKind } from "./relations.js";
import { removeEntity, type RemovalResult } from "./removals.js";
import { ENTITY_SPECS, type ResolvableClaimKind } from "./specs.js";
import { hasIdentity } from "./unmerge.js";

export interface RelationUndoResult {
  runId: number;
  relationDeleted?: { kind: RelationClaimKind; id: number };
  entityRemoved?: { kind: ResolvableClaimKind; id: number };
  fieldUndo?: unknown;
}

export interface EntityRestoreResult {
  runId: number;
  restored: { kind: ResolvableClaimKind; id: number };
  claimsRestored: number;
  fieldUndo?: unknown;
}

/**
 * Deshace la creación de una relación (y entidades o campos asociados creados en el run).
 */
export async function undoRelationCreation(context: OperatorContext, runId: number): Promise<RelationUndoResult> {
  const client = context.client;
  const run = (await client.query<{ params: Record<string, unknown> | null }>(
    "SELECT params FROM ingest.scrape_runs WHERE id=$1", [runId])).rows[0];
  if (!run) throw new OperatorError("not_found", `run ${runId} inexistente`, { runId });

  const result: RelationUndoResult = { runId };
  const params = run.params ?? {};

  // 1. Si se creó una relación en este run, borrarla
  const relation = params["relationCreated"] as { kind: RelationClaimKind; id: number } | undefined;
  if (relation && RELATION_SPECS[relation.kind]) {
    const spec = RELATION_SPECS[relation.kind];
    // Limpiar auditoría y enlaces FK antes de borrar la fila puente, para evitar
    // violaciones del ON DELETE RESTRICT en merge_audit_claims
    await client.query(
      `DELETE FROM ingest.merge_audit_claims mac
       USING ingest.merge_audit ma
       WHERE mac.merge_audit_id = ma.id
         AND (ma.${spec.column} = $1 OR ma.run_id = $2)`,
      [relation.id, runId]);
    await client.query(
      `DELETE FROM ingest.merge_audit WHERE ${spec.column} = $1 OR run_id = $2`,
      [relation.id, runId]);
    await client.query(
      `UPDATE ingest.claims
          SET ${spec.column} = NULL,
              status = 'superseded',
              updated_at = now(),
              notes = concat_ws(' · ', notes, 'deshecho por operador')
        WHERE ${spec.column} = $1 OR run_id = $2`,
      [relation.id, runId]);
    await client.query(`DELETE FROM ${spec.table} WHERE id=$1`, [relation.id]);
    result.relationDeleted = relation;
  }

  // 2. Si se creó una entidad en este run (p. ej. artista creado por extraer_interprete_creando)
  const createdEntity = params["entityCreated"] as { kind: ResolvableClaimKind; id: number } | undefined;
  if (createdEntity && ENTITY_SPECS[createdEntity.kind]) {
    try {
      await removeEntity(client, createdEntity.kind, createdEntity.id, { note: `deshecho del run ${runId}`, runId: context.runId });
      result.entityRemoved = createdEntity;
    } catch {
      // Si ya tiene dependientes ajenos al run, no se retira
    }
  }

  // 3. Si hubo correcciones de campo asociadas (título de pista, etc.)
  if (params["fieldJournal"]) {
    result.fieldUndo = await undoFieldCorrections(context, runId);
  }

  return result;
}

/**
 * Restaura una entidad retirada en un run (a partir del snapshot guardado en params->'removed').
 */
export async function undoEntityRemoval(context: OperatorContext, runId: number): Promise<EntityRestoreResult> {
  const client = context.client;
  const run = (await client.query<{ params: Record<string, unknown> | null }>(
    "SELECT params FROM ingest.scrape_runs WHERE id=$1", [runId])).rows[0];
  if (!run) throw new OperatorError("not_found", `run ${runId} inexistente`, { runId });

  const params = run.params ?? {};
  const removal = params["removed"] as RemovalResult | undefined;
  if (!removal || !removal.kind || removal.id === undefined || !removal.snapshot) {
    throw new OperatorError("invalid", `el run ${runId} no contiene registro de entidad retirada`, { runId });
  }

  const kind = removal.kind as ResolvableClaimKind;
  const spec = ENTITY_SPECS[kind];
  if (!spec) throw new OperatorError("invalid", `tipo ${removal.kind} no restaurable`, { kind });

  // Comprobar si la fila ya existe con ese ID
  const existing = (await client.query(`SELECT 1 FROM ${spec.table} WHERE id=$1`, [removal.id])).rowCount;
  if (existing) {
    throw new OperatorError("already_exists", `${kind} ${removal.id} ya existe en el catálogo`, { kind, id: removal.id });
  }

  // Restaurar fila original
  const snapshot = removal.snapshot;
  const cols = Object.keys(snapshot);
  const vals = Object.values(snapshot);
  const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
  const colList = cols.map((c) => `"${c}"`).join(", ");

  const overriding = (await hasIdentity(client, spec.table)) ? "OVERRIDING SYSTEM VALUE " : "";
  await client.query(`INSERT INTO ${spec.table} (${colList}) ${overriding}VALUES (${placeholders})`, vals);

  // Restaurar alias si existían
  if (spec.aliasTable && Array.isArray(removal.aliases) && removal.aliases.length > 0) {
    const aliasOverriding = (await hasIdentity(client, spec.aliasTable)) ? "OVERRIDING SYSTEM VALUE " : "";
    for (const alias of removal.aliases) {
      const aCols = Object.keys(alias);
      const aVals = Object.values(alias);
      const aPlaceholders = aCols.map((_, i) => `$${i + 1}`).join(", ");
      const aColList = aCols.map((c) => `"${c}"`).join(", ");
      await client.query(`INSERT INTO ${spec.aliasTable} (${aColList}) ${aliasOverriding}VALUES (${aPlaceholders}) ON CONFLICT DO NOTHING`, aVals);
    }
  }

  // Restaurar claims rechazados
  let claimsRestored = 0;
  if (Array.isArray(removal.claimsRejected) && removal.claimsRejected.length > 0) {
    const updated = await client.query(
      `UPDATE ingest.claims SET status='applied', ${spec.targetColumn}=$1, updated_at=now() WHERE id=ANY($2::bigint[])`,
      [removal.id, removal.claimsRejected]);
    claimsRestored = updated.rowCount ?? 0;
  }

  // Si había auditoría en el padre, limpiarla
  if (removal.parentAuditId) {
    await client.query("DELETE FROM ingest.merge_audit_claims WHERE merge_audit_id=$1", [removal.parentAuditId]);
    await client.query("DELETE FROM ingest.merge_audit WHERE id=$1", [removal.parentAuditId]);
  }

  let fieldUndo: unknown;
  if (params["fieldJournal"]) {
    fieldUndo = await undoFieldCorrections(context, runId);
  }

  return {
    runId,
    restored: { kind, id: removal.id },
    claimsRestored,
    ...(fieldUndo ? { fieldUndo } : {}),
  };
}
