// Relaciones equivalentes: dos filas puente que dicen lo mismo sobre el mismo
// acreditado son una sola. Vive aquí, y no en `person-corrections.ts`, porque
// lo usan tanto la corrección de personas por plan JSON como la fusión de
// personas (servicio y API), y porque su unidad de trabajo no es la persona
// sino la relación: créditos con `creditEquivalenceKey` y membresías por
// (banda, persona, etapa): el rol se une, no separa (caso Abaddon, 2026-10-04).
//
//  * NADA SE UNE POR PARECIDO. Dos créditos del mismo acreditado en la misma
//    obra se unen solo si su clave de equivalencia coincide (el texto del rol
//    no distingue en fotografía y arte; en el resto, sí).
//  * DOS PERÍODOS QUE SE CONTRADICEN NO SE TOCAN. Se abre una revisión
//    `manual_review` y decide una persona: sobrescribir un `from_year` sería
//    inventar un dato que ninguna fuente afirmó.
import type { PoolClient } from "pg";
import type { CreditType } from "./relations.js";
import { creditEquivalenceKey } from "./relations.js";
import { mergeInto } from "../review/duplicates.js";
import { combineRoles, compatiblePeriods, disjointPeriods, sameRole } from "./membership-roles.js";

const CREDIT_TABLES = [
  { table: "album_credits", kind: "album_credit", parent: "album_id" },
  { table: "track_credits", kind: "track_credit", parent: "track_id" },
] as const;

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

/**
 * Une los créditos equivalentes de una obra (álbum o pista) donde un mismo
 * acreditado (persona, artista u organización) figura más de una vez con el
 * mismo rol o clave de equivalencia.
 */
export async function mergeEquivalentCreditsOnParent(
  client: PoolClient,
  parent: { kind: "album" | "track"; id: number },
  note: string,
  runId: number,
): Promise<number> {
  const table = parent.kind === "album" ? "album_credits" : "track_credits";
  const creditKind = parent.kind === "album" ? "album_credit" : "track_credit";
  const parentCol = parent.kind === "album" ? "album_id" : "track_id";
  const { rows } = await client.query<{
    id: string;
    person_id: string | null;
    artist_id: string | null;
    organization_id: string | null;
    credit_type: CreditType;
    role: string;
  }>(`
    SELECT id::text, person_id::text, artist_id::text, organization_id::text,
           credit_type::text AS credit_type, role
      FROM public.${table}
     WHERE ${parentCol} = $1
     ORDER BY id`, [parent.id]);

  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const targetKey = `${row.person_id ?? ""}:${row.artist_id ?? ""}:${row.organization_id ?? ""}`;
    const key = `${targetKey}|${creditEquivalenceKey(row.credit_type, row.role)}`;
    groups.set(key, [...(groups.get(key) ?? []), Number(row.id)]);
  }
  let merged = 0;
  for (const ids of groups.values()) {
    for (const dropId of ids.slice(1)) {
      await mergeInto(client, creditKind, ids[0]!, dropId, note, runId, { alias: false });
      merged += 1;
    }
  }
  return merged;
}

interface MembershipRow {
  id: string; artist_id: string; person_id: string; role: string;
  from_year: number | null; to_year: number | null; is_current: boolean; notes: string | null;
}

/** Una etapa: membresías de la misma persona en la misma banda que son el mismo hecho. */
interface Stage { rows: MembershipRow[]; from_year: number | null; to_year: number | null }

export interface MembershipConsolidation {
  /** Filas que desaparecieron al unirse a otra. */
  merged: number;
  /** Filas que quedaron con rol, años, vigencia o notas completados. */
  updated: number;
  /** Pares con períodos que se contradicen, a revisión humana. */
  reviewsOpened: number;
  groups: Array<{ artistId: number; personId: number; keepId: number; dropIds: number[]; before: string[]; role: string;
    from_year: number | null; to_year: number | null }>;
}

