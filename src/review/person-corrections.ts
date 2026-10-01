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
import { getEnv } from "../config/env.js";
import { getPool } from "../db/client.js";
import { mergeEquivalentCredits } from "../merge/equivalent-relations.js";
import { mergeAlbums, previewAlbumMerge } from "../merge/album-merge.js";
import { mergeEntityRows } from "../merge/entity-merge.js";
import { createEntity, OperatorError, OPERATOR_SOURCE_SLUG, type OperatorContext } from "../merge/operator.js";
import { resolveRedirect } from "../merge/redirects.js";
import { creditEquivalenceKey, type CreditType } from "../merge/relations.js";
import { removeEntity } from "../merge/removals.js";
import { normalizeEntityName } from "../normalization/entity-name.js";
import { invalidateSearchIndex } from "../api/search-index.js";
import { deriveVenezuelanFor } from "../merge/venezuelan.js";

// La unificación de relaciones equivalentes vive en merge/equivalent-relations.ts
// (la comparten la API y la corrección por plan). Se re-exporta para no romper
// los imports existentes.
export { mergeEquivalentCredits };

const entityRef = z.object({ id: z.number().int().positive(), name: z.string().min(1) });
const why = z.string().min(1);
const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const correctionSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("rename"), person: entityRef, to: z.string().min(1), keepOldNameAsAlias: z.boolean(), why }),
  z.object({ op: z.literal("merge"), keep: entityRef, drop: entityRef, keepDropNameAsAlias: z.boolean(), why }),
  z.object({ op: z.literal("drop_aliases"), person: entityRef, aliases: z.array(z.string().min(1)).min(1), why }),
  z.object({ op: z.literal("to_artist"), person: entityRef, artist: entityRef, keepNameAsAlias: z.boolean().default(false), why }),
  z.object({ op: z.literal("to_organization"), person: entityRef, organization: entityRef, keepNameAsAlias: z.boolean().default(false), why }),
  // Una fila que en realidad son varias personas (E11.7): cada nombre del
  // plan recibe copia de créditos y membresías, y la fila combinada se retira.
  z.object({ op: z.literal("split"), person: entityRef, into: z.array(z.string().min(1)).min(2), why }),
  // Identidad persona ↔ proyecto (Brian, 2026-09-30, caso Ashwave): el artista
  // es el proyecto o nombre artístico de la persona. No se fusionan fichas de
  // tipos distintos: la persona queda como titular (membresía) del artista.
  z.object({ op: z.literal("link_project"), person: entityRef, artist: entityRef, role: z.string().min(1).default("Titular del proyecto"), why }),
  z.object({ op: z.literal("add_alias"), person: entityRef, alias: z.string().min(1), why }),
  // Fallecido/a (Brian, 2026-09-30, caso Canserbero): la cruz «(†)» deja de
  // ir en el nombre y pasa a `persons.is_deceased`. `cleanName` retira la
  // marca del nombre en el mismo paso.
  z.object({ op: z.literal("mark_deceased"), person: entityRef, cleanName: z.string().min(1).optional(), deathDate: isoDay.optional(), birthDate: isoDay.optional(), why }),
  // Fechas de nacimiento/fallecimiento que dan las fuentes (Brian, 2026-09-30):
  // solo rellena lo que esté vacío; nunca pisa una fecha ya guardada.
  z.object({ op: z.literal("set_dates"), person: entityRef, birthDate: isoDay.optional(), deathDate: isoDay.optional(), why }),
  // Un artista que es una persona (solista) sin ficha de persona: se crea la
  // persona con ese nombre, titular del proyecto, y si murió, se marca.
  z.object({ op: z.literal("create_titular"), name: z.string().min(1), artist: entityRef, role: z.string().min(1).default("Titular del proyecto"),
    deceased: z.boolean().default(false), birthDate: isoDay.optional(), deathDate: isoDay.optional(), why }),
  // Disco de «participación» duplicado del real (p. ej. el índice de una
  // persona en Sincopa): sus pistas, créditos y enlaces pasan al que queda.
  z.object({ op: z.literal("merge_albums"), keep: entityRef, drop: entityRef, why }),
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

