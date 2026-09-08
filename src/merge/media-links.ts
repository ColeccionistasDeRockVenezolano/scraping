// Puente de artes: convierte claims `media_link` en filas de
// media.media_links. Es el único módulo que escribe esa tabla, y obedece las
// mismas cuatro reglas que el puente de relaciones (ver relations.ts):
//
//   1. Un arte NUNCA crea su entidad. Si el disco o el artista todavía no
//      existen en el core, el claim se queda en `candidate` y abre revisión.
//   2. El destino está fijado por el `media_target` del claim, no por el
//      contenido de la URL: una foto de artista no puede aterrizar colgada de
//      un disco por un mapeo equivocado.
//   3. Un claim `low` automático no escribe. Solo una decisión humana
//      explícita (createdBy="human", vía review approve) materializa el arte.
//   4. La unidad es el registro completo: los claims hermanos (url, tipo,
//      destino, contexto) se leen juntos.
//
// POR QUÉ EXISTE ESTA TABLA Y NO UNA COLUMNA MÁS:
//   `albums.cover_url` y `artists.picture_url` guardan UNA imagen cada una.
//   Un disco de CRV WordPress trae portada, contraportada, galleta del CD y
//   libreto; escribirlos en una sola columna obligaría a elegir uno y tirar
//   el resto. La portada sigue yendo a la columna del core —es la imagen
//   canónica— y todo lo demás vive aquí, sin competir con ella.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import type { ClaimToPersist } from "../claims/persistence.js";
import type { MergeOutcome } from "./engine.js";
import { normalizeDisplayName } from "../normalization/entity-name.js";
import { normalizeIdentity } from "../normalization/claims.js";

export const MEDIA_LINK_KIND = "media_link";

