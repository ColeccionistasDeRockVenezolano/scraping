// Correcciones de identidad de personas decididas por el propietario.
//
// La detección de duplicados compara nombres exactos, así que no ve que «Luis
// Barrios» y «Luis "Golding" Barrios» son el mismo guitarrista, que «Car» y
// «los Rondon» son un solo nombre cortado, ni que la persona «Caramelos de
// Cianuro» es la banda. Eso lo decide una persona, y este módulo ejecuta la
// decisión escrita en un plan JSON (docs/decisions/), no una heurística.
//
// Reglas:
//  * EL PLAN NOMBRA LO QUE ESPERA. Cada operación lleva el id y el nombre
//    actual; si la base no coincide, se aborta todo. Aplicado dos veces, lo
//    ya hecho se reconoce y se salta.
//  * UNA SOLA TRANSACCIÓN. O entra el plan entero o nada; `dryRun` lo ejecuta
//    y lo deshace para ver el efecto.
//  * NADA SE PIERDE. Fusionar reutiliza `mergeInto` (reapunta toda FK antes
//    de borrar). Pasar una persona a artista rechaza sus claims de nombre en
//    vez de borrarlos y copia su auditoría a la del artista.
//  * CRÉDITOS EQUIVALENTES SE UNEN. Tras cada operación, los créditos del
//    mismo acreditado en la misma obra con la misma clave de equivalencia
//    (`creditEquivalenceKey`) quedan en uno, auditado.
import { readFile } from "node:fs/promises";
import type { PoolClient } from "pg";
import { z } from "zod";
import { getPool } from "../db/client.js";
import { creditEquivalenceKey, type CreditType } from "../merge/relations.js";
import { normalizeEntityName } from "../normalization/entity-name.js";
import { mergeInto } from "./duplicates.js";

const entityRef = z.object({ id: z.number().int().positive(), name: z.string().min(1) });
const why = z.string().min(1);
const correctionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rename"), person: entityRef, to: z.string().min(1), keepOldNameAsAlias: z.boolean(), why }),
  z.object({ op: z.literal("merge"), keep: entityRef, drop: entityRef, keepDropNameAsAlias: z.boolean(), why }),
  z.object({ op: z.literal("drop_aliases"), person: entityRef, aliases: z.array(z.string().min(1)).min(1), why }),
  z.object({ op: z.literal("to_artist"), person: entityRef, artist: entityRef, keepNameAsAlias: z.boolean().default(false), why }),
  z.object({ op: z.literal("to_organization"), person: entityRef, organization: entityRef, keepNameAsAlias: z.boolean().default(false), why }),
]);
export const personCorrectionPlanSchema = z.object({
  decidedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  evidence: z.string().min(1),
  corrections: z.array(correctionSchema).min(1),
});
export type PersonCorrection = z.infer<typeof correctionSchema>;
export type PersonCorrectionPlan = z.infer<typeof personCorrectionPlanSchema>;