/** Tablas de crédito que una conversión (persona → artista/organización) reapunta. */
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
  // Sin recorte: hay fichas con más de 150 claims y la auditoría llegaba al
  // tope de 50, dejando fuera evidencia real (P4).
  await client.query(
    "INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) SELECT $1, unnest($2::bigint[]) ON CONFLICT DO NOTHING",
    [Number(row.rows[0]!.id), claimIds]);
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
      // Las mismas piezas que el servicio de fusión de la API (E11.3):
      // mergeInto + créditos y membresías equivalentes (P7).
      const merged = await mergeEntityRows(client, "person", correction.keep.id, correction.drop.id, reason, runId, correction.keepDropNameAsAlias);
      return { op: "merge", status: "applied", detail: `«${correction.drop.name}» (${correction.drop.id}) → «${correction.keep.name}» (${correction.keep.id}); ${merged.moved} referencias movidas, ${merged.membershipsMerged} membresías unidas, ${merged.membershipReviewsOpened} revisiones de período`, credits: merged.creditsMerged };
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
    case "split":
      return splitPerson(client, correction.person.id, correction.into, reason, runId, correction.person.name);
    case "link_project":
      return linkProject(client, correction.person, correction.artist, correction.role, reason, runId);
    case "add_alias": {
      expectName("persona", correction.person, await personName(client, correction.person.id));
      const key = normalizeEntityName(correction.alias).primaryKey;
      const inserted = await client.query(`
        INSERT INTO ingest.person_aliases(person_id,alias,alias_type,normalized_alias,is_primary,confidence,notes)
        SELECT $1::bigint,$2::text,'name_variant',$3::text,false,'high','Alias añadido por una corrección del propietario'
         WHERE NOT EXISTS (SELECT 1 FROM ingest.person_aliases WHERE person_id=$1::bigint AND (alias=$2::text OR normalized_alias=$3::text))
           AND lower(btrim((SELECT name FROM public.persons WHERE id=$1::bigint)))<>lower(btrim($2::text))`,
      [correction.person.id, correction.alias, key]);
      if (inserted.rowCount === 0) return { op: "add_alias", status: "skipped", detail: `persona ${correction.person.id} ya responde a «${correction.alias}»`, credits: 0 };
      await audit(client, runId, "person", "person_id", correction.person.id, "aliases", null, [correction.alias], reason, await claimIdsFor(client, "person_id", correction.person.id));
      return { op: "add_alias", status: "applied", detail: `alias «${correction.alias}» para ${correction.person.id}`, credits: 0 };
    }
    case "mark_deceased": {
      const row = (await client.query<{ name: string; is_deceased: boolean | null }>(
        "SELECT name, is_deceased FROM public.persons WHERE id=$1 FOR UPDATE", [correction.person.id])).rows[0];
      const target = correction.cleanName ?? correction.person.name;
      if (row && row.is_deceased === true && row.name === target && !(await datesPending(client, correction.person.id, correction.birthDate, correction.deathDate))) {
        return { op: "mark_deceased", status: "skipped", detail: `persona ${correction.person.id} ya figura como fallecida`, credits: 0 };
      }
      // El nombre puede ser el del plan o ya el limpio (a medias de una corrida anterior).
      expectName("persona", { id: correction.person.id, name: row?.name === target ? target : correction.person.name }, row?.name ?? null);
      const claims = await claimIdsFor(client, "person_id", correction.person.id);
      if (row!.is_deceased !== true) {
        await client.query("UPDATE public.persons SET is_deceased=true, updated_at=now() WHERE id=$1", [correction.person.id]);
        await audit(client, runId, "person", "person_id", correction.person.id, "is_deceased", row!.is_deceased, true, reason, claims);
      }
      if (row!.name !== target) {
        await client.query("UPDATE public.persons SET name=$2, updated_at=now() WHERE id=$1", [correction.person.id, target]);
        await audit(client, runId, "person", "person_id", correction.person.id, "name", row!.name, target, reason, claims);
      }
      const dated = await writeDates(client, runId, correction.person.id, correction.birthDate, correction.deathDate, reason, claims);
      const credits = await mergeEquivalentCredits(client, { column: "person_id", id: correction.person.id }, reason, runId);
      return { op: "mark_deceased", status: "applied", detail: `${target} (${correction.person.id}) marcado fallecido${row!.name !== target ? `; nombre «${row!.name}» → «${target}»` : ""}${dated.length ? `; ${dated.join(", ")}` : ""}`, credits };
    }
    case "set_dates": {
      expectName("persona", correction.person, await personName(client, correction.person.id));
      const dated = await writeDates(client, runId, correction.person.id, correction.birthDate, correction.deathDate, reason, await claimIdsFor(client, "person_id", correction.person.id));
      return dated.length === 0
        ? { op: "set_dates", status: "skipped", detail: `persona ${correction.person.id} ya tiene esas fechas (o otras distintas, que no se pisan)`, credits: 0 }
        : { op: "set_dates", status: "applied", detail: `${correction.person.name} (${correction.person.id}): ${dated.join(", ")}`, credits: 0 };
    }
    case "create_titular":
      return createTitular(client, correction, reason, runId);
    case "merge_albums": {
      const titles = (await client.query<{ id: string; title: string }>(
        "SELECT id::text, title FROM public.albums WHERE id = ANY($1::bigint[])", [[correction.keep.id, correction.drop.id]])).rows;
      const keep = titles.find((row) => Number(row.id) === correction.keep.id)?.title ?? null;
      const drop = titles.find((row) => Number(row.id) === correction.drop.id)?.title ?? null;
      if (drop === null && keep === correction.keep.name) return { op: "merge_albums", status: "skipped", detail: `disco ${correction.drop.id} ya fusionado en ${correction.keep.id}`, credits: 0 };
      if (keep === null) throw new Error(`disco ${correction.keep.id} no existe (el plan espera «${correction.keep.name}»)`);
      if (drop === null) throw new Error(`disco ${correction.drop.id} no existe (el plan espera «${correction.drop.name}»)`);
      if (keep !== correction.keep.name) throw new Error(`disco ${correction.keep.id} se llama «${keep}», el plan espera «${correction.keep.name}»`);
      if (drop !== correction.drop.name) throw new Error(`disco ${correction.drop.id} se llama «${drop}», el plan espera «${correction.drop.name}»`);
      const context = await planOperatorContext(client, runId, reason);
      const preview = await previewAlbumMerge(client, correction.keep.id, correction.drop.id, { lock: true });
      const merged = await mergeAlbums(context, { keepId: correction.keep.id, dropId: correction.drop.id, previewHash: preview.previewHash, keepDropNameAsAlias: false });
      return { op: "merge_albums", status: "applied", detail: `«${correction.drop.name}» (${correction.drop.id}) → «${correction.keep.name}» (${correction.keep.id}); ${merged.tracksMerged} pistas unidas, ${merged.tracksMoved} movidas`, credits: merged.creditsMerged };
    }
  }
}

