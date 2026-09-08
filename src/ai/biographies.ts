import { aiBiographyDraftSchema } from "./contracts.js";
import type { DeepSeekGateway } from "./gateway.js";
import { getPool } from "../db/client.js";

export type BiographyEntity = { kind: "ARTIST"; id: number } | { kind: "PERSON"; id: number };

interface AcceptedFact {
  claim_id: number;
  field: string;
  value: unknown;
  source: { id: number; slug: string; name: string };
  evidence: unknown[];
}

export interface BiographyDraftResult {
  id: number;
  body: string;
  claimIds: number[];
  reviewId: number;
  aiRunId: number;
  model: string;
  cached: boolean;
}

async function acceptedFacts(entity: BiographyEntity): Promise<AcceptedFact[]> {
  const targetColumn = entity.kind === "ARTIST" ? "artist_id" : "person_id";
  const result = await getPool().query<{
    id: string; field: string; value: unknown; source_id: string; source_slug: string; source_name: string;
    evidence: unknown;
  }>(`
    SELECT c.id,c.field,COALESCE(c.normalized_value,c.raw_value) AS value,
           s.id AS source_id,s.slug AS source_slug,s.name AS source_name,
           COALESCE((SELECT jsonb_agg(jsonb_build_object(
             'url',e.url,'excerpt',e.excerpt,'selector',e.selector,'position',e.position,'evidence_hash',e.evidence_hash
           ) ORDER BY e.id) FROM ingest.claim_evidence e WHERE e.claim_id=c.id),'[]'::jsonb) evidence
      FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
     WHERE c.${targetColumn}=$1 AND c.status='accepted' AND c.field<>'biography'
       AND NOT EXISTS(
         SELECT 1 FROM ingest.conflicts cf
          WHERE cf.status='open' AND (cf.claim_a_id=c.id OR cf.claim_b_id=c.id)
       )
     ORDER BY c.id`, [entity.id]);
  return result.rows.map((row) => ({
    claim_id: Number(row.id), field: row.field, value: row.value,
    source: { id: Number(row.source_id), slug: row.source_slug, name: row.source_name },
    evidence: Array.isArray(row.evidence) ? row.evidence : [],
  }));
}

/**
 * Genera un artefacto editorial separado. Ni esta funcion ni su gateway
 * importan el merge engine; no existe ruta hacia artists/persons.biography.
 */
export async function generateBiographyDraft(
  entity: BiographyEntity,
  gateway: DeepSeekGateway,
  options: { promptVersion?: string; complexHistorical?: boolean } = {},
): Promise<BiographyDraftResult> {
  const facts = await acceptedFacts(entity);
  if (!facts.length) throw new Error("una biografia requiere al menos un claim aceptado y no conflictivo");
  const allowed = new Set(facts.map((fact) => fact.claim_id));
  const promptVersion = options.promptVersion ?? "biography.v1";
  const generated = await gateway.propose({
    taskKind: options.complexHistorical ? "historical_interpretation" : "biography",
    schemaVersion: promptVersion,
    responseSchema: aiBiographyDraftSchema,
    instructions: [
      "Redacta una biografia editorial en espanol exclusivamente con los facts suministrados.",
      "Cada parrafo debe listar claim_ids que lo sostienen; no inventes fechas, relaciones ni contexto.",
      "Si un hecho no esta en facts, omitelo y registralo como incertidumbre.",
    ].join(" "),
    input: { entity, accepted_claims_only: facts },
  });
  const usedClaimIds = [...new Set(generated.proposal.paragraphs.flatMap((paragraph) => paragraph.claim_ids))];
  const invalid = usedClaimIds.filter((id) => !allowed.has(id));
  if (invalid.length) throw new Error(`DeepSeek cito claims no aceptados/no suministrados: ${invalid.join(",")}`);
  const body = generated.proposal.paragraphs.map((paragraph) => paragraph.text.trim()).join("\n\n");
  if (!generated.runId) throw new Error("la biografia exige un ai_run persistido para trazabilidad");
  const usedFacts = facts.filter((fact) => usedClaimIds.includes(fact.claim_id));
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const stillAccepted = await client.query<{ id: string }>(`
      SELECT c.id FROM ingest.claims c WHERE c.id=ANY($1::bigint[]) AND c.status='accepted'
        AND NOT EXISTS(SELECT 1 FROM ingest.conflicts cf WHERE cf.status='open' AND (cf.claim_a_id=c.id OR cf.claim_b_id=c.id))
      FOR SHARE`, [usedClaimIds]);
    if (stillAccepted.rowCount !== usedClaimIds.length) throw new Error("los claims cambiaron de estado durante la generacion; borrador rechazado");
    const target = entity.kind === "ARTIST" ? [entity.id, null] : [null, entity.id];
    const existing = await client.query<{ id: string; review_queue_id: string }>(`
      SELECT id,review_queue_id FROM ingest.ai_biographies
       WHERE ai_run_id=$1 AND entity_kind=$2 AND COALESCE(artist_id,0)=COALESCE($3,0) AND COALESCE(person_id,0)=COALESCE($4,0)
       LIMIT 1`, [generated.runId, entity.kind, ...target]);
    if (existing.rows[0]) {
      await client.query("COMMIT");
      return {
        id: Number(existing.rows[0].id), body, claimIds: usedClaimIds,
        reviewId: Number(existing.rows[0].review_queue_id), aiRunId: generated.runId,
        model: generated.model, cached: true,
      };
    }
    const biography = await client.query<{ id: string }>(`
      INSERT INTO ingest.ai_biographies(entity_kind,artist_id,person_id,ai_run_id,body,facts_snapshot,model,prompt_version)
      VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8) RETURNING id`,
    [entity.kind, ...target, generated.runId, body, JSON.stringify(usedFacts), generated.model, promptVersion]);
    const biographyId = Number(biography.rows[0]!.id);
    for (const claimId of usedClaimIds) {
      await client.query("INSERT INTO ingest.ai_biography_claims(biography_id,claim_id) VALUES($1,$2)", [biographyId, claimId]);
    }
    const review = await client.query<{ id: string }>(`
      INSERT INTO ingest.review_queue(kind,claim_a_id,artist_a_id,person_a_id,priority,payload,notes)
      VALUES('ai_biography',$1,$2,$3,5,$4::jsonb,'Borrador editorial separado; aprobar nunca cambia hechos estructurados')
      RETURNING id`, [usedClaimIds[0] ?? null, target[0], target[1], JSON.stringify({ biographyId, aiRunId: generated.runId, claimIds: usedClaimIds, uncertainties: generated.proposal.uncertainties })]);
    const reviewId = Number(review.rows[0]!.id);
    await client.query("UPDATE ingest.ai_biographies SET review_queue_id=$2 WHERE id=$1", [biographyId, reviewId]);
    await client.query("COMMIT");
    return { id: biographyId, body, claimIds: usedClaimIds, reviewId, aiRunId: generated.runId, model: generated.model, cached: generated.cached };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function approveBiographyDraft(id: number, note: string): Promise<void> {
  if (!note.trim()) throw new Error("approval note obligatoria");
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const saved = await client.query<{ review_queue_id: string | null }>("UPDATE ingest.ai_biographies SET status='approved' WHERE id=$1 AND status='draft' RETURNING review_queue_id", [id]);
    const row = saved.rows[0];
    if (!row) throw new Error(`borrador draft inexistente: ${id}`);
    if (row.review_queue_id) await client.query("UPDATE ingest.review_queue SET status='approved',resolved_by='human',resolution_note=$2,resolved_at=now(),updated_at=now() WHERE id=$1", [Number(row.review_queue_id), note]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