/** Valores admitidos por media_links_media_type_check (migración 0002). */
export const MEDIA_TYPES = ["cover", "artist_photo", "scan", "logo", "other"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

/** Destinos admitidos por media_links_entity_kind_check. */
const TARGETS = { artist: "artist_id", person: "person_id", organization: "organization_id", album: "album_id" } as const;
export type MediaTarget = keyof typeof TARGETS;

export function isMediaType(value: string): value is MediaType {
  return (MEDIA_TYPES as readonly string[]).includes(value);
}

function isMediaTarget(value: string): value is MediaTarget {
  return Object.hasOwn(TARGETS, value);
}

interface Gathered {
  get(field: string): string | undefined;
  claimIds: number[];
  contradicted: string[];
}

/** Igual que en relations.ts: dos valores distintos del mismo campo no se eligen. */
async function gatherFields(client: PoolClient, identityKey: string): Promise<Gathered> {
  const { rows } = await client.query<{ id: string; field: string; normalized_value: unknown; raw_value: unknown }>(
    `SELECT id::text, field, normalized_value, raw_value
       FROM ingest.claims
      WHERE entity_kind='media_link' AND identity_key=$1 AND status IN ('candidate','accepted')
      ORDER BY id`,
    [identityKey],
  );
  const values = new Map<string, string>();
  const contradicted = new Set<string>();
  const claimIds: number[] = [];
  for (const row of rows) {
    claimIds.push(Number(row.id));
    const raw = typeof row.raw_value === "string" ? row.raw_value : undefined;
    const normalized = typeof row.normalized_value === "string" && row.normalized_value.trim() ? row.normalized_value : undefined;
    // La URL se compara y se guarda CRUDA: normalizar un identificador opaco
    // de Blogger cambiaría la dirección y el arte dejaría de cargar.
    const value = row.field === "media_url" ? raw : (normalized ?? raw);
    if (value === undefined) continue;
    const text = row.field === "media_url" ? value.trim() : normalizeDisplayName(value);
    if (!text) continue;
    const previous = values.get(row.field);
    if (previous === undefined) values.set(row.field, text);
    else if (previous.toLowerCase() !== text.toLowerCase()) contradicted.add(row.field);
  }
  return { get: (field) => values.get(field), claimIds, contradicted: [...contradicted] };
}

/**
 * Resuelve la entidad dueña del arte reusando la decisión que los claims
 * hermanos de ESTA MISMA fuente ya tomaron y auditaron. No se llama al ER:
 * un arte no identifica entidades, se cuelga de una ya identificada. Si la
 * misma identidad apunta a más de una, no se elige — va a revisión.
 */
async function resolveOwner(
  client: PoolClient, target: MediaTarget, identity: string, sourceId: number,
): Promise<{ id?: number; ambiguous: boolean }> {
  const column = TARGETS[target];
  const { rows } = await client.query<{ id: string }>(
    `SELECT DISTINCT ${column}::text AS id FROM ingest.claims
      WHERE entity_kind=$1 AND identity_key=$2 AND source_id=$3 AND ${column} IS NOT NULL`,
    [target, normalizeIdentity(identity), sourceId],
  );
  if (rows.length === 1) return { id: Number(rows[0]!.id), ambiguous: false };
  return { ambiguous: rows.length > 1 };
}

async function openReview(
  client: PoolClient, claimId: number, kind: "low_confidence" | "manual_review",
  reason: string, payload: Record<string, unknown>,
): Promise<number> {
  const existing = await client.query<{ id: string }>(
    `SELECT id FROM ingest.review_queue
      WHERE claim_a_id=$1 AND kind=$2 AND status IN ('open','in_progress') ORDER BY id LIMIT 1`,
    [claimId, kind],
  );
  if (existing.rows[0]?.id) return Number(existing.rows[0].id);
  const saved = await client.query<{ id: string }>(
    `INSERT INTO ingest.review_queue(kind,claim_a_id,priority,payload,notes)
     VALUES($1,$2,7,$3::jsonb,$4) RETURNING id`,
    [kind, claimId, JSON.stringify({ mediaLink: true, reason, ...payload }), `Arte pendiente: ${reason}`],
  );
  return Number(saved.rows[0]!.id);
}

export async function mergeMediaLinkClaim(claim: ClaimToPersist, claimId: number): Promise<MergeOutcome> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`media_link:${claim.identity}`]);

    if ((claim.createdBy ?? "system") === "ai" || (claim.confidence === "low" && claim.createdBy !== "human")) {
      await client.query("UPDATE ingest.claims SET status='candidate',updated_at=now() WHERE id=$1", [claimId]);
      await openReview(client, claimId, "low_confidence", "claim low: no escribe media_links",
        { field: claim.field, identity: claim.originalIdentity });
      await client.query("COMMIT");
      return { action: "candidate", detail: "arte low/AI enviada a revisión; media_links intacta" };
    }

    const fields = await gatherFields(client, claim.identity);
    const pending = async (reason: string, payload: Record<string, unknown>): Promise<MergeOutcome> => {
      await client.query("UPDATE ingest.claims SET status='candidate',updated_at=now() WHERE id=$1", [claimId]);
      const reviewId = await openReview(client, claimId, "manual_review", reason, payload);
      await client.query("COMMIT");
      return { action: "candidate", detail: `${reason}; review=${reviewId}` };
    };

    if (fields.contradicted.length > 0) {
      return await pending("claims contradictorios sobre el mismo arte", { fields: fields.contradicted });
    }

    const url = fields.get("media_url");
    const rawTarget = (fields.get("media_target") ?? "").toLowerCase();
    const rawType = (fields.get("media_type") ?? "other").toLowerCase();
    if (!url || !isMediaTarget(rawTarget)) {
      return await pending("faltan campos obligatorios del arte", { url, target: rawTarget });
    }
    // Un tipo que la tabla no admite no se fuerza al valor por defecto: se
    // detiene, porque `other` afirmaría que se comprobó y no es cierto.
    if (!isMediaType(rawType)) {
      return await pending(`media_type fuera del vocabulario de media_links: ${rawType}`, { mediaType: rawType });
    }

    const ownerName = rawTarget === "album"
      ? `${fields.get("artist_name") ?? ""}::${fields.get("album_title") ?? ""}`
      : fields.get("artist_name") ?? fields.get("person_name") ?? fields.get("organization_name") ?? "";
    if (!ownerName.replace(/::/gu, "").trim()) {
      return await pending("el arte no dice de quién es", { target: rawTarget });
    }
    const owner = await resolveOwner(client, rawTarget, ownerName, claim.sourceId);
    if (owner.ambiguous) return await pending("la misma identidad apunta a más de una entidad", { owner: ownerName });
    if (owner.id === undefined) {
      return await pending("la entidad del arte no existe todavía en el core; apruébela primero",
        { target: rawTarget, owner: ownerName });
    }

    // UNIQUE (COALESCE(destinos), url) hace la escritura idempotente: la
    // misma arte del mismo disco no se duplica aunque se reprocese.
    const column = TARGETS[rawTarget];
    const written = await client.query<{ id: string }>(
      `INSERT INTO media.media_links(entity_kind,${column},url,media_type,source_id,meta)
       VALUES($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (COALESCE(artist_id, person_id, organization_id, album_id), url) DO NOTHING
       RETURNING id`,
      [rawTarget, owner.id, url, rawType, claim.sourceId,
        JSON.stringify({ identity: claim.originalIdentity, ...(fields.get("media_caption") ? { caption: fields.get("media_caption") } : {}) })],
    );
    let linkId = written.rows[0]?.id === undefined ? undefined : Number(written.rows[0].id);
    const created = linkId !== undefined;
    if (linkId === undefined) {
      const found = await client.query<{ id: string }>(
        `SELECT id FROM media.media_links WHERE ${column}=$1 AND url=$2 LIMIT 1`, [owner.id, url]);
      if (!found.rows[0]) throw new Error("media_links rechazó el arte pero no se encontró la fila existente");
      linkId = Number(found.rows[0].id);
    }

    if (created) {
      const audit = await client.query<{ id: string }>(
        `INSERT INTO ingest.merge_audit(run_id,entity_kind,media_link_id,field,old_value,new_value,reason,confidence,performed_by)
         VALUES($1,'media_link',$2,'media_links',NULL,$3::jsonb,$4,$5,$6) RETURNING id`,
        [claim.runId ?? null, linkId, JSON.stringify({ target: rawTarget, ownerId: owner.id, url, mediaType: rawType }),
          "arte adicional materializada fuera de la columna única del core", claim.confidence, claim.createdBy ?? "system"],
      );
      const auditId = audit.rows[0]?.id;
      if (auditId) {
        await client.query(
          "INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
          [auditId, claimId]);
      }
    }

    const siblings = [...new Set([...fields.claimIds, claimId])];
    await client.query(
      "UPDATE ingest.claims SET media_link_id=$1,status='accepted',updated_at=now() WHERE id = ANY($2::bigint[])",
      [linkId, siblings]);
    await client.query(
      `UPDATE ingest.review_queue SET status='approved',resolved_by='human',resolved_at=now(),updated_at=now(),
              resolution_note=COALESCE(resolution_note,'arte materializada en media_links')
        WHERE claim_a_id = ANY($1::bigint[]) AND kind IN ('low_confidence','manual_review') AND status IN ('open','in_progress')`,
      [siblings]);
    await client.query("COMMIT");
    return {
      action: created ? "applied" : "unchanged",
      detail: `${rawType} de ${rawTarget} #${owner.id} en media_links#${linkId}`,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