/** ¿Falta escribir alguna de las fechas pedidas? */
async function datesPending(client: PoolClient, id: number, birth?: string, death?: string): Promise<boolean> {
  const row = (await client.query<{ birth_date: string | null; death_date: string | null }>(
    "SELECT birth_date::text, death_date::text FROM public.persons WHERE id=$1", [id])).rows[0];
  return Boolean(row && ((birth && row.birth_date === null) || (death && row.death_date === null)));
}

/**
 * Escribe nacimiento y fallecimiento solo donde la columna esté vacía (nunca
 * pisa una fecha ya guardada), con su auditoría. Devuelve lo que escribió.
 */
async function writeDates(
  client: PoolClient, runId: number, id: number, birth: string | undefined, death: string | undefined, reason: string, claims: number[],
): Promise<string[]> {
  const row = (await client.query<{ birth_date: string | null; death_date: string | null }>(
    "SELECT birth_date::text, death_date::text FROM public.persons WHERE id=$1 FOR UPDATE", [id])).rows[0];
  if (!row) return [];
  const newBirth = birth && row.birth_date === null ? birth : null;
  const newDeath = death && row.death_date === null ? death : null;
  const finalBirth = newBirth ?? row.birth_date;
  const finalDeath = newDeath ?? row.death_date;
  if (finalBirth && finalDeath && finalDeath < finalBirth) throw new Error(`persona ${id}: el fallecimiento (${finalDeath}) no puede ser anterior al nacimiento (${finalBirth})`);
  const written: string[] = [];
  if (newBirth) {
    await client.query("UPDATE public.persons SET birth_date=$2, updated_at=now() WHERE id=$1", [id, newBirth]);
    await audit(client, runId, "person", "person_id", id, "birth_date", null, newBirth, reason, claims);
    written.push(`nacimiento ${newBirth}`);
  }
  if (newDeath) {
    await client.query("UPDATE public.persons SET death_date=$2, updated_at=now() WHERE id=$1", [id, newDeath]);
    await audit(client, runId, "person", "person_id", id, "death_date", null, newDeath, reason, claims);
    written.push(`fallecimiento ${newDeath}`);
  }
  return written;
}

