// Relaciones equivalentes: dos filas puente que dicen lo mismo sobre el mismo
// acreditado son una sola. Vive aquí, y no en `person-corrections.ts`, porque
// lo usan tanto la corrección de personas por plan JSON como la fusión de
// personas (servicio y API), y porque su unidad de trabajo no es la persona
// sino la relación: créditos con `creditEquivalenceKey` y membresías por
// (banda, rol) con períodos que no se contradicen.
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

interface MembershipRow { id: string; artist_id: string; role_key: string; from_year: number | null; to_year: number | null }

/**
 * Dos membresías de la misma persona en la misma banda con el mismo rol son
 * una sola si sus períodos no se contradicen (DATA_MODEL §6). Para cada año,
 * vale que alguno sea NULL o que los dos sean iguales.
 */
function compatiblePeriods(left: MembershipRow, right: MembershipRow): boolean {
  const compatible = (a: number | null, b: number | null): boolean => a === null || b === null || a === b;
  return compatible(left.from_year, right.from_year) && compatible(left.to_year, right.to_year);
}

/**
 * Une las membresías equivalentes que la fusión de dos personas dejó sobre la
 * misma banda (P7, antes quedaban duplicadas). Las que se contradicen en el
 * período no se tocan: se abre una revisión y decide una persona.
 */
export async function mergeEquivalentMemberships(
  client: PoolClient, personId: number, note: string, runId: number,
): Promise<{ merged: number; reviewsOpened: number }> {
  const { rows } = await client.query<MembershipRow>(`
    SELECT id::text, artist_id::text, lower(trim(role)) AS role_key, from_year, to_year
      FROM public.artist_members WHERE person_id=$1 ORDER BY id`, [personId]);
  const groups = new Map<string, MembershipRow[]>();
  for (const row of rows) {
    const key = `${row.artist_id}|${row.role_key}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  let merged = 0;
  let reviewsOpened = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    // El que queda es el de id menor; los años que le falten se completan
    // desde el que desaparece (los períodos son compatibles por definición).
    let keep = group[0]!;
    const conflicting: MembershipRow[] = [];
    for (const row of group.slice(1)) {
      if (!compatiblePeriods(keep, row)) {
        conflicting.push(row);
        continue;
      }
      await mergeInto(client, "artist_membership", Number(keep.id), Number(row.id), note, runId, { alias: false });
      merged += 1;
      keep = { ...keep, from_year: keep.from_year ?? row.from_year, to_year: keep.to_year ?? row.to_year };
    }
    if (conflicting.length) {
      await client.query(`
        INSERT INTO ingest.review_queue(kind,priority,payload,notes)
        VALUES('manual_review',5,$1::jsonb,$2)`,
      [JSON.stringify({
        detector: "membership-periods", version: 1, runId,
        ids: [keep, ...conflicting].map((row) => Number(row.id)),
        personId, artistId: Number(keep.artist_id),
      }), `Membresías con períodos contradictorios en la banda ${keep.artist_id}: ${note}`]);
      reviewsOpened += 1;
    }
  }
  return { merged, reviewsOpened };
}
