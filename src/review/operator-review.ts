// Acciones del operador sobre la cola de revisión (PHASES §E7B): aceptar o
// rechazar un candidato y resolver un conflicto de campo.
//
// Ninguna acción tiene lógica propia de merge. Cada tipo de revisión va al
// aplicador que ya existe para él:
//
//  * careos de identidad de la Mesa (album/person/organization_match): se
//    registra la decisión en review_decisions firmada por el operador y se
//    aplica SOLO esa revisión con `applyReviewDecisions`, que razona con todas
//    las decisiones activas de la identidad;
//  * propuestas del ER sin Mesa (ambiguous_alias, ai_entity_resolution): el
//    merge con la anulación humana same/different;
//  * claims candidatos (low_confidence, manual_review de relaciones): la
//    promoción o el descarte por entidad (`approveEntity`/`dismissEntity`);
//  * conflictos de campo: `resolveFieldConflict` para elegir un lado, o la
//    corrección humana del operador para afirmar un valor.
//
// Toda acción deja rastro: el run `manual` con operador, nota y resultado, la
// nota firmada en la revisión y, cuando cambia el core, merge_audit.
import { approveBiographyDraft } from "../ai/biographies.js";
import { getPool } from "../db/client.js";
import { mergeClaim, resolveFieldConflict, type ConflictResolution } from "../merge/engine.js";
import { OperatorError, settleEntityField, withOperatorRun } from "../merge/operator.js";
import { resolvableSpec, type ResolvableClaimKind } from "../merge/specs.js";
import { approveEntity, dismissEntity, loadClaimForApproval } from "./approval.js";
import { applyReviewDecisions } from "./decisions.js";
import { resolveReview } from "./queue.js";

const MESA_KINDS = new Set(["album_match", "person_match", "organization_match"]);
const ER_KINDS = new Set(["ambiguous_alias", "ai_entity_resolution"]);
const CLAIM_KINDS = new Set(["low_confidence", "manual_review"]);
const CLI_ONLY: Readonly<Record<string, string>> = {
  youtube_match: "se decide con `crv ambiguity:resolve` y se aplica con `crv ambiguity:apply --confirm` (o `crv yt:link --confirm` para elegir video y disco a mano)",
  possible_duplicate: "se decide con `crv ambiguity:resolve` y se aplica con `crv ambiguity:apply --confirm` (o `crv review duplicates`)",
};
/** La propuesta del detector de personas (E11.5): fusionar o «son distintas». */
const PERSON_DUPLICATE = "person_duplicate";

export interface ReviewActionInput {
  operator: string;
  note: string;
}

export interface ReviewActionResult {
  reviewId: number;
  kind: string;
  action: "accepted" | "rejected" | "resolved";
  /** Run de auditoría de la acción (el de la Mesa en los careos). */
  runId: number;
  /** Estado de la revisión después de actuar. */
  status: string;
  detail: string;
}

interface LoadedReview {
  id: number;
  kind: string;
  status: string;
  claimId?: number;
  conflictId?: number;
  payload: Record<string, unknown>;
  entityKind?: string;
  identityKey?: string;
  field?: string;
  claimTargetId?: number;
  topCandidateId?: number;
}