/**
 * Persona nueva con el nombre del artista, titular de su proyecto (y marcada
 * fallecida si corresponde). Si ya existe una persona con ese nombre exacto,
 * la usa en vez de crear otra.
 */
async function createTitular(
  client: PoolClient, correction: Extract<PersonCorrection, { op: "create_titular" }>, reason: string, runId: number,
): Promise<CorrectionOutcome & { credits: number }> {
  const artistName = (await client.query<{ name: string }>("SELECT name FROM public.artists WHERE id=$1 FOR UPDATE", [correction.artist.id])).rows[0]?.name ?? null;
  expectName("artista", correction.artist, artistName);
  const existingMember = await client.query(
    "SELECT 1 FROM public.artist_members am JOIN public.persons p ON p.id=am.person_id WHERE am.artist_id=$1 AND p.name=$2", [correction.artist.id, correction.name]);
  if ((existingMember.rowCount ?? 0) > 0) return { op: "create_titular", status: "skipped", detail: `${correction.name} ya es miembro de ${artistName}`, credits: 0 };
  const context = await planOperatorContext(client, runId, reason);
  let personId = (await personsNamedExactly(client, correction.name))[0];
  let created = false;
  if (personId === undefined) {
    try {
      personId = (await createEntity(context, "person", { name: correction.name }, { allowSimilar: false })).id;
    } catch (error) {
      if (!(error instanceof OperatorError) || error.code !== "needs_review") throw error;
      personId = (await createEntity(context, "person", { name: correction.name }, { allowSimilar: true })).id;
    }
    created = true;
  }
  const link = await linkProject(client, { id: personId, name: correction.name }, correction.artist, correction.role, reason, runId);
  const claims = await claimIdsFor(client, "person_id", personId);
  if (correction.deceased) {
    await client.query("UPDATE public.persons SET is_deceased=true, updated_at=now() WHERE id=$1", [personId]);
    await audit(client, runId, "person", "person_id", personId, "is_deceased", null, true, reason, claims);
  }
  const dated = await writeDates(client, runId, personId, correction.birthDate, correction.deathDate, reason, claims);
  return { op: "create_titular", status: "applied", detail: `${created ? "persona nueva" : "persona existente"} «${correction.name}» (${personId}) → ${link.detail}${correction.deceased ? "; fallecida" : ""}${dated.length ? `; ${dated.join(", ")}` : ""}`, credits: 0 };
}

/**
 * La persona es el titular del proyecto: alta de la membresía si no existe ya
 * (con cualquier rol), con auditoría, y derivación de «venezolano» para ella.
 */