/**
 * Reparte las membresías de una persona en una banda en etapas. Primero las
 * que traen años, después las que no (se unen a la etapa con el mismo rol o a
 * la primera). Una fila que no encaja en ninguna etapa y tampoco está aparte
 * de todas se contradice: queda sola y la marca `conflict`.
 */
function stagesOf(rows: MembershipRow[]): { stages: Stage[]; conflict: boolean } {
  const stages: Stage[] = [];
  let conflict = false;
  const dated = rows.filter((row) => row.from_year !== null || row.to_year !== null);
  const undated = rows.filter((row) => row.from_year === null && row.to_year === null);
  for (const row of dated) {
    const stage = stages.find((item) => compatiblePeriods(item, row));
    if (stage) {
      stage.rows.push(row);
      stage.from_year ??= row.from_year;
      stage.to_year ??= row.to_year;
      continue;
    }
    if (!stages.every((item) => disjointPeriods(item, row))) conflict = true;
    stages.push({ rows: [row], from_year: row.from_year, to_year: row.to_year });
  }
  for (const row of undated) {
    const stage = stages.find((item) => item.rows.some((other) => sameRole(other.role, row.role))) ?? stages[0];
    if (stage) stage.rows.push(row);
    else stages.push({ rows: [row], from_year: null, to_year: null });
  }
  return { stages, conflict };
}

/**
 * Une las membresías repetidas de una persona en una banda: una fila por
 * etapa. Queda la de id menor; el rol pasa a ser la unión de los roles
 * (membership-roles.ts), los años y la vigencia se completan, y los textos de
 * rol que desaparecen quedan en las notas de la que queda. `mergeInto` mueve
 * los claims y deja la fila borrada en la auditoría (deshacer la run la
 * devuelve). Los períodos que se contradicen no se tocan: revisión humana.
 *
 * `scope` acota a una persona, a una banda o a ambas.
 */
