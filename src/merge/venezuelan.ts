// CRV · Núcleo de la derivación de `persons.is_venezuelan` (Brian, 2026-09-22).
//
// Regla: miembro de una banda venezolana, o músico/invitado en un disco de un
// artista venezolano → venezolano. Los técnicos y compositores no cuentan.
// Solo se llena lo que está en NULL (sin dato, migración 0029); lo afirmado
// nunca se pisa. Cada persona marcada deja un claim de la fuente de derivación
// (con su evidencia) y su fila de `merge_audit` enlazada a ese claim.
//
// Vive aquí, sin depender del operador, porque el alta de relaciones
// (`relations.ts`) la llama en la misma transacción que crea la membresía o el
// crédito: así una persona nueva no queda «sin dato» esperando un barrido.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

export const VENEZUELAN_CREDIT_TYPES = ["musician", "guest"] as const;

export interface VenezuelanEvidence {
  personId: number;
  name: string;
  /** Bandas venezolanas de las que es miembro. */
  bands: string[];
  /** Discos venezolanos distintos donde es músico / invitado (crédito de disco o de pista). */
  musicianAlbums: number;
  guestAlbums: number;
}

type Queryable = Pick<PoolClient, "query">;

// Un artista es venezolano por su `origin_country`; el core lo trae por DEFAULT
// y las fuentes lo corrigen cuando dicen otro país (p. ej. Italia).
const VENEZUELAN_ARTIST = "lower(btrim(a.origin_country)) = 'venezuela'";

// Por persona y con los índices `*_person_idx`: igual de barato para una
// persona recién acreditada que para el catálogo entero.
const EVIDENCE_SQL = `
  SELECT p.id::text AS id, p.name, e.bands, e.musician_albums, e.guest_albums
    FROM public.persons p
    CROSS JOIN LATERAL (
      SELECT COALESCE((SELECT array_agg(DISTINCT a.name ORDER BY a.name)
                         FROM public.artist_members m
                         JOIN public.artists a ON a.id = m.artist_id AND ${VENEZUELAN_ARTIST}
                        WHERE m.person_id = p.id), '{}') AS bands,
             count(DISTINCT c.album_id) FILTER (WHERE c.credit_type = 'musician')::int AS musician_albums,
             count(DISTINCT c.album_id) FILTER (WHERE c.credit_type = 'guest')::int AS guest_albums
        FROM (
          SELECT ac.credit_type::text AS credit_type, ac.album_id FROM public.album_credits ac WHERE ac.person_id = p.id
          UNION ALL
          SELECT tc.credit_type::text, t.album_id FROM public.track_credits tc JOIN public.tracks t ON t.id = tc.track_id WHERE tc.person_id = p.id
        ) c
        JOIN public.albums al ON al.id = c.album_id
        JOIN public.artists a ON a.id = al.artist_id AND ${VENEZUELAN_ARTIST}
       WHERE c.credit_type = ANY($2::text[])
    ) e
   WHERE p.is_venezuelan IS NULL
     AND ($1::bigint[] IS NULL OR p.id = ANY($1::bigint[]))
     AND (cardinality(e.bands) > 0 OR e.musician_albums > 0 OR e.guest_albums > 0)
   ORDER BY p.id`;