async function linkProject(
  client: PoolClient, person: { id: number; name: string }, artist: { id: number; name: string }, role: string, reason: string, runId: number,
): Promise<CorrectionOutcome & { credits: number }> {
  expectName("persona", person, await personName(client, person.id));
  const artistName = (await client.query<{ name: string }>("SELECT name FROM public.artists WHERE id=$1 FOR UPDATE", [artist.id])).rows[0]?.name ?? null;
  expectName("artista", artist, artistName);
  const existing = await client.query("SELECT 1 FROM public.artist_members WHERE person_id=$1 AND artist_id=$2", [person.id, artist.id]);
  if ((existing.rowCount ?? 0) > 0) return { op: "link_project", status: "skipped", detail: `${person.name} ya es miembro de ${artist.name}`, credits: 0 };
  const inserted = await client.query<{ id: string }>(
    "INSERT INTO public.artist_members(artist_id,person_id,role,is_current) VALUES($1,$2,$3,false) RETURNING id::text", [artist.id, person.id, role]);
  await audit(client, runId, "artist_membership", "artist_membership_id", Number(inserted.rows[0]!.id), "linked_project",
    null, { person_id: person.id, person: person.name, artist_id: artist.id, artist: artist.name, role }, reason, await claimIdsFor(client, "person_id", person.id));
  await deriveVenezuelanFor(client, [person.id], runId);
  return { op: "link_project", status: "applied", detail: `${person.name} (${person.id}) → titular de ${artist.name} (${artist.id})`, credits: 0 };
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

/**
 * Contexto del operador para las altas que un plan necesita (dividir crea
 * personas). Reutiliza la misma fuente `crv-operador` que la API, para que las
 * altas de un plan dejen los mismos claims human/high.
 */
async function planOperatorContext(client: PoolClient, runId: number, note: string): Promise<OperatorContext> {
  await client.query(`
    INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
    VALUES($1,'Operador del catálogo (plan de correcciones)','database','high',false,
           'Altas humanas hechas por un plan de correcciones (E11.7). Nunca se raspa.')
    ON CONFLICT (slug) DO NOTHING`, [OPERATOR_SOURCE_SLUG]);
  const { rows } = await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [OPERATOR_SOURCE_SLUG]);
  return { client, runId, sourceId: Number(rows[0]!.id), operator: getEnv().CRV_OPERATOR_NAME, note };
}

/**
 * Convierte una persona en artista u organización sin plan JSON (E11.7). Es el
 * mismo `absorbPerson` que ejecuta la operación `to_artist`/`to_organization`
 * del plan, con los nombres leídos de la base para construir los `entityRef`.
 * La usa la API (POST /persons/:id/convert).
 */
export async function convertPerson(
  client: PoolClient, personId: number,
  to: { kind: "organization" | "artist"; id: number },
  keepNameAsAlias: boolean, note: string, runId: number,
): Promise<CorrectionOutcome & { credits: number }> {
  const person = (await client.query<{ name: string }>(
    "SELECT name FROM public.persons WHERE id=$1", [personId])).rows[0];
  if (!person) {
    const details: Record<string, unknown> = { entity: "person", id: personId };
    const moved = await resolveRedirect("person", personId, client);
    if (moved) details["movedTo"] = moved;
    throw new OperatorError("not_found", `persona ${personId} inexistente`, details);
  }
  const absorber = ABSORBERS[to.kind];
  const target = (await client.query<{ name: string }>(`SELECT name FROM public.${absorber.table} WHERE id=$1`, [to.id])).rows[0];
  if (!target) throw new OperatorError("not_found", `${absorber.label} ${to.id} inexistente`, { entity: to.kind, id: to.id });
  return absorbPerson(client, to.kind === "artist" ? "to_artist" : "to_organization",
    { id: personId, name: person.name }, { id: to.id, name: target.name }, absorber, keepNameAsAlias, note, runId);
}

/** Personas que ya responden a ese nombre exacto (como nombre o como alias). */
async function personsNamedExactly(client: PoolClient, name: string): Promise<number[]> {
  return (await client.query<{ id: string }>(`
    SELECT DISTINCT p.id::text
      FROM public.persons p
      LEFT JOIN ingest.person_aliases a ON a.person_id=p.id
     WHERE p.name=$1 OR a.alias=$1
     ORDER BY 1`, [name])).rows.map((row) => Number(row.id));
}

const sameRole = (left: string, right: string) => left.trim().toLowerCase() === right.trim().toLowerCase();