export async function consolidateMemberships(
  client: PoolClient, scope: { personId?: number; artistId?: number }, note: string, runId: number,
  options: { skip?: (artistId: number, personId: number) => boolean } = {},
): Promise<MembershipConsolidation> {
  const where: string[] = [];
  const params: number[] = [];
  if (scope.personId !== undefined) { params.push(scope.personId); where.push(`person_id=$${params.length}`); }
  if (scope.artistId !== undefined) { params.push(scope.artistId); where.push(`artist_id=$${params.length}`); }
  if (!where.length) throw new Error("consolidateMemberships: falta acotar por persona o banda");
  const { rows } = await client.query<MembershipRow>(`
    SELECT id::text, artist_id::text, person_id::text, role, from_year, to_year, is_current, notes
      FROM public.artist_members WHERE ${where.join(" AND ")} ORDER BY id FOR UPDATE`, params);
  const pairs = new Map<string, MembershipRow[]>();
  for (const row of rows) {
    const key = `${row.artist_id}|${row.person_id}`;
    pairs.set(key, [...(pairs.get(key) ?? []), row]);
  }
  const result: MembershipConsolidation = { merged: 0, updated: 0, reviewsOpened: 0, groups: [] };
  for (const group of pairs.values()) {
    if (group.length < 2 || options.skip?.(Number(group[0]!.artist_id), Number(group[0]!.person_id))) continue;
    const { stages, conflict } = stagesOf(group);
    for (const stage of stages) {
      if (stage.rows.length < 2) continue;
      const ordered = [...stage.rows].sort((left, right) => Number(left.id) - Number(right.id));
      const keep = ordered[0]!;
      const drops = ordered.slice(1);
      const role = combineRoles(ordered.map((row) => row.role));
      const roleTexts = [...new Set(ordered.map((row) => row.role.trim()))];
      const noteLines = [...new Set(ordered.map((row) => row.notes?.trim()).filter((text): text is string => Boolean(text)))];
      if (new Set(roleTexts.map((text) => text.toLowerCase())).size > 1) {
        noteLines.push(`Roles según las fuentes antes de unir (run ${runId}): ${ordered.map((row) => `«${row.role.trim()}» (fila ${row.id})`).join(", ")}`);
      }
      const wanted = {
        role, from_year: stage.from_year, to_year: stage.to_year,
        is_current: ordered.some((row) => row.is_current),
        notes: noteLines.length ? noteLines.join("\n") : null,
      };
      for (const drop of drops) {
        await mergeInto(client, "artist_membership", Number(keep.id), Number(drop.id), note, runId, { alias: false });
      }
      const current = (await client.query<Omit<MembershipRow, "id" | "artist_id" | "person_id">>(
        "SELECT role, from_year, to_year, is_current, notes FROM public.artist_members WHERE id=$1", [keep.id])).rows[0]!;
      const changed = (Object.keys(wanted) as Array<keyof typeof wanted>).filter((column) => current[column] !== wanted[column]);
      if (changed.length) {
        await client.query(
          `UPDATE public.artist_members SET ${changed.map((column, index) => `${column}=$${index + 2}`).join(",")} WHERE id=$1`,
          [keep.id, ...changed.map((column) => wanted[column])]);
        // Un solo rastro con los valores de antes: deshacer la fusión
        // (`undoMergeRun`) los devuelve antes de separar las filas.
        await client.query(`
          INSERT INTO ingest.merge_audit(run_id,entity_kind,artist_membership_id,field,old_value,new_value,reason,confidence,performed_by)
          VALUES($1,'artist_membership',$2,'membership_consolidated',$3::jsonb,$4::jsonb,$5,'high','system')`,
        [runId, keep.id, JSON.stringify(Object.fromEntries(changed.map((column) => [column, current[column]]))),
          JSON.stringify(Object.fromEntries(changed.map((column) => [column, wanted[column]]))), `membresías repetidas unidas: ${note}`]);
        result.updated += 1;
      }
      result.merged += drops.length;
      result.groups.push({
        artistId: Number(keep.artist_id), personId: Number(keep.person_id), keepId: Number(keep.id),
        dropIds: drops.map((row) => Number(row.id)), before: ordered.map((row) => row.role), role,
        from_year: wanted.from_year, to_year: wanted.to_year,
      });
    }
    if (conflict) {
      const ids = (await client.query<{ id: string }>(
        "SELECT id::text FROM public.artist_members WHERE artist_id=$1 AND person_id=$2 ORDER BY id",
        [group[0]!.artist_id, group[0]!.person_id])).rows.map((row) => Number(row.id));
      const open = await client.query(`
        SELECT 1 FROM ingest.review_queue
         WHERE kind='manual_review' AND status IN ('open','in_progress') AND payload->>'detector'='membership-periods'
           AND payload->>'artistId'=$1 AND payload->>'personId'=$2 LIMIT 1`, [group[0]!.artist_id, group[0]!.person_id]);
      if (!open.rowCount) {
        await client.query(`
          INSERT INTO ingest.review_queue(kind,priority,payload,notes)
          VALUES('manual_review',5,$1::jsonb,$2)`,
        [JSON.stringify({
          detector: "membership-periods", version: 2, runId, ids,
          personId: Number(group[0]!.person_id), artistId: Number(group[0]!.artist_id),
        }), `Membresías con períodos contradictorios en la banda ${group[0]!.artist_id}: ${note}`]);
        result.reviewsOpened += 1;
      }
    }
  }
  return result;
}

/**
 * Une las membresías equivalentes que la fusión de dos personas dejó sobre la
 * misma banda (P7). Se conserva por compatibilidad: es `consolidateMemberships`
 * acotado a la persona.
 */
export async function mergeEquivalentMemberships(
  client: PoolClient, personId: number, note: string, runId: number,
): Promise<{ merged: number; reviewsOpened: number }> {
  const { merged, reviewsOpened } = await consolidateMemberships(client, { personId }, note, runId);
  return { merged, reviewsOpened };
}
