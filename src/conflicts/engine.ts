import type { PoolClient } from "pg";
import { aiConflictProposalSchema, type AiConflictProposal } from "../ai/contracts.js";
import type { DeepSeekGateway } from "../ai/gateway.js";
import { getPool } from "../db/client.js";
import type { ResolvableClaimKind } from "../merge/specs.js";
import { ENTITY_SPECS } from "../merge/specs.js";

function json(value: unknown): string { return JSON.stringify(value); }

export interface ConflictResult {
  conflictId?: number;
  reviewId: number;
  hasRivalClaim: boolean;
}

async function createReview(
  client: PoolClient,
  claimId: number,
  otherClaimId: number | undefined,
  conflictId: number | undefined,
  payload: unknown,
): Promise<number> {
  const existing = await client.query<{ id: string }>(`
    SELECT id FROM ingest.review_queue
     WHERE kind='field_conflict' AND status IN ('open','in_progress')
       AND claim_a_id=$1 AND COALESCE(conflict_id,0)=COALESCE($2,0)
     ORDER BY id LIMIT 1`, [claimId, conflictId ?? null]);
  if (existing.rows[0]?.id) return Number(existing.rows[0].id);
  const saved = await client.query<{ id: string }>(`
    INSERT INTO ingest.review_queue(kind,claim_a_id,claim_b_id,conflict_id,priority,payload,notes)
    VALUES('field_conflict',$1,$2,$3,9,$4::jsonb,'Valor contradictorio: el core queda intacto hasta revision humana')
    RETURNING id`, [claimId, otherClaimId ?? null, conflictId ?? null, json(payload)]);
  const id = saved.rows[0]?.id;
  if (!id) throw new Error("no se pudo crear review de conflicto");
  return Number(id);
}

export async function hasOpenFieldConflict(client: PoolClient, kind: ResolvableClaimKind, targetId: number, field: string): Promise<boolean> {
  const spec = ENTITY_SPECS[kind];
  const result = await client.query(`
    SELECT 1 FROM ingest.conflicts c
    JOIN ingest.claims a ON a.id=c.claim_a_id
    JOIN ingest.claims b ON b.id=c.claim_b_id
    WHERE c.status='open' AND c.entity_kind=$1::ingest.claim_entity_kind AND c.field=$2
      AND (a.${spec.targetColumn}=$3 OR b.${spec.targetColumn}=$3)
    LIMIT 1`, [kind, field, targetId]);
  return result.rowCount === 1;
}