/**
 * «Dividir» una ficha que en realidad son varias personas (E11.7). Cada nombre
 * de `into` recibe copia de la trayectoria (créditos, membresías y
 * organizaciones) —con auditoría `split_from`— y la ficha combinada se retira:
 * su historia queda en la auditoría de cada destino y sus claims, superseded.
 * Nada se fusiona ni se borra por parecido: los destinos los nombra el plan.
 */
export interface PersonSplitPreview {
  person: { id: number; name: string };
  into: string[];
  targets: Array<{ name: string; existingId: number | null }>;
  counts: { albumCredits: number; trackCredits: number; memberships: number; organizations: number };
  warnings: string[];
}

/** Previsualiza la división de una persona: destinos que se crearán o reutilizarán y créditos que se repartirán. */
export async function previewPersonSplit(
  client: PoolClient, personId: number, into: string[],
): Promise<PersonSplitPreview> {
  const name = await personName(client, personId);
  if (!name) {
    const moved = await resolveRedirect("person", personId, client);
    throw new OperatorError("not_found", `persona ${personId} inexistente`, { entity: "person", id: personId, ...(moved ? { movedTo: moved } : {}) });
  }
  const targets: Array<{ name: string; existingId: number | null }> = [];
  const warnings: string[] = [];
  for (const targetName of into) {
    const found = await personsNamedExactly(client, targetName);
    if (found.includes(personId)) {
      warnings.push(`El destino «${targetName}» es la propia ficha ${personId}.`);
    } else if (found.length > 1) {
      warnings.push(`«${targetName}» coincide con ${found.length} personas distintas.`);
    }
    targets.push({ name: targetName, existingId: found.length === 1 && found[0] !== personId ? found[0]! : null });
  }

  const { rows } = await client.query<{ album_credits: string; track_credits: string; memberships: string; organizations: string }>(`
    SELECT (SELECT count(*) FROM public.album_credits WHERE person_id=$1)::text AS album_credits,
           (SELECT count(*) FROM public.track_credits WHERE person_id=$1)::text AS track_credits,
           (SELECT count(*) FROM public.artist_members WHERE person_id=$1)::text AS memberships,
           (SELECT count(*) FROM public.person_organizations WHERE person_id=$1)::text AS organizations`, [personId]);
  const counted = rows[0]!;
  return {
    person: { id: personId, name },
    into,
    targets,
    counts: {
      albumCredits: Number(counted.album_credits),
      trackCredits: Number(counted.track_credits),
      memberships: Number(counted.memberships),
      organizations: Number(counted.organizations),
    },
    warnings,
  };
}

/**
 * «Dividir» una ficha que en realidad son varias personas (E11.7, PLAN_CURADURIA E6.3).
 * Cada nombre de `into` recibe copia de la trayectoria (créditos, membresías y
 * organizaciones) —con auditoría `split_from`— y la ficha combinada se retira:
 * su historia queda en la auditoría de cada destino y sus claims, superseded.
 * Nada se fusiona ni se borra por parecido: los destinos los nombra la petición.
 */