export async function loadPersonCorrectionPlan(path: string): Promise<PersonCorrectionPlan> {
  return personCorrectionPlanSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export interface CorrectionOutcome { op: PersonCorrection["op"]; status: "applied" | "skipped"; detail: string; }
export interface PersonCorrectionResult { dryRun: boolean; runId: number; outcomes: CorrectionOutcome[]; creditsMerged: number; }

const CREDIT_TABLES = [
  { table: "album_credits", kind: "album_credit", parent: "album_id" },
  { table: "track_credits", kind: "track_credit", parent: "track_id" },
] as const;

async function personName(client: PoolClient, id: number): Promise<string | null> {
  return (await client.query<{ name: string }>("SELECT name FROM public.persons WHERE id=$1 FOR UPDATE", [id])).rows[0]?.name ?? null;
}

function expectName(kind: string, ref: { id: number; name: string }, actual: string | null): void {
  if (actual === null) throw new Error(`${kind} ${ref.id} no existe (el plan espera «${ref.name}»)`);
  if (actual !== ref.name) throw new Error(`${kind} ${ref.id} se llama «${actual}», el plan espera «${ref.name}»`);
}

async function audit(
  client: PoolClient, runId: number, entityKind: string, column: string, id: number, field: string,
  oldValue: unknown, newValue: unknown, reason: string, claimIds: number[],
): Promise<void> {
  const row = await client.query<{ id: string }>(`
    INSERT INTO ingest.merge_audit(run_id,entity_kind,${column},field,old_value,new_value,reason,confidence,performed_by)
    VALUES($1,$2::ingest.claim_entity_kind,$3,$4,$5::jsonb,$6::jsonb,$7,'high','human') RETURNING id::text`,
  [runId, entityKind, id, field, JSON.stringify(oldValue), JSON.stringify(newValue), reason]);
  for (const claimId of claimIds.slice(0, 50)) {
    await client.query("INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [Number(row.rows[0]!.id), claimId]);
  }
}

/**
 * Claims que respaldan una fila: los que apuntan a ella y los enlazados a sus
 * auditorías. Lo segundo importa en los créditos de pista acotados por número
 * ("tracks 01, 03"): el claim guarda la FK de la primera pista y las demás
 * filas solo tienen su evidencia a través de la auditoría que las creó.
 */
async function claimIdsFor(client: PoolClient, column: string, id: number): Promise<number[]> {
  return (await client.query<{ id: string }>(`
    SELECT id::text FROM ingest.claims WHERE ${column}=$1
    UNION
    SELECT mac.claim_id::text FROM ingest.merge_audit ma JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id=ma.id WHERE ma.${column}=$1
    ORDER BY 1`, [id])).rows.map((row) => Number(row.id));
}

/**
 * Une los créditos equivalentes de un acreditado. `parents` acota las obras
 * (para un artista, solo aquellas en que la corrección movió algo).
 */
export async function mergeEquivalentCredits(
  client: PoolClient, target: { column: "person_id" | "artist_id" | "organization_id"; id: number }, note: string, runId: number,
  parents?: { album_credits: Set<number>; track_credits: Set<number> },
): Promise<number> {
  let merged = 0;
  for (const spec of CREDIT_TABLES) {
    const { rows } = await client.query<{ id: string; parent: string; credit_type: CreditType; role: string }>(`
      SELECT id::text, ${spec.parent}::text AS parent, credit_type::text AS credit_type, role
        FROM public.${spec.table} WHERE ${target.column}=$1 ORDER BY id`, [target.id]);
    const groups = new Map<string, number[]>();
    for (const row of rows) {
      if (parents && !parents[spec.table].has(Number(row.parent))) continue;
      const key = `${row.parent}|${creditEquivalenceKey(row.credit_type, row.role)}`;
      groups.set(key, [...(groups.get(key) ?? []), Number(row.id)]);
    }
    for (const ids of groups.values()) {
      for (const dropId of ids.slice(1)) {
        await mergeInto(client, spec.kind, ids[0]!, dropId, note, runId, { alias: false });
        merged += 1;
      }
    }
  }
  return merged;
}

async function applyOne(client: PoolClient, correction: PersonCorrection, note: string, runId: number): Promise<CorrectionOutcome & { credits: number }> {
  const reason = `${note} — ${correction.why}`;
  switch (correction.op) {
    case "rename": {
      const actual = await personName(client, correction.person.id);
      if (actual === correction.to) return { op: "rename", status: "skipped", detail: `persona ${correction.person.id} ya se llama «${correction.to}»`, credits: 0 };
      expectName("persona", correction.person, actual);
      await client.query("UPDATE public.persons SET name=$2, updated_at=now() WHERE id=$1", [correction.person.id, correction.to]);
      if (correction.keepOldNameAsAlias) {
        await client.query(`
          INSERT INTO ingest.person_aliases(person_id,alias,alias_type,normalized_alias,is_primary,confidence,notes)
          VALUES($1,$2,'name_variant',$3,false,'high','Nombre anterior a una corrección del propietario') ON CONFLICT DO NOTHING`,
        [correction.person.id, correction.person.name, normalizeEntityName(correction.person.name).primaryKey]);
      }
      await audit(client, runId, "person", "person_id", correction.person.id, "name", correction.person.name, correction.to, reason, await claimIdsFor(client, "person_id", correction.person.id));
      const credits = await mergeEquivalentCredits(client, { column: "person_id", id: correction.person.id }, reason, runId);
      return { op: "rename", status: "applied", detail: `«${correction.person.name}» → «${correction.to}»`, credits };
    }
    case "merge": {
      const keep = await personName(client, correction.keep.id);
      const drop = await personName(client, correction.drop.id);
      if (drop === null && keep === correction.keep.name) return { op: "merge", status: "skipped", detail: `persona ${correction.drop.id} ya fusionada en ${correction.keep.id}`, credits: 0 };
      expectName("persona", correction.keep, keep);
      expectName("persona", correction.drop, drop);
      const outcome = await mergeInto(client, "person", correction.keep.id, correction.drop.id, reason, runId, { alias: correction.keepDropNameAsAlias });
      const credits = await mergeEquivalentCredits(client, { column: "person_id", id: correction.keep.id }, reason, runId);
      return { op: "merge", status: "applied", detail: `«${correction.drop.name}» (${correction.drop.id}) → «${correction.keep.name}» (${correction.keep.id}); ${outcome.moved} referencias movidas`, credits };
    }
    case "drop_aliases": {
      expectName("persona", correction.person, await personName(client, correction.person.id));
      const deleted = await client.query<{ alias: string }>("DELETE FROM ingest.person_aliases WHERE person_id=$1 AND alias=ANY($2::text[]) RETURNING alias", [correction.person.id, correction.aliases]);
      if (deleted.rowCount === 0) return { op: "drop_aliases", status: "skipped", detail: `persona ${correction.person.id} ya no tiene esos alias`, credits: 0 };
      const removed = deleted.rows.map((row) => row.alias);
      await audit(client, runId, "person", "person_id", correction.person.id, "aliases", removed, null, reason, await claimIdsFor(client, "person_id", correction.person.id));
      return { op: "drop_aliases", status: "applied", detail: `alias retirados de ${correction.person.id}: ${removed.join(", ")}`, credits: 0 };
    }
    case "to_artist":
      return absorbPerson(client, correction.op, correction.person, correction.artist, ABSORBERS.artist, correction.keepNameAsAlias, reason, runId);
    case "to_organization":
      return absorbPerson(client, correction.op, correction.person, correction.organization, ABSORBERS.organization, correction.keepNameAsAlias, reason, runId);
  }
}

const ABSORBERS = {
  artist: { table: "artists", column: "artist_id", entityKind: "artist", aliasTable: "ingest.artist_aliases", label: "artista" },
  organization: { table: "organizations", column: "organization_id", entityKind: "organization", aliasTable: "ingest.organization_aliases", label: "organización" },
} as const;

/**
 * Una «persona» que en realidad es un artista o una organización: sus
 * créditos pasan al destino, sus claims de nombre se rechazan (nunca se
 * borran) y la historia de la ficha se copia a la auditoría del destino.
 */
async function absorbPerson(
  client: PoolClient, op: "to_artist" | "to_organization", ref: { id: number; name: string }, targetRef: { id: number; name: string },
  target: (typeof ABSORBERS)[keyof typeof ABSORBERS], keepNameAsAlias: boolean, reason: string, runId: number,
): Promise<CorrectionOutcome & { credits: number }> {
  const person = (await client.query<Record<string, unknown>>("SELECT * FROM public.persons WHERE id=$1 FOR UPDATE", [ref.id])).rows[0];
  const targetName = (await client.query<{ name: string }>(`SELECT name FROM public.${target.table} WHERE id=$1`, [targetRef.id])).rows[0]?.name ?? null;
  expectName(target.label, targetRef, targetName);
  if (!person) return { op, status: "skipped", detail: `persona ${ref.id} ya no existe`, credits: 0 };
  expectName("persona", ref, String(person["name"]));
  const parents = { album_credits: new Set<number>(), track_credits: new Set<number>() };
  let converted = 0;
  for (const spec of CREDIT_TABLES) {
    const { rows } = await client.query<{ id: string; parent: string }>(
      `SELECT id::text, ${spec.parent}::text AS parent FROM public.${spec.table} WHERE person_id=$1 ORDER BY id`, [ref.id]);
    for (const row of rows) {
      await client.query(`UPDATE public.${spec.table} SET person_id=NULL, ${target.column}=$2 WHERE id=$1`, [row.id, targetRef.id]);
      await audit(client, runId, spec.kind, `${spec.kind}_id`, Number(row.id), "credited",
        { person_id: ref.id, name: ref.name }, { [target.column]: targetRef.id, name: targetRef.name },
        reason, await claimIdsFor(client, `${spec.kind}_id`, Number(row.id)));
      parents[spec.table].add(Number(row.parent));
      converted += 1;
    }
  }
  if (keepNameAsAlias && ref.name !== targetRef.name) {
    await client.query(`
      INSERT INTO ${target.aliasTable}(${target.column},alias,alias_type,normalized_alias,is_primary,confidence,notes)
      VALUES($1,$2,'name_variant',$3,false,'high','Nombre con que una fuente lo acreditó como persona') ON CONFLICT DO NOTHING`,
    [targetRef.id, ref.name, normalizeEntityName(ref.name).primaryKey]);
  }
  const nameClaims = await claimIdsFor(client, "person_id", ref.id);
  await client.query(`
    UPDATE ingest.claims SET person_id=NULL, status='rejected', updated_at=now(),
           notes=concat_ws(' · ', notes, $2::text)
     WHERE person_id=$1`, [ref.id, `no es una persona: es ${target.label} ${targetRef.name} (${targetRef.id})`]);
  const history = (await client.query("SELECT * FROM ingest.merge_audit WHERE person_id=$1 ORDER BY id", [ref.id])).rows;
  await audit(client, runId, target.entityKind, target.column, targetRef.id, "absorbed_person", { person, audits: history },
    { [target.column]: targetRef.id, creditsConverted: converted }, reason, nameClaims);
  await client.query("DELETE FROM public.persons WHERE id=$1", [ref.id]);
  const credits = await mergeEquivalentCredits(client, { column: target.column, id: targetRef.id }, reason, runId, parents);
  return { op, status: "applied", detail: `«${ref.name}» (${ref.id}) → ${target.label} «${targetRef.name}»; ${converted} créditos pasados, ${nameClaims.length} claims de nombre rechazados`, credits };
}

export async function applyPersonCorrections(plan: PersonCorrectionPlan, note: string, options: { dryRun?: boolean } = {}): Promise<PersonCorrectionResult> {
  if (!note.trim()) throw new Error("nota obligatoria para corregir personas");
  const dryRun = options.dryRun ?? false;
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind,status,params) VALUES('merge_run','running',$1::jsonb) RETURNING id::text`,
    [JSON.stringify({ action: "person_corrections", decidedAt: plan.decidedAt, evidence: plan.evidence, note, dryRun })]);
    const runId = Number(run.rows[0]!.id);
    const result: PersonCorrectionResult = { dryRun, runId, outcomes: [], creditsMerged: 0 };
    for (const correction of plan.corrections) {
      const { credits, ...outcome } = await applyOne(client, correction, note, runId);
      result.outcomes.push(outcome);
      result.creditsMerged += credits;
    }
    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1",
      [runId, JSON.stringify({ applied: result.outcomes.filter((item) => item.status === "applied").length, skipped: result.outcomes.filter((item) => item.status === "skipped").length, creditsMerged: result.creditsMerged })]);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
