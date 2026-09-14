// Retiros auditados del core: borrar una entidad o una fila puente por
// decisión de una persona.
//
// Tres reglas:
//
//  * NO SE BORRA EN CASCADA. El DDL encadena ON DELETE CASCADE (artista →
//    discos → pistas → créditos, y también los enlaces de YouTube). Un retiro
//    con dependientes en `public` o `media` se niega y dice cuáles son: quien
//    lo pide retira primero lo que cuelga, a sabiendas. Los dependientes se
//    descubren en el catálogo, así que una tabla nueva no queda fuera.
//  * LA HISTORIA NO SE PIERDE. `merge_audit` cuelga de la fila con ON DELETE
//    CASCADE; antes de borrar, la fila, sus alias y su auditoría completa se
//    copian a la ficha de la que colgaba (el artista del disco, el disco de la
//    pista, la entidad padre de la relación) y se devuelven para el run.
//  * LOS CLAIMS NO SE BORRAN. Pierden su destino y quedan `rejected` con una
//    nota que nombra el run; su evidencia sigue consultable.
import type { PoolClient } from "pg";
import { ENTITY_SPECS, type ResolvableClaimKind } from "./specs.js";
import { RELATION_SPECS, type RelationClaimKind } from "./relations.js";

export interface Dependent {
  table: string;
  column: string;
  rows: number;
}

export class DependentsError extends Error {
  constructor(readonly entityKind: string, readonly entityId: number, readonly dependents: Dependent[]) {
    super(`${entityKind} ${entityId} no se retira: ${dependents.map((item) => `${item.rows} en ${item.table}.${item.column}`).join(", ")}`);
  }
}

export interface RemovalResult {
  kind: ResolvableClaimKind | RelationClaimKind;
  id: number;
  snapshot: Record<string, unknown>;
  aliases: Array<Record<string, unknown>>;
  history: Array<Record<string, unknown>>;
  claimsRejected: number[];
  /** Fila de merge_audit en la ficha padre que guarda la historia, si la hay. */
  parentAuditId?: number;
}

const PARENT_OF_ENTITY: Partial<Record<ResolvableClaimKind, { kind: "artist" | "album"; column: "artist_id" | "album_id" }>> = {
  album: { kind: "artist", column: "artist_id" },
  track: { kind: "album", column: "album_id" },
};

async function dependents(client: PoolClient, table: string, id: number): Promise<Dependent[]> {
  const { rows: refs } = await client.query<{ table: string; column: string }>(`
    SELECT c.conrelid::regclass::text AS table, a.attname AS column
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=ANY(c.conkey)
     WHERE c.contype='f' AND c.confrelid=$1::regclass
       AND c.connamespace IN ('public'::regnamespace, 'media'::regnamespace)
     ORDER BY 1,2`, [table]);
  const found: Dependent[] = [];
  for (const ref of refs) {
    const counted = await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${ref.table} WHERE "${ref.column}"=$1`, [id]);
    const rows = counted.rows[0]?.n ?? 0;
    if (rows > 0) found.push({ table: ref.table, column: ref.column, rows });
  }
  return found;
}

/** Claims que respaldan la fila: los que la apuntan y los enlazados a su auditoría. */
async function evidenceClaims(client: PoolClient, column: string, id: number): Promise<number[]> {
  const { rows } = await client.query<{ id: string }>(`
    SELECT id::text FROM ingest.claims WHERE ${column}=$1
    UNION
    SELECT mac.claim_id::text FROM ingest.merge_audit ma JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id=ma.id WHERE ma.${column}=$1
    ORDER BY 1`, [id]);
  return rows.map((row) => Number(row.id));
}

async function retire(
  client: PoolClient,
  input: {
    kind: ResolvableClaimKind | RelationClaimKind; table: string; column: string; id: number;
    aliasTable?: string; parent?: { kind: string; column: string }; note: string; runId: number;
  },
): Promise<RemovalResult | null> {
  const loaded = await client.query<Record<string, unknown>>(`SELECT * FROM ${input.table} WHERE id=$1 FOR UPDATE`, [input.id]);
  const snapshot = loaded.rows[0];
  if (!snapshot) return null;
  const blocking = await dependents(client, input.table, input.id);
  if (blocking.length) throw new DependentsError(input.kind, input.id, blocking);

  const aliases = input.aliasTable
    ? (await client.query<Record<string, unknown>>(`SELECT * FROM ${input.aliasTable} WHERE ${input.column}=$1 ORDER BY id`, [input.id])).rows
    : [];
  const history = (await client.query<Record<string, unknown>>(`SELECT * FROM ingest.merge_audit WHERE ${input.column}=$1 ORDER BY id`, [input.id])).rows;
  const linked = await evidenceClaims(client, input.column, input.id);
  const reason = `retirado por una persona (run ${input.runId}): ${input.note}`;
  const rejected = await client.query<{ id: string }>(`
    UPDATE ingest.claims SET ${input.column}=NULL,status='rejected',updated_at=now(),notes=concat_ws(' · ',notes,$2::text)
     WHERE ${input.column}=$1 RETURNING id::text`, [input.id, reason]);

  let parentAuditId: number | undefined;
  const parentId = input.parent ? snapshot[input.parent.column] : undefined;
  if (input.parent && parentId !== null && parentId !== undefined) {
    const saved = await client.query<{ id: string }>(`
      INSERT INTO ingest.merge_audit(run_id,entity_kind,${input.parent.kind}_id,field,old_value,new_value,reason,confidence,performed_by)
      VALUES($1,$2::ingest.claim_entity_kind,$3,$4,$5::jsonb,NULL,$6,'high','human') RETURNING id::text`,
    [input.runId, input.parent.kind, Number(parentId), `removed_${input.kind}`, JSON.stringify({ row: snapshot, aliases, audits: history }), reason]);
    parentAuditId = Number(saved.rows[0]!.id);
    for (const claimId of linked.slice(0, 50)) {
      await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [parentAuditId, claimId]);
    }
  }
  await client.query(`DELETE FROM ${input.table} WHERE id=$1`, [input.id]);
  return {
    kind: input.kind, id: input.id, snapshot, aliases, history,
    claimsRejected: rejected.rows.map((row) => Number(row.id)),
    ...(parentAuditId === undefined ? {} : { parentAuditId }),
  };
}

/** Retira una entidad sin dependientes. `null` si ya no existe. */
export async function removeEntity(
  client: PoolClient, kind: ResolvableClaimKind, id: number, options: { note: string; runId: number },
): Promise<RemovalResult | null> {
  if (!options.note.trim()) throw new Error("nota obligatoria para retirar una entidad");
  const spec = ENTITY_SPECS[kind];
  const parent = PARENT_OF_ENTITY[kind];
  return retire(client, {
    kind, table: spec.table, column: spec.targetColumn, id, aliasTable: spec.aliasTable,
    ...(parent === undefined ? {} : { parent }), note: options.note, runId: options.runId,
  });
}

/** Retira una fila puente; su historia pasa a la entidad de la que colgaba. */
export async function removeRelation(
  client: PoolClient, kind: RelationClaimKind, id: number, options: { note: string; runId: number },
): Promise<RemovalResult | null> {
  if (!options.note.trim()) throw new Error("nota obligatoria para retirar una relación");
  const spec = RELATION_SPECS[kind];
  return retire(client, {
    kind, table: spec.table, column: spec.column, id, parent: spec.parent, note: options.note, runId: options.runId,
  });
}