export async function splitPerson(
  client: PoolClient, personId: number, into: string[], reason: string, runId: number, expectedName?: string,
): Promise<Omit<CorrectionOutcome, "op"> & { op: "split"; credits: number; targetIds: number[] }> {
  const actualName = await personName(client, personId);
  if (!actualName) {
    const moved = await resolveRedirect("person", personId, client);
    throw new OperatorError("not_found", `persona ${personId} inexistente`, { entity: "person", id: personId, ...(moved ? { movedTo: moved } : {}) });
  }
  if (expectedName !== undefined) {
    expectName("persona", { id: personId, name: expectedName }, actualName);
  }
  const original = { id: personId, name: actualName };

  // 1. Destinos: la persona que ya responde a ese nombre exacto, o una nueva.
  //    Se intenta crear sin «a sabiendas» (allowSimilar: false); si el ER ve
  //    candidatos parecidos —lo normal, porque la ficha combinada que se está
  //    dividiendo todavía existe— se reintenta con la decisión humana
  //    explícita: los nombres de `into` son la afirmación de que son personas
  //    distintas, y el reintento queda registrado como resolución del ER.
  const context = await planOperatorContext(client, runId, reason);
  const createTargetPerson = async (name: string): Promise<number> => {
    try {
      return (await createEntity(context, "person", { name }, { allowSimilar: false })).id;
    } catch (error) {
      if (!(error instanceof OperatorError)) throw error;
      if (error.code === "already_exists" && typeof error.details?.["existingId"] === "number") {
        return error.details["existingId"] as number;
      }
      if (error.code !== "needs_review") throw error;
      return (await createEntity(context, "person", { name }, { allowSimilar: true })).id;
    }
  };
  const targets: number[] = [];
  for (const name of into) {
    const found = await personsNamedExactly(client, name);
    if (found.includes(original.id)) throw new Error(`el destino «${name}» es la propia ficha ${original.id}: una división no se apunta a sí misma`);
    if (found.length > 1) throw new Error(`«${name}» coincide con ${found.length} personas (${found.join(", ")}): fusione o renombre antes de dividir`);
    targets.push(found.length === 1 ? found[0]! : await createTargetPerson(name));
  }

  // 2. Historia de la ficha combinada, para copiarla a cada destino antes de
  //    retirarla (sus merge_audit cuelgan de ella con CASCADE).
  const snapshot = (await client.query<{ person: Record<string, unknown> }>(
    "SELECT to_jsonb(p) AS person FROM public.persons p WHERE p.id=$1", [original.id])).rows[0]?.person ?? {};
  const aliases = (await client.query("SELECT * FROM ingest.person_aliases WHERE person_id=$1 ORDER BY id", [original.id])).rows;
  const history = (await client.query("SELECT * FROM ingest.merge_audit WHERE person_id=$1 ORDER BY id", [original.id])).rows;
  const claims = await claimIdsFor(client, "person_id", original.id);

  // 3. Trayectoria: copia a cada destino y retiro de la fila original. Los
  //    claims de cada fila retirada se sueltan antes (su FK es CASCADE: si no,
  //    el DELETE se los llevaría, y los claims no se borran).
  let duplicated = 0;
  let retired = 0;
  const detach = async (column: string, rowId: number) => {
    await client.query(`
      UPDATE ingest.claims SET ${column}=NULL, status='superseded', updated_at=now(), notes=concat_ws(' · ', notes, $2::text)
       WHERE ${column}=$1`, [rowId, `fila dividida hacia ${targets.join(", ")} (run ${runId})`]);
  };

  for (const spec of CREDIT_TABLES) {
    const rows = (await client.query<{ id: string; parent: string; credit_type: string; role: string; notes: string | null }>(
      `SELECT id::text, ${spec.parent}::text AS parent, credit_type::text AS credit_type, role, notes
         FROM public.${spec.table} WHERE person_id=$1 ORDER BY id`, [original.id])).rows;
    for (const row of rows) {
      const key = creditEquivalenceKey(row.credit_type as CreditType, row.role);
      for (const target of targets) {
        const existing = (await client.query<{ credit_type: string; role: string }>(
          `SELECT credit_type::text AS credit_type, role FROM public.${spec.table} WHERE person_id=$1 AND ${spec.parent}=$2`,
          [target, row.parent])).rows;
        if (existing.some((item) => creditEquivalenceKey(item.credit_type as CreditType, item.role) === key)) continue;
        const inserted = await client.query<{ id: string }>(`
          INSERT INTO public.${spec.table}(${spec.parent},person_id,credit_type,role,notes)
          VALUES($1,$2,$3::credit_type,$4,$5) RETURNING id::text`,
        [row.parent, target, row.credit_type, row.role, row.notes]);
        await audit(client, runId, spec.kind, `${spec.kind}_id`, Number(inserted.rows[0]!.id), "split_from",
          { person_id: original.id, name: original.name, sourceRowId: Number(row.id) }, { person_id: target }, reason, []);
        duplicated += 1;
      }
      await detach(`${spec.kind}_id`, Number(row.id));
    }
    retired += (await client.query(`DELETE FROM public.${spec.table} WHERE person_id=$1`, [original.id])).rowCount ?? 0;
  }

  const memberships = (await client.query<{ id: string; artist_id: string; role: string; from_year: number | null; to_year: number | null; is_current: boolean; notes: string | null }>(
    `SELECT id::text, artist_id::text, role, from_year, to_year, is_current, notes
       FROM public.artist_members WHERE person_id=$1 ORDER BY id`, [original.id])).rows;
  for (const row of memberships) {
    for (const target of targets) {
      const existing = (await client.query<{ role: string }>(
        "SELECT role FROM public.artist_members WHERE person_id=$1 AND artist_id=$2", [target, row.artist_id])).rows;
      if (existing.some((item) => sameRole(item.role, row.role))) continue;
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO public.artist_members(artist_id,person_id,role,from_year,to_year,is_current,notes)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
      [row.artist_id, target, row.role, row.from_year, row.to_year, row.is_current, row.notes]);
      await audit(client, runId, "artist_membership", "artist_membership_id", Number(inserted.rows[0]!.id), "split_from",
        { person_id: original.id, name: original.name, sourceRowId: Number(row.id) }, { person_id: target }, reason, []);
      duplicated += 1;
    }
    await detach("artist_membership_id", Number(row.id));
  }
  retired += (await client.query("DELETE FROM public.artist_members WHERE person_id=$1", [original.id])).rowCount ?? 0;

  const organizations = (await client.query<{ id: string; organization_id: string; role: string; from_year: number | null; to_year: number | null; notes: string | null }>(
    `SELECT id::text, organization_id::text, role, from_year, to_year, notes
       FROM public.person_organizations WHERE person_id=$1 ORDER BY id`, [original.id])).rows;
  for (const row of organizations) {
    for (const target of targets) {
      const existing = (await client.query<{ role: string }>(
        "SELECT role FROM public.person_organizations WHERE person_id=$1 AND organization_id=$2", [target, row.organization_id])).rows;
      if (existing.some((item) => sameRole(item.role, row.role))) continue;
      const inserted = await client.query<{ id: string }>(`
        INSERT INTO public.person_organizations(person_id,organization_id,role,from_year,to_year,notes)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING id::text`,
      [target, row.organization_id, row.role, row.from_year, row.to_year, row.notes]);
      await audit(client, runId, "person_organization", "person_organization_id", Number(inserted.rows[0]!.id), "split_from",
        { person_id: original.id, name: original.name, sourceRowId: Number(row.id) }, { person_id: target }, reason, []);
      duplicated += 1;
    }
    await detach("person_organization_id", Number(row.id));
  }
  retired += (await client.query("DELETE FROM public.person_organizations WHERE person_id=$1", [original.id])).rowCount ?? 0;

  for (const target of targets) {
    await audit(client, runId, "person", "person_id", target, "split_from",
      { person: snapshot, aliases, audits: history },
      { person_id: target, duplicatedRelations: duplicated, retiredRelations: retired }, reason, claims);
  }

  // 4. La ficha combinada ya no tiene dependientes: se retira con el camino
  //    normal (claims rechazados, historia conservada en la auditoría).
  const removal = await removeEntity(client, "person", original.id, { note: reason, runId });
  // La consolidación de créditos equivalentes se aplica a TODOS los destinos
  // (antes solo al primero del plan): cada ficha que recibió la trayectoria
  // queda con sus equivalentes unidos, no solo la del principio.
  let credits = 0;
  if (removal) {
    for (const target of targets) {
      credits += await mergeEquivalentCredits(client, { column: "person_id", id: target }, reason, runId);
    }
    // Cada destino recibió la trayectoria: puede ganar evidencia de venezolana.
    await deriveVenezuelanFor(client, targets, runId);
  }
  return {
    op: "split", status: removal ? "applied" : "skipped",
    detail: removal
      ? `«${original.name}» (${original.id}) → ${targets.join(", ")}; ${duplicated} relaciones duplicadas, ${retired} retiradas de la ficha combinada`
      : `persona ${original.id} ya no existe`,
    credits,
    targetIds: targets,
  };
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
    if (!dryRun) invalidateSearchIndex();
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
