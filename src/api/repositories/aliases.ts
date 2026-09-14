// CRV · Escritura directa de alias (PHASES §E8: "editar aliases" en el CRUD).
//
// Los alias viven en el esquema auxiliar `ingest` (F1) y no tienen semántica
// de "valor único canónico" como los campos del core: son un conjunto que
// crece o encoge, sin conflicto que resolver. Por eso esta escritura no pasa
// por `mergeClaim` (pensado para un valor escalar con rivales) sino que
// inserta/actualiza/borra la fila directamente, dentro de la misma
// transacción-run del operador que el resto de E7B (una petición, un run).
import type { PoolClient } from "pg";
import { normalizeEntityName } from "../../normalization/entity-name.js";
import type { OperatorContext } from "../../merge/operator.js";
import { OperatorError } from "../../merge/operator.js";

export type AliasKind = "artist" | "person" | "organization" | "album" | "track";

export interface AliasSpec {
  kind: AliasKind;
  entityTable: string;
  aliasTable: string;
  column: string;
  maxLength: number;
}

export const ALIAS_SPECS: Readonly<Record<AliasKind, AliasSpec>> = {
  artist: { kind: "artist", entityTable: "public.artists", aliasTable: "ingest.artist_aliases", column: "artist_id", maxLength: 200 },
  person: { kind: "person", entityTable: "public.persons", aliasTable: "ingest.person_aliases", column: "person_id", maxLength: 200 },
  organization: { kind: "organization", entityTable: "public.organizations", aliasTable: "ingest.organization_aliases", column: "organization_id", maxLength: 200 },
  album: { kind: "album", entityTable: "public.albums", aliasTable: "ingest.album_aliases", column: "album_id", maxLength: 250 },
  track: { kind: "track", entityTable: "public.tracks", aliasTable: "ingest.track_aliases", column: "track_id", maxLength: 250 },
};

export interface AliasRow {
  id: number;
  entityId: number;
  alias: string;
  aliasType: string;
  isPrimary: boolean;
}

async function assertEntityExists(client: PoolClient, spec: AliasSpec, entityId: number): Promise<void> {
  const { rowCount } = await client.query(`SELECT 1 FROM ${spec.entityTable} WHERE id=$1`, [entityId]);
  if (!rowCount) throw new OperatorError("not_found", `${spec.kind} ${entityId} inexistente`, { entity: spec.kind, id: entityId });
}

async function assertAliasExists(client: PoolClient, spec: AliasSpec, entityId: number, aliasId: number): Promise<void> {
  const { rowCount } = await client.query(`SELECT 1 FROM ${spec.aliasTable} WHERE id=$1 AND ${spec.column}=$2`, [aliasId, entityId]);
  if (!rowCount) throw new OperatorError("not_found", `alias ${aliasId} inexistente en ${spec.kind} ${entityId}`, { entity: spec.kind, id: entityId });
}

/** Deja como no-primario cualquier alias previo del mismo tipo antes de marcar uno nuevo. */
async function demoteExistingPrimary(client: PoolClient, spec: AliasSpec, entityId: number, excludeId?: number): Promise<void> {
  await client.query(
    `UPDATE ${spec.aliasTable} SET is_primary=false WHERE ${spec.column}=$1 AND is_primary=true AND id<>COALESCE($2,-1)`,
    [entityId, excludeId ?? null],
  );
}

export async function createAlias(
  context: OperatorContext, kind: AliasKind, entityId: number,
  input: { alias: string; aliasType: string; isPrimary: boolean },
): Promise<AliasRow> {
  const spec = ALIAS_SPECS[kind];
  await assertEntityExists(context.client, spec, entityId);
  const alias = input.alias.trim();
  if (!alias) throw new OperatorError("invalid", "alias obligatorio");
  if (alias.length > spec.maxLength) throw new OperatorError("invalid", `alias supera los ${spec.maxLength} caracteres`);
  const normalized = normalizeEntityName(alias).primaryKey;
  const duplicate = await context.client.query(
    `SELECT 1 FROM ${spec.aliasTable} WHERE ${spec.column}=$1 AND alias=$2`, [entityId, alias],
  );
  if (duplicate.rowCount) throw new OperatorError("already_exists", `ese alias ya está registrado para este ${spec.kind}`);
  if (input.isPrimary) await demoteExistingPrimary(context.client, spec, entityId);
  const inserted = await context.client.query<{ id: string }>(
    `INSERT INTO ${spec.aliasTable}(${spec.column},alias,alias_type,normalized_alias,is_primary,confidence,source_id,notes)
     VALUES($1,$2,$3::ingest.alias_type,$4,$5,'high',$6,$7)
     RETURNING id::text`,
    [entityId, alias, input.aliasType, normalized, input.isPrimary, context.sourceId, `${context.operator}: ${context.note}`.slice(0, 2000)],
  );
  return { id: Number(inserted.rows[0]!.id), entityId, alias, aliasType: input.aliasType, isPrimary: input.isPrimary };
}

export async function updateAlias(
  context: OperatorContext, kind: AliasKind, entityId: number, aliasId: number,
  input: { alias?: string; aliasType?: string; isPrimary?: boolean },
): Promise<AliasRow> {
  const spec = ALIAS_SPECS[kind];
  await assertEntityExists(context.client, spec, entityId);
  await assertAliasExists(context.client, spec, entityId, aliasId);
  if (input.isPrimary === true) await demoteExistingPrimary(context.client, spec, entityId, aliasId);
  const sets: string[] = [];
  const params: unknown[] = [];
  if (input.alias !== undefined) {
    const alias = input.alias.trim();
    if (!alias) throw new OperatorError("invalid", "alias obligatorio");
    if (alias.length > spec.maxLength) throw new OperatorError("invalid", `alias supera los ${spec.maxLength} caracteres`);
    params.push(alias); sets.push(`alias=$${params.length}`);
    params.push(normalizeEntityName(alias).primaryKey); sets.push(`normalized_alias=$${params.length}`);
  }
  if (input.aliasType !== undefined) { params.push(input.aliasType); sets.push(`alias_type=$${params.length}::ingest.alias_type`); }
  if (input.isPrimary !== undefined) { params.push(input.isPrimary); sets.push(`is_primary=$${params.length}`); }
  if (sets.length === 0) throw new OperatorError("invalid", "no hay campos que cambiar");
  params.push(aliasId, entityId);
  const updated = await context.client.query<{ id: string; alias: string; alias_type: string; is_primary: boolean }>(
    `UPDATE ${spec.aliasTable} SET ${sets.join(",")} WHERE id=$${params.length - 1} AND ${spec.column}=$${params.length}
     RETURNING id::text, alias, alias_type::text, is_primary`,
    params,
  );
  const row = updated.rows[0]!;
  return { id: Number(row.id), entityId, alias: row.alias, aliasType: row.alias_type, isPrimary: row.is_primary };
}

export async function deleteAlias(context: OperatorContext, kind: AliasKind, entityId: number, aliasId: number): Promise<void> {
  const spec = ALIAS_SPECS[kind];
  await assertEntityExists(context.client, spec, entityId);
  await assertAliasExists(context.client, spec, entityId, aliasId);
  await context.client.query(`DELETE FROM ${spec.aliasTable} WHERE id=$1 AND ${spec.column}=$2`, [aliasId, entityId]);
}