/** Conserva ambos claims y sus snapshots; nunca actualiza una tabla core. */
export async function createFieldConflict(
  client: PoolClient,
  input: { claimId: number; kind: ResolvableClaimKind; targetId: number; field: string; currentValue: unknown; proposedValue: unknown },
): Promise<ConflictResult> {
  const spec = ENTITY_SPECS[input.kind];
  const rival = await client.query<{ id: string; normalized_value: unknown; raw_value: unknown }>(`
    SELECT id,normalized_value,raw_value FROM ingest.claims
     WHERE ${spec.targetColumn}=$1 AND field=$2 AND id<>$3
       AND status IN ('accepted','conflict','superseded')
     ORDER BY (status='accepted') DESC, updated_at DESC, id DESC`, [input.targetId, input.field, input.claimId]);
  const matchingRival = rival.rows.find((row) => json(row.normalized_value ?? row.raw_value) === json(input.currentValue)) ?? rival.rows[0];
  if (!matchingRival) {
    await client.query("UPDATE ingest.claims SET status='candidate',updated_at=now() WHERE id=$1", [input.claimId]);
    const reviewId = await createReview(client, input.claimId, undefined, undefined, {
      entityKind: input.kind, targetId: input.targetId, field: input.field,
      canonicalValue: input.currentValue, proposedValue: input.proposedValue,
      reason: "canonical_value_has_no_rival_claim",
    });
    return { reviewId, hasRivalClaim: false };
  }
  const otherId = Number(matchingRival.id);
  const claimAId = Math.min(otherId, input.claimId); const claimBId = Math.max(otherId, input.claimId);
  const valueA = claimAId === otherId ? input.currentValue : input.proposedValue;
  const valueB = claimBId === input.claimId ? input.proposedValue : input.currentValue;
  await client.query("UPDATE ingest.claims SET status='conflict',updated_at=now() WHERE id=ANY($1::bigint[])", [[claimAId, claimBId]]);
  const saved = await client.query<{ id: string }>(`
    INSERT INTO ingest.conflicts(claim_a_id,claim_b_id,entity_kind,field,value_a,value_b)
    VALUES($1,$2,$3::ingest.claim_entity_kind,$4,$5::jsonb,$6::jsonb)
    ON CONFLICT(claim_a_id,claim_b_id,field) DO UPDATE SET
      value_a=EXCLUDED.value_a,value_b=EXCLUDED.value_b
    RETURNING id`, [claimAId, claimBId, input.kind, input.field, json(valueA), json(valueB)]);
  const conflictId = Number(saved.rows[0]?.id);
  if (!conflictId) throw new Error("no se pudo conservar el conflicto");
  const reviewId = await createReview(client, claimAId, claimBId, conflictId, {
    entityKind: input.kind, targetId: input.targetId, field: input.field,
    valueA, valueB,
    // claim_a/claim_b se ordenan por id para que el conflicto sea único; ese
    // orden no expresa cuál valor ya estaba en el catálogo. Conservar ambos
    // roles evita que la Mesa (o cualquier otro consumidor) confunda A con
    // "actual" cuando el claim nuevo tiene el id menor.
    canonicalValue: input.currentValue, proposedValue: input.proposedValue,
    canonicalClaimId: otherId, proposedClaimId: input.claimId,
    policy: "never_silent_overwrite",
  });
  return { conflictId, reviewId, hasRivalClaim: true };
}

/** Pro solo hace triage y adjunta una propuesta a review_queue. */
export async function triageConflictWithDeepSeek(conflictId: number, gateway: DeepSeekGateway): Promise<{ proposal: AiConflictProposal; aiRunId?: number }> {
  const loaded = await getPool().query(`
    SELECT c.id,c.entity_kind,c.field,c.value_a,c.value_b,
      jsonb_build_object('id',a.id,'source_id',a.source_id,'evidence',COALESCE((SELECT jsonb_agg(e) FROM ingest.claim_evidence e WHERE e.claim_id=a.id),'[]'::jsonb)) claim_a,
      jsonb_build_object('id',b.id,'source_id',b.source_id,'evidence',COALESCE((SELECT jsonb_agg(e) FROM ingest.claim_evidence e WHERE e.claim_id=b.id),'[]'::jsonb)) claim_b
    FROM ingest.conflicts c JOIN ingest.claims a ON a.id=c.claim_a_id JOIN ingest.claims b ON b.id=c.claim_b_id
    WHERE c.id=$1 AND c.status='open'`, [conflictId]);
  const conflict = loaded.rows[0];
  if (!conflict) throw new Error(`conflicto abierto inexistente: ${conflictId}`);
  const result = await gateway.propose({
    taskKind: "conflict_arbitration", schemaVersion: "conflict-proposal.v1",
    responseSchema: aiConflictProposalSchema,
    instructions: "Compara evidencia y procedencia. No resuelvas el conflicto: recomienda KEEP_A, KEEP_B, KEEP_BOTH o REVIEW.",
    input: conflict,
  });
  await getPool().query(`
    UPDATE ingest.review_queue SET payload=COALESCE(payload,'{}'::jsonb) || $2::jsonb,updated_at=now()
     WHERE conflict_id=$1 AND status IN ('open','in_progress')`, [conflictId, json({ deepseekProposal: result.proposal, aiRunId: result.runId ?? null })]);
  return { proposal: result.proposal, ...(result.runId === undefined ? {} : { aiRunId: result.runId }) };
}
