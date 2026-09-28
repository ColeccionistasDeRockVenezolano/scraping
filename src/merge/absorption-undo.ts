// CRV · Deshacer una conversión: la «persona» que resultó ser un artista o
// una organización vuelve a ser persona.
//
// `absorbPerson` (review/person-corrections.ts) pasó sus créditos al destino,
// rechazó sus claims de nombre, copió su historia a la auditoría del destino
// y borró la ficha. Todo eso queda en una sola fila de `ingest.merge_audit`
// (`absorbed_person`) con la persona entera, más una fila `credited` por
// crédito movido: con eso se deshace exacto, sin adivinar.
//
// SOLO SE DESHACE LO QUE SE PUEDE DESHACER SIN MENTIR: si un crédito
// convertido ya no existe (otra fusión lo unificó después) o ya no está en el
// destino, no se toca nada y se dice qué cambio hay que deshacer primero.
import type { PoolClient } from "pg";
import { OperatorError, type OperatorContext } from "./operator.js";
import { hasIdentity } from "./unmerge.js";

/** Destino de una absorción: dónde quedaron los créditos de la persona. */
const TARGETS = {
  artist: { column: "artist_id", table: "public.artists", aliasTable: "ingest.artist_aliases", label: "artista" },
  organization: { column: "organization_id", table: "public.organizations", aliasTable: "ingest.organization_aliases", label: "organización" },
} as const;

type TargetKind = keyof typeof TARGETS;

const CREDIT_TABLES = {
  album_credit: "public.album_credits",
  track_credit: "public.track_credits",
} as const;

export interface AbsorptionUndoResult {
  auditId: number;
  /** Persona que vuelve al catálogo. */
  personId: number;
  personName: string;
  target: { kind: TargetKind; id: number };
  creditsReturned: number;
  claimsRestored: number;
  aliasesRemoved: number;
}

interface AbsorptionAudit {
  id: string;
  run_id: string;
  entity_kind: TargetKind;
  target_id: string;
  old_value: { person?: Record<string, unknown> } | null;
  new_value: Record<string, unknown> | null;
  reason: string | null;
}

interface CreditedAudit {
  id: string;
  kind: keyof typeof CREDIT_TABLES;
  credit_id: string;
}

async function loadAbsorption(client: PoolClient, auditId: number): Promise<AbsorptionAudit> {
  const { rows } = await client.query<AbsorptionAudit>(`
    SELECT id::text, run_id::text, entity_kind::text AS entity_kind,
           COALESCE(artist_id, organization_id)::text AS target_id, old_value, new_value, reason
      FROM ingest.merge_audit WHERE id=$1 AND field='absorbed_person'`, [auditId]);
  const audit = rows[0];
  if (!audit) throw new OperatorError("not_found", `la conversión #${auditId} no existe`, { auditId });
  if (!(audit.entity_kind in TARGETS) || !audit.target_id) {
    throw new OperatorError("invalid", `la conversión #${auditId} no dice a qué ficha pasó la persona`, { auditId });
  }
  if (!audit.old_value?.person?.["id"]) {
    throw new OperatorError("invalid", `la conversión #${auditId} no guardó la persona: no se puede devolver`, { auditId });
  }
  return audit;
}

/** Créditos que esa conversión movió, según sus filas `credited` del mismo run. */
async function convertedCredits(client: PoolClient, audit: AbsorptionAudit, personId: number): Promise<CreditedAudit[]> {
  const { rows } = await client.query<CreditedAudit>(`
    SELECT id::text, entity_kind::text AS kind, COALESCE(album_credit_id, track_credit_id)::text AS credit_id
      FROM ingest.merge_audit
     WHERE run_id=$1 AND field='credited' AND (old_value->>'person_id')::bigint=$2
       AND entity_kind IN ('album_credit','track_credit')
     ORDER BY id`, [Number(audit.run_id), personId]);
  return rows;
}

/** Quién se llevó por delante la fila que hay que devolver (para decir qué deshacer primero). */
async function whoMerged(client: PoolClient, kind: keyof typeof CREDIT_TABLES, creditId: number): Promise<string> {
  const { rows } = await client.query<{ id: string; run_id: string }>(`
    SELECT id::text, run_id::text FROM ingest.merge_audit
     WHERE field='merged_duplicate' AND entity_kind=$1::ingest.claim_entity_kind AND (old_value->>'id')::bigint=$2
     ORDER BY id DESC LIMIT 1`, [kind, creditId]);
  const row = rows[0];
  return row ? ` (lo unificó la fusión #${row.id}, cambio #${row.run_id}: deshaz esa primero)` : "";
}

/**
 * Deshace una conversión dentro de la transacción del operador. La persona
 * vuelve con su id, sus créditos regresan a ella y sus claims de nombre
 * dejan de estar rechazados.
 */