/** Personas sin dato con evidencia; `personIds` acota (undefined = todo el catálogo). */
export async function findVenezuelanEvidence(client: Queryable, personIds?: readonly number[]): Promise<VenezuelanEvidence[]> {
  if (personIds !== undefined && personIds.length === 0) return [];
  const { rows } = await client.query<{ id: string; name: string; bands: string[]; musician_albums: number; guest_albums: number }>(
    EVIDENCE_SQL, [personIds ?? null, VENEZUELAN_CREDIT_TYPES]);
  return rows.map((row) => ({
    personId: Number(row.id), name: row.name, bands: row.bands,
    musicianAlbums: row.musician_albums, guestAlbums: row.guest_albums,
  }));
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/** Por qué se marca: lo que queda en `merge_audit.reason`. */
export function venezuelanReason(evidence: VenezuelanEvidence): string {
  const parts: string[] = [];
  if (evidence.bands.length > 0) {
    const shown = evidence.bands.slice(0, 3).join(", ");
    parts.push(`miembro de ${shown}${evidence.bands.length > 3 ? ` y ${evidence.bands.length - 3} más` : ""}`);
  }
  if (evidence.musicianAlbums > 0) parts.push(`músico en ${plural(evidence.musicianAlbums, "disco venezolano", "discos venezolanos")}`);
  if (evidence.guestAlbums > 0) parts.push(`invitado en ${plural(evidence.guestAlbums, "disco venezolano", "discos venezolanos")}`);
  return `derivado del catálogo: ${parts.join("; ")}`;
}

/** Fuente interna de lo que el catálogo deduce de sí mismo. Nunca se raspa. */
export const DERIVATION_SOURCE_SLUG = "crv-derivacion";
export const VENEZUELAN_EXTRACTOR = "derivacion-venezolano";

async function derivationSourceId(client: Queryable): Promise<number> {
  await client.query(`
    INSERT INTO ingest.sources(slug,name,site_type,trust_level,enabled,notes)
    VALUES($1,'Derivación del catálogo','database','medium',false,
           'Valores que el catálogo deduce de sus propias relaciones (p. ej. venezolano/a por bandas y créditos). Nunca se raspa.')
    ON CONFLICT (slug) DO NOTHING`, [DERIVATION_SOURCE_SLUG]);
  const { rows } = await client.query<{ id: string }>("SELECT id::text FROM ingest.sources WHERE slug=$1", [DERIVATION_SOURCE_SLUG]);
  return Number(rows[0]!.id);
}

const sha256 = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/**
 * Deja la huella de una derivación ya escrita en el core: un claim aceptado
 * de la fuente de derivación (con su evidencia) y la fila de `merge_audit`
 * enlazada a él, como toda auditoría del catálogo. `auditId` reutiliza
 * auditorías que ya existen en vez de crear nuevas.
 */
export async function recordVenezuelanClaims(
  client: Queryable, rows: ReadonlyArray<{ personId: number; reason: string; runId: number | null; auditId?: number }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const sourceId = await derivationSourceId(client);
  const { rowCount } = await client.query(`
    WITH input AS (
      SELECT * FROM unnest($1::bigint[], $2::text[], $3::bigint[], $4::bigint[], $5::text[], $6::text[])
        AS t(person_id, reason, run_id, audit_id, raw_hash, evidence_hash)),
    claim AS (
      INSERT INTO ingest.claims(source_id,entity_kind,person_id,field,raw_value,normalized_value,raw_hash,extractor,extractor_version,
                                confidence,status,created_by,run_id,notes,identity_key)
      SELECT $7, 'person', person_id, 'is_venezuelan', 'true'::jsonb, 'true'::jsonb, raw_hash, $8, '1',
             'medium', 'accepted', 'system', run_id, reason, 'derivacion:person:' || person_id
        FROM input
      RETURNING id, person_id, run_id),
    evidence AS (
      INSERT INTO ingest.claim_evidence(claim_id,url,excerpt,evidence_hash)
      SELECT claim.id, 'crv-derivacion://runs/' || COALESCE(claim.run_id::text, '-'), input.reason, input.evidence_hash
        FROM claim JOIN input USING (person_id)),
    audit AS (
      INSERT INTO ingest.merge_audit(run_id,entity_kind,person_id,field,old_value,new_value,reason,confidence,performed_by)
      SELECT run_id, 'person', person_id, 'is_venezuelan', NULL, 'true'::jsonb, reason, 'medium', 'system'
        FROM input WHERE audit_id IS NULL
      RETURNING id, person_id)
    INSERT INTO ingest.merge_audit_claims(merge_audit_id,claim_id)
    SELECT COALESCE(input.audit_id, audit.id), claim.id
      FROM claim JOIN input USING (person_id) LEFT JOIN audit USING (person_id)`,
  [rows.map((row) => row.personId), rows.map((row) => row.reason), rows.map((row) => row.runId),
    rows.map((row) => row.auditId ?? null),
    rows.map((row) => sha256([VENEZUELAN_EXTRACTOR, row.personId, row.reason, row.runId])),
    rows.map((row) => sha256(["evidencia", row.reason])),
    sourceId, VENEZUELAN_EXTRACTOR]);
  return rowCount ?? 0;
}

/**
 * Marca las personas de `evidence` que sigan sin dato, con su claim de
 * derivación y su auditoría ligados a `runId`. Devuelve cuántas marcó: quien
 * dejó de estar en NULL entre la lectura y la escritura se salta.
 */
export async function markVenezuelan(client: Queryable, evidence: readonly VenezuelanEvidence[], runId: number | null): Promise<number> {
  if (evidence.length === 0) return 0;
  const { rows } = await client.query<{ id: string }>(`
    UPDATE public.persons SET is_venezuelan = true, updated_at = now()
     WHERE id = ANY($1::bigint[]) AND is_venezuelan IS NULL
    RETURNING id::text`, [evidence.map((item) => item.personId)]);
  const marked = new Set(rows.map((row) => Number(row.id)));
  await recordVenezuelanClaims(client, evidence.filter((item) => marked.has(item.personId))
    .map((item) => ({ personId: item.personId, reason: venezuelanReason(item), runId })));
  return marked.size;
}

/** Deriva en la transacción de `client` para las personas dadas (lo que acaba de acreditarse). */
export async function deriveVenezuelanFor(client: Queryable, personIds: readonly number[], runId: number | null): Promise<number> {
  return markVenezuelan(client, await findVenezuelanEvidence(client, personIds), runId);
}