function positive(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

async function loadOpenReview(reviewId: number): Promise<LoadedReview> {
  const { rows } = await getPool().query<{
    id: string; kind: string; status: string; claim_a_id: string | null; conflict_id: string | null;
    payload: Record<string, unknown> | null; entity_kind: string | null; identity_key: string | null; field: string | null;
    claim_target_id: string | null; top_candidate_id: string | null;
  }>(`
    SELECT q.id::text,q.kind::text,q.status::text,q.claim_a_id::text,q.conflict_id::text,q.payload,
           c.entity_kind::text,c.identity_key,c.field,
           COALESCE(c.artist_id,c.person_id,c.organization_id,c.album_id,c.track_id)::text AS claim_target_id,
           er.candidates->0->>'candidateId' AS top_candidate_id
      FROM ingest.review_queue q
      LEFT JOIN ingest.claims c ON c.id=q.claim_a_id
      LEFT JOIN ingest.entity_resolution_decisions er
        ON er.id=CASE WHEN q.payload->>'resolutionDecisionId' ~ '^[1-9][0-9]*$'
                      THEN (q.payload->>'resolutionDecisionId')::bigint END
     WHERE q.id=$1`, [reviewId]);
  const row = rows[0];
  if (!row) throw new OperatorError("not_found", `review_queue ${reviewId} inexistente`, { entity: "review_queue", id: reviewId });
  if (row.status !== "open" && row.status !== "in_progress") {
    throw new OperatorError("not_open", `la revisión ${reviewId} ya está ${row.status}`, { status: row.status });
  }
  const optional = <K extends string, V>(key: K, value: V | undefined) => (value === undefined ? {} : { [key]: value } as Record<K, V>);
  return {
    id: Number(row.id), kind: row.kind, status: row.status, payload: row.payload ?? {},
    ...optional("claimId", positive(row.claim_a_id)),
    ...optional("conflictId", positive(row.conflict_id)),
    ...optional("entityKind", row.entity_kind ?? undefined),
    ...optional("identityKey", row.identity_key ?? undefined),
    ...optional("field", row.field ?? undefined),
    ...optional("claimTargetId", positive(row.claim_target_id)),
    ...optional("topCandidateId", positive(row.top_candidate_id)),
  };
}

async function reviewStatus(reviewId: number): Promise<string> {
  const { rows } = await getPool().query<{ status: string }>("SELECT status::text FROM ingest.review_queue WHERE id=$1", [reviewId]);
  return rows[0]?.status ?? "deleted";
}

function signed(input: ReviewActionInput): string {
  return `[${input.operator}] ${input.note.trim()}`;
}

/** Run de auditoría para las acciones cuyo aplicador gestiona sus propias transacciones. */
async function recordRun(name: string, input: ReviewActionInput, params: Record<string, unknown>): Promise<number> {
  const { runId } = await withOperatorRun({ name, operator: input.operator, note: input.note, params }, async () => undefined);
  return runId;
}

function asOperatorError(error: unknown): unknown {
  if (error instanceof OperatorError || (error as { code?: string }).code !== undefined) return error;
  return error instanceof Error ? new OperatorError("needs_review", error.message) : error;
}

/**
 * Careo de la Mesa: la decisión se guarda como cualquier otra de la Mesa y se
 * aplica solo esta revisión. Si no se pudo aplicar, la decisión se retira
 * para no dejar en la Mesa una elección que nunca tuvo efecto.
 */
async function mesaVerdict(review: LoadedReview, verdict: "same" | "different", input: ReviewActionInput): Promise<ReviewActionResult> {
  const client = await getPool().connect();
  let decisionId: number;
  try {
    await client.query("BEGIN");
    await client.query(`
      UPDATE ingest.review_decisions SET status='withdrawn',withdrawn_at=now()
       WHERE review_id=$1 AND decided_by=$2 AND status='active'`, [review.id, input.operator]);
    const saved = await client.query<{ id: string }>(`
      INSERT INTO ingest.review_decisions(review_id,verdict,decided_by,note,context)
      VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id::text`,
    [review.id, verdict, input.operator, input.note.trim(), JSON.stringify({ via: "api", topCandidateId: review.topCandidateId ?? null })]);
    decisionId = Number(saved.rows[0]!.id);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const result = await applyReviewDecisions(signed(input), { reviewIds: [review.id] });
  if (result.failed > 0 || result.appliedReviews === 0) {
    await getPool().query(`
      UPDATE ingest.review_decisions SET status='withdrawn',withdrawn_at=now()
       WHERE id=$1 AND applied_at IS NULL`, [decisionId]);
    throw new OperatorError("needs_review", result.errors[0]?.error ?? "la decisión no se pudo aplicar", { runId: result.runId });
  }
  return {
    reviewId: review.id, kind: review.kind, action: verdict === "same" ? "accepted" : "rejected",
    runId: result.runId, status: await reviewStatus(review.id),
    detail: verdict === "same" ? "identidad confirmada contra el candidato" : "candidato descartado",
  };
}

/** Propuesta del ER fuera de la Mesa: el merge con la anulación humana, en una transacción. */
async function erVerdict(
  review: LoadedReview, verdict: "same" | "different", input: ReviewActionInput & { targetId?: number },
): Promise<ReviewActionResult> {
  if (review.claimId === undefined || review.payload["resolutionDecisionId"] === undefined) {
    throw new OperatorError("invalid", `la revisión ${review.id} no es una propuesta de identidad del ER`);
  }
  const loaded = await loadClaimForApproval(review.claimId);
  if (!loaded || !resolvableSpec(loaded.entityKind)) throw new OperatorError("invalid", `claim ${review.claimId} no es de una entidad resoluble`);
  const targetId = input.targetId ?? review.topCandidateId;
  if (verdict === "same" && targetId === undefined) throw new OperatorError("invalid", "la revisión no tiene candidato; indique targetId");
  const { runId, result } = await withOperatorRun({
    name: `review:${verdict === "same" ? "accept" : "reject"}`, operator: input.operator, note: input.note,
    params: { reviewId: review.id, kind: review.kind, verdict, ...(targetId === undefined ? {} : { targetId }) },
  }, async (context) => {
    const outcome = await mergeClaim({ ...loaded, createdBy: "human", runId: context.runId }, { id: review.claimId!, inserted: false }, {
      client: context.client,
      humanResolution: verdict === "same"
        ? { verdict: "same", targetId: targetId!, decidedBy: input.operator }
        : { verdict: "different", decidedBy: input.operator },
    });
    if (outcome.action === "candidate" || outcome.action === "unsupported") throw new OperatorError("needs_review", outcome.detail);
    await context.client.query(`
      UPDATE ingest.review_queue SET status='approved',resolved_by='human',resolution_note=$2,resolved_at=now(),updated_at=now()
       WHERE id=$1 AND status IN ('open','in_progress')`, [review.id, signed(input)]);
    return outcome;
  }).catch((error: unknown) => { throw asOperatorError(error); });
  return {
    reviewId: review.id, kind: review.kind, action: verdict === "same" ? "accepted" : "rejected",
    runId, status: await reviewStatus(review.id), detail: result.detail,
  };
}

function refuseUnsupported(review: LoadedReview): void {
  if (review.kind === "field_conflict") {
    throw new OperatorError("invalid", "un conflicto de campo se resuelve con resolve-conflict (elegir un lado o afirmar un valor)");
  }
  const hint = CLI_ONLY[review.kind];
  if (hint) throw new OperatorError("invalid", `una revisión ${review.kind} no se decide por la API: ${hint}`);
}

export async function acceptReview(reviewId: number, input: ReviewActionInput & { targetId?: number }): Promise<ReviewActionResult> {
  const review = await loadOpenReview(reviewId);
  refuseUnsupported(review);
  // Un duplicado de persona no se «acepta» como un candidato cualquiera: se
  // fusiona con la ficha que una persona elige (POST /persons/:id/merge), o se
  // rechaza como «son distintas». Aceptar aquí dejaría el par sin destino.
  if (review.kind === PERSON_DUPLICATE) {
    throw new OperatorError("invalid",
      "un duplicado de persona se resuelve fusionando (POST /persons/:id/merge) o rechazando la revisión como «son distintas»");
  }
  if (MESA_KINDS.has(review.kind)) {
    if (input.targetId !== undefined && input.targetId !== review.topCandidateId) {
      throw new OperatorError("invalid", `el candidato de esta revisión es ${review.topCandidateId ?? "ninguno"}, no ${input.targetId}`);
    }
    return mesaVerdict(review, "same", input);
  }
  if (ER_KINDS.has(review.kind) && review.payload["resolutionDecisionId"] !== undefined) return erVerdict(review, "same", input);

  if (review.kind === "ai_biography") {
    const bio = await getPool().query<{ id: string }>("SELECT id::text FROM ingest.ai_biographies WHERE review_queue_id=$1", [review.id]);
    if (!bio.rows[0]) throw new OperatorError("invalid", `la revisión ${review.id} no tiene borrador asociado`);
    await approveBiographyDraft(Number(bio.rows[0].id), signed(input)).catch((error: unknown) => { throw asOperatorError(error); });
    const runId = await recordRun("review:accept", input, { reviewId, kind: review.kind, biographyId: Number(bio.rows[0].id) });
    return { reviewId, kind: review.kind, action: "accepted", runId, status: await reviewStatus(reviewId), detail: "borrador de biografía aprobado" };
  }

  if (CLAIM_KINDS.has(review.kind) && review.entityKind && review.identityKey) {
    let approval;
    try {
      approval = await approveEntity(review.entityKind, review.identityKey, signed(input));
    } catch (error) {
      throw asOperatorError(error);
    }
    const runId = await recordRun("review:accept", input, { reviewId, kind: review.kind, approval });
    if (approval.applied + approval.unchanged === 0) {
      throw new OperatorError("needs_review", "ningún claim de la entidad pudo aplicarse; siguen candidatos", { runId, approval });
    }
    return {
      reviewId, kind: review.kind, action: "accepted", runId, status: await reviewStatus(reviewId),
      detail: `${approval.applied} aplicados, ${approval.unchanged} ya coincidían, ${approval.stillCandidate} siguen candidatos`,
    };
  }

  // Revisiones sin efecto en el core (fuente nueva, URL faltante...): se cierran con la nota.
  await resolveReview(reviewId, "approved", signed(input)).catch((error: unknown) => { throw asOperatorError(error); });
  const runId = await recordRun("review:accept", input, { reviewId, kind: review.kind });
  return { reviewId, kind: review.kind, action: "accepted", runId, status: await reviewStatus(reviewId), detail: "revisión cerrada sin cambios en el core" };
}

export async function rejectReview(reviewId: number, input: ReviewActionInput): Promise<ReviewActionResult> {
  const review = await loadOpenReview(reviewId);
  refuseUnsupported(review);
  // «Son distintas»: se cierra la revisión y el detector no volverá a
  // proponer el par (lo lee de las revisiones descartadas). No toca claims
  // ni el core: nadie afirmó que fueran la misma ficha.
  if (review.kind === PERSON_DUPLICATE) {
    await resolveReview(reviewId, "dismissed", signed(input)).catch((error: unknown) => { throw asOperatorError(error); });
    const runId = await recordRun("review:reject", input, { reviewId, kind: review.kind });
    return {
      reviewId, kind: review.kind, action: "rejected", runId, status: await reviewStatus(reviewId),
      detail: "par descartado: son dos personas distintas y el detector no volverá a proponerlo",
    };
  }
  if (MESA_KINDS.has(review.kind)) return mesaVerdict(review, "different", input);
  if (ER_KINDS.has(review.kind) && review.payload["resolutionDecisionId"] !== undefined) return erVerdict(review, "different", input);

  if (CLAIM_KINDS.has(review.kind) && review.entityKind && review.identityKey) {
    let dismissal;
    try {
      dismissal = await dismissEntity(review.entityKind, review.identityKey, signed(input));
    } catch (error) {
      throw asOperatorError(error);
    }
    const runId = await recordRun("review:reject", input, { reviewId, kind: review.kind, dismissal });
    return {
      reviewId, kind: review.kind, action: "rejected", runId, status: await reviewStatus(reviewId),
      detail: `claims candidatos rechazados; ${dismissal.reviewsClosed} revisiones cerradas`,
    };
  }

  await resolveReview(reviewId, "dismissed", signed(input)).catch((error: unknown) => { throw asOperatorError(error); });
  const runId = await recordRun("review:reject", input, { reviewId, kind: review.kind });
  return { reviewId, kind: review.kind, action: "rejected", runId, status: await reviewStatus(reviewId), detail: "revisión descartada sin cambios en el core" };
}

export interface ReviewPriorityResult {
  reviewId: number;
  priority: number;
  runId: number;
}

/**
 * Cambia el orden de una revisión en la cola (1-10, mayor = más urgente). No
 * toca el core: solo re-ordena qué se atiende primero, así que el run queda
 * como rastro de auditoría sin `merge_audit` asociado.
 */
export async function setReviewPriority(reviewId: number, priority: number, input: ReviewActionInput): Promise<ReviewPriorityResult> {
  if (!Number.isInteger(priority) || priority < 1 || priority > 10) {
    throw new OperatorError("invalid", `la prioridad debe ser un entero entre 1 y 10 (recibido: ${priority})`);
  }
  await loadOpenReview(reviewId);
  const { runId, result } = await withOperatorRun({
    name: "review:set-priority", operator: input.operator, note: input.note,
    params: { reviewId, priority },
  }, async (context) => {
    const { rows } = await context.client.query<{ priority: number }>(
      "UPDATE ingest.review_queue SET priority=$2, updated_at=now() WHERE id=$1 RETURNING priority::int", [reviewId, priority]);
    return rows[0]!.priority;
  });
  return { reviewId, priority: result, runId };
}

export type ConflictChoice = "canonical" | "proposed" | "a" | "b" | "both" | "dismiss";

/** Entidad, destino y campo del conflicto: del payload y, si falta, del claim. */
function conflictTarget(review: LoadedReview): { kind: ResolvableClaimKind; targetId: number; field: string } {
  const kind = (typeof review.payload["entityKind"] === "string" ? review.payload["entityKind"] : review.entityKind) as ResolvableClaimKind | undefined;
  const targetId = positive(review.payload["targetId"]) ?? review.claimTargetId;
  const field = typeof review.payload["field"] === "string" ? review.payload["field"] : review.field;
  if (!kind || !resolvableSpec(kind) || targetId === undefined || !field) {
    throw new OperatorError("invalid", `la revisión ${review.id} no identifica entidad, destino y campo`);
  }
  return { kind, targetId, field };
}

async function conflictSide(review: LoadedReview, choice: "canonical" | "proposed"): Promise<"resolved_a" | "resolved_b"> {
  const wanted = positive(review.payload[choice === "canonical" ? "canonicalClaimId" : "proposedClaimId"]);
  const { rows } = await getPool().query<{ claim_a_id: string; claim_b_id: string }>(
    "SELECT claim_a_id::text,claim_b_id::text FROM ingest.conflicts WHERE id=$1", [review.conflictId]);
  const conflict = rows[0];
  if (!conflict || wanted === undefined) {
    throw new OperatorError("invalid", "la revisión no dice qué lado es el valor actual; elija a o b");
  }
  if (Number(conflict.claim_a_id) === wanted) return "resolved_a";
  if (Number(conflict.claim_b_id) === wanted) return "resolved_b";
  throw new OperatorError("invalid", "los claims de la revisión no coinciden con los del conflicto; elija a o b");
}

/**
 * Resolver un conflicto de campo. Con `choice` se elige un lado del conflicto
 * (o conservar ambos / descartarlo); con `value`, la persona afirma el valor
 * correcto —puede no ser ninguno de los rivales— y esa corrección cierra todos
 * los conflictos abiertos del campo conservando el historial.
 */
export async function resolveReviewConflict(
  reviewId: number,
  input: ReviewActionInput & { choice?: ConflictChoice; value?: string | number | boolean | null },
): Promise<ReviewActionResult> {
  const review = await loadOpenReview(reviewId);
  if (review.kind !== "field_conflict") throw new OperatorError("invalid", `la revisión ${reviewId} es ${review.kind}, no field_conflict`);
  const hasValue = Object.hasOwn(input, "value") && input.value !== undefined;
  if (hasValue === (input.choice !== undefined)) throw new OperatorError("invalid", "indique choice o value, no ambos");
  const target = conflictTarget(review);

  // Sin fila de conflicto (contradicción contra un valor sin claim rival) o
  // con un valor afirmado: es una corrección del operador.
  let value = input.value;
  if (!hasValue && review.conflictId === undefined) {
    if (input.choice === "canonical") value = review.payload["canonicalValue"] as typeof value;
    else if (input.choice === "proposed") value = review.payload["proposedValue"] as typeof value;
    else throw new OperatorError("invalid", "esta revisión no tiene fila de conflicto: elija canonical, proposed o un value");
  }
  if (hasValue || review.conflictId === undefined) {
    const { runId, result } = await withOperatorRun({
      name: "review:resolve-conflict", operator: input.operator, note: input.note,
      params: { reviewId, ...target, value, ...(input.choice === undefined ? {} : { choice: input.choice }) },
    }, (context) => settleEntityField(context, target.kind, target.targetId, target.field, value));
    const status = await reviewStatus(reviewId);
    if (status === "open" || status === "in_progress") {
      await resolveReview(reviewId, "approved", signed(input));
    }
    return {
      reviewId, kind: review.kind, action: "resolved", runId, status: await reviewStatus(reviewId),
      detail: `${target.kind} ${target.targetId}.${target.field} = ${JSON.stringify(value)} (${result.action}); conflictos cerrados: ${result.conflictsClosed.length}`,
    };
  }

  const choice = input.choice!;
  const resolution: ConflictResolution = choice === "a" ? "resolved_a" : choice === "b" ? "resolved_b"
    : choice === "both" ? "both_kept" : choice === "dismiss" ? "dismissed" : await conflictSide(review, choice);
  const { runId } = await withOperatorRun({
    name: "review:resolve-conflict", operator: input.operator, note: input.note,
    params: { reviewId, conflictId: review.conflictId, ...target, choice, resolution },
  }, (context) => resolveFieldConflict(review.conflictId!, resolution, {
    actor: "human", note: signed(input), runId: context.runId, client: context.client,
  })).catch((error: unknown) => { throw asOperatorError(error); });
  return {
    reviewId, kind: review.kind, action: "resolved", runId, status: await reviewStatus(reviewId),
    detail: `conflicto ${review.conflictId} → ${resolution}`,
  };
}

// ---------------------------------------------------------------------------
// Conflictos sin revisión viva (PLAN_CURADURIA E7.1, detector `conflictos_
// abiertos`): la pareja review+conflicto se crea junta (src/conflicts/engine.ts),
// pero una revisión cerrada por otra vía dejó su conflicto abierto sin nadie
// que lo lleve a una persona. No hay `reviewId`: se resuelve directo contra
// `ingest.conflicts`, con las mismas garantías (nota firmada, un solo lado a
// la vez, cierre de claims) que `resolveReviewConflict`.
// ---------------------------------------------------------------------------

interface LoadedConflict {
  id: number;
  status: string;
  kind: ResolvableClaimKind;
  targetId: number;
  field: string;
}

async function loadOpenConflict(conflictId: number): Promise<LoadedConflict> {
  const { rows } = await getPool().query<{ id: string; status: string; entity_kind: string; field: string; target_id: string | null }>(`
    SELECT c.id::text, c.status::text, c.entity_kind::text, c.field,
           COALESCE(a.artist_id, a.person_id, a.organization_id, a.album_id, a.track_id)::text AS target_id
      FROM ingest.conflicts c JOIN ingest.claims a ON a.id=c.claim_a_id
     WHERE c.id=$1`, [conflictId]);
  const row = rows[0];
  if (!row) throw new OperatorError("not_found", `conflicto ${conflictId} inexistente`, { entity: "conflict", id: conflictId });
  const kind = row.entity_kind as ResolvableClaimKind;
  const targetId = positive(row.target_id);
  if (!resolvableSpec(kind) || targetId === undefined) throw new OperatorError("invalid", `el conflicto ${conflictId} no identifica una entidad resoluble`);
  return { id: Number(row.id), status: row.status, kind, targetId, field: row.field };
}

/**
 * Resuelve un conflicto que no tiene una revisión viva que lo lleve a una
 * persona: elegir un lado (`choice`), o afirmar el valor correcto (`value`,
 * puede no ser ninguno de los rivales). `canonical`/`proposed` no aplican
 * aquí (son de una revisión con esos valores en su payload).
 */
export async function resolveOpenConflict(
  conflictId: number,
  input: ReviewActionInput & { choice?: "a" | "b" | "both" | "dismiss"; value?: string | number | boolean | null },
): Promise<{ conflictId: number; action: "resolved"; runId: number; detail: string }> {
  const hasValue = Object.hasOwn(input, "value") && input.value !== undefined;
  if (hasValue === (input.choice !== undefined)) throw new OperatorError("invalid", "indique choice o value, no ambos");
  const conflict = await loadOpenConflict(conflictId);
  if (conflict.status !== "open") throw new OperatorError("not_open", `el conflicto ${conflictId} ya está ${conflict.status}`);

  if (hasValue) {
    const { runId, result } = await withOperatorRun({
      name: "curation:resolve-conflict", operator: input.operator, note: input.note,
      params: { conflictId, kind: conflict.kind, targetId: conflict.targetId, field: conflict.field, value: input.value },
    }, (context) => settleEntityField(context, conflict.kind, conflict.targetId, conflict.field, input.value));
    return {
      conflictId, action: "resolved", runId,
      detail: `${conflict.kind} ${conflict.targetId}.${conflict.field} = ${JSON.stringify(input.value)} (${result.action}); conflictos cerrados: ${result.conflictsClosed.length}`,
    };
  }

  const choice = input.choice!;
  const resolution: ConflictResolution = choice === "a" ? "resolved_a" : choice === "b" ? "resolved_b" : choice === "both" ? "both_kept" : "dismissed";
  const { runId } = await withOperatorRun({
    name: "curation:resolve-conflict", operator: input.operator, note: input.note,
    params: { conflictId, choice, resolution },
  }, (context) => resolveFieldConflict(conflictId, resolution, {
    actor: "human", note: signed(input), runId: context.runId, client: context.client,
  })).catch((error: unknown) => { throw asOperatorError(error); });
  return { conflictId, action: "resolved", runId, detail: `conflicto ${conflictId} → ${resolution}` };
}