export async function undoAbsorption(context: OperatorContext, auditId: number): Promise<AbsorptionUndoResult> {
  const client = context.client;
  const audit = await loadAbsorption(client, auditId);
  const target = TARGETS[audit.entity_kind];
  const targetId = Number(audit.target_id);
  const person = audit.old_value!.person!;
  const personId = Number(person["id"]);
  const personName = String(person["name"] ?? "");

  // 1. Precondiciones: nadie ocupa el id y el destino sigue ahí.
  const taken = await client.query("SELECT 1 FROM public.persons WHERE id=$1", [personId]);
  if (taken.rowCount) {
    throw new OperatorError("not_open", `la persona ${personId} volvió a existir: esta conversión ya está deshecha`, { auditId, personId });
  }
  const targetExists = await client.query(`SELECT 1 FROM ${target.table} WHERE id=$1`, [targetId]);
  if (!targetExists.rowCount) {
    throw new OperatorError("not_open",
      `${target.label} ${targetId} ya no existe (se fusionó después): deshaz esa fusión antes`, { auditId, targetId });
  }

  // 2. Cada crédito convertido sigue existiendo y sigue en el destino.
  const credits = await convertedCredits(client, audit, personId);
  for (const credit of credits) {
    const table = CREDIT_TABLES[credit.kind];
    const { rows } = await client.query<{ target: string | null; person: string | null }>(
      `SELECT ${target.column}::text AS target, person_id::text AS person FROM ${table} WHERE id=$1`, [Number(credit.credit_id)]);
    const row = rows[0];
    if (!row) {
      throw new OperatorError("not_open",
        `el crédito ${credit.credit_id} que esta conversión movió ya no existe${await whoMerged(client, credit.kind, Number(credit.credit_id))}`,
        { auditId, creditId: Number(credit.credit_id) });
    }
    if (row.target === null || Number(row.target) !== targetId) {
      throw new OperatorError("not_open",
        `el crédito ${credit.credit_id} ya no está acreditado a ${target.label} ${targetId}: cambió después de la conversión`,
        { auditId, creditId: Number(credit.credit_id) });
    }
  }

  // 3. La persona vuelve tal cual estaba (con su id).
  const overriding = await hasIdentity(client, "public.persons") ? "OVERRIDING SYSTEM VALUE " : "";
  await client.query(
    `INSERT INTO public.persons ${overriding}SELECT * FROM jsonb_populate_record(NULL::public.persons, $1::jsonb)`,
    [JSON.stringify(person)]);

  // 4. Sus créditos regresan a ella.
  for (const credit of credits) {
    await client.query(
      `UPDATE ${CREDIT_TABLES[credit.kind]} SET person_id=$1, ${target.column}=NULL WHERE id=$2 AND ${target.column}=$3`,
      [personId, Number(credit.credit_id), targetId]);
  }

  // 5. El alias que la conversión dejó en el destino se retira.
  const aliasRemoved = await client.query(
    `DELETE FROM ${target.aliasTable} WHERE ${target.column}=$1 AND alias=$2 AND notes='Nombre con que una fuente lo acreditó como persona'`,
    [targetId, personName]);

  // 6. Los claims que quedaron rechazados por no ser persona vuelven a serlo.
  //    La nota que les puso la conversión los identifica una a una.
  const claims = await client.query(`
    UPDATE ingest.claims
       SET person_id=$1, status='accepted', updated_at=now(),
           -- La conversión la añadió con concat_ws: si el claim no tenía notas,
           -- la nota quedó sola, sin el separador ' · '.
           notes=NULLIF(regexp_replace(notes, '( · )?no es una persona: es [^·]*$', ''), '')
     WHERE person_id IS NULL AND status='rejected' AND id IN (
       SELECT claim_id FROM ingest.merge_audit_claims WHERE merge_audit_id=$2)`, [personId, Number(audit.id)]);

  // 7. El rastro del deshacer, con la misma evidencia que probaba la conversión.
  const saved = await client.query<{ id: string }>(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,person_id,field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,'person',$2,'unabsorbed_person',$3::jsonb,$4::jsonb,$5,'high','human') RETURNING id::text`,
  [context.runId, personId,
    JSON.stringify({ undoneAuditId: Number(audit.id), target: { kind: audit.entity_kind, id: targetId }, credits: credits.length }),
    JSON.stringify({ person_id: personId }),
    `deshacer la conversión #${audit.id} del cambio #${audit.run_id}: ${context.note}`]);
  await client.query(
    "INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) SELECT $1, claim_id FROM ingest.merge_audit_claims WHERE merge_audit_id=$2 ON CONFLICT DO NOTHING",
    [Number(saved.rows[0]!.id), Number(audit.id)]);

  return {
    auditId,
    personId,
    personName,
    target: { kind: audit.entity_kind, id: targetId },
    creditsReturned: credits.length,
    claimsRestored: claims.rowCount ?? 0,
    aliasesRemoved: aliasRemoved.rowCount ?? 0,
  };
}
