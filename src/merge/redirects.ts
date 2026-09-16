// CRV · Redirecciones de ids fusionados (PHASES E11.2; plan P5).
//
// Tras una fusión, el id que desaparece no debe morir en un 404: los enlaces
// guardados, las exportaciones y la mesa de cotejo siguen apuntando a él. La
// tabla ingest.entity_redirects guarda «id borrado → id que quedó» y la
// escribe `mergeInto` dentro de la transacción de la fusión —por eso la
// lectura vive aquí, junto al motor, y no en la capa HTTP—.
//
// La conversión de una persona en artista u organización (`absorbPerson`) no
// tiene una persona destino y por eso no escribe en entity_redirects: su
// destino vive en la auditoría `absorbed_person` y se resuelve aquí por
// consulta, para que `/persons/<id>` también responda `movedTo`.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";

export const REDIRECT_KINDS = ["artist", "person", "organization", "album", "track"] as const;
export type RedirectKind = (typeof REDIRECT_KINDS)[number];

export interface RedirectTarget {
  kind: RedirectKind;
  id: number;
}

const REDIRECT_KIND_SET = new Set<string>(REDIRECT_KINDS);
/** Tope de saltos de la cadena: 10 absorciones seguidas ya es un dato roto, no una cadena. */
const MAX_HOPS = 10;

/**
 * Destino final de un id fusionado, o `null` si nunca existió o no hay
 * redirección. Sigue la cadena —la tabla se comprime al fusionar, pero una
 * fila antigua sin recomprimir tampoco debe quedar sin respuesta—.
 */
export async function resolveRedirect(
  kind: string, id: number, queryable: Pick<PoolClient, "query"> = getPool(),
): Promise<RedirectTarget | null> {
  if (!REDIRECT_KIND_SET.has(kind)) return null;
  let current = id;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const { rows } = await queryable.query<{ to_id: string }>(
      "SELECT to_id::text FROM ingest.entity_redirects WHERE entity_kind=$1 AND from_id=$2", [kind, current]);
    const next = rows[0] ? Number(rows[0].to_id) : undefined;
    if (next === undefined || next === current) break;
    current = next;
  }
  if (current !== id) return { kind: kind as RedirectKind, id: current };
  if (kind !== "person") return null;
  // Persona absorbida por un artista u organización: sin fila en
  // entity_redirects (no hay persona destino), el destino queda en la
  // auditoría `absorbed_person` de la entidad que la absorbió.
  const { rows } = await queryable.query<{ kind: "artist" | "organization"; id: string }>(`
    SELECT CASE WHEN organization_id IS NOT NULL THEN 'organization' ELSE 'artist' END AS kind,
           COALESCE(organization_id, artist_id)::text AS id
      FROM ingest.merge_audit
     WHERE field='absorbed_person' AND old_value->'person'->>'id' = $1::text
     ORDER BY id DESC LIMIT 1`, [id]);
  const absorbed = rows[0];
  return absorbed ? { kind: absorbed.kind, id: Number(absorbed.id) } : null;
}
