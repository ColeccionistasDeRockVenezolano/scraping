// Aplicación auditada de las decisiones provisionales de la Mesa de Cotejo.
//
// `unsure` es deliberadamente un estado terminal de la sesión de cotejo, no
// una autorización: permanece visible, activo y sin applied_at hasta que una
// persona consiga evidencia y cambie el veredicto.
import { getPool } from "../db/client.js";
import type { ClaimToPersist } from "../claims/persistence.js";
import type { ResolutionInput } from "../er/types.js";
import { finishRun } from "../ingest/runs.js";
import { mergeClaim, resolveFieldConflict, type ConflictResolution } from "../merge/engine.js";
import { ENTITY_SPECS, type ResolvableClaimKind } from "../merge/specs.js";
import { normalizeDisplayName, normalizeEntityName } from "../normalization/entity-name.js";
import { loadClaimForApproval } from "./approval.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("review:decisions");
const MATCH_KINDS = new Set(["album_match", "person_match", "organization_match"]);
const MATCH_VERDICTS = new Set(["same", "different", "unsure"]);
const CONFLICT_VERDICTS = new Set(["canonical", "proposed", "unsure"]);

type MesaVerdict = "same" | "different" | "unsure" | "canonical" | "proposed";

interface DecisionRow {
  decision_id: string;
  review_id: string;
  verdict: MesaVerdict;
  decided_by: string;
  applied_at: Date | null;
  kind: string;
  status: string;
  claim_id: string | null;
  source_id: string | null;
  conflict_id: string | null;
  payload: Record<string, unknown> | null;
  decision_context: Record<string, unknown> | null;
  entity_kind: string | null;
  identity_key: string | null;
  field: string | null;
  resolution_input: ResolutionInput | null;
  top_candidate_id: string | null;
  claim_target_id: string | null;
}

interface ReviewWork {
  reviewId: number;
  decisionIds: number[];
  verdict: MesaVerdict;
  decidedBy: string;
  applied: boolean;
  appliedAny: boolean;
  appliedDecisionIds: number[];
  kind: string;
  status: string;
  claimId?: number;
  sourceId?: number;
  conflictId?: number;
  payload: Record<string, unknown>;
  decisionContext: Record<string, unknown>;
  entityKind?: string;
  identityKey?: string;
  field?: string;
  resolutionInput?: ResolutionInput;
  topCandidateId?: number;
  claimTargetId?: number;
  matchMode?: "merge" | "exclude";
  resolvedTargetId?: number;
  /** Candidatos que alguna persona descartó para esta identidad, en cualquier fuente. */
  excludedTargetIds?: number[];
  replayAppliedExclusion?: boolean;
  error?: string;
}

export interface DecisionPlan {
  total: number;
  actionable: number;
  unsure: number;
  alreadyApplied: number;
  invalid: number;
  byVerdict: Partial<Record<MesaVerdict, number>>;
}

export interface DecisionApplicationResult extends DecisionPlan {
  runId: number;
  appliedReviews: number;
  appliedDecisionRows: number;
  failed: number;
  errors: Array<{ reviewId: number; error: string }>;
}

function asPositiveNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

const COMPARABLE_INTEGER_FIELDS = new Set([
  "formed_year", "disbanded_year", "release_year", "disc_number", "track_number",
  "duration_seconds", "youtube_start_seconds", "label_id",
]);
function comparableFieldValue(value: unknown, field: string): unknown {
  if (value === null) return null;
  if (COMPARABLE_INTEGER_FIELDS.has(field)) {
    const parsed = typeof value === "number" ? value : Number(String(value).replace(/\s+/gu, "").replace(/\.0+$/u, ""));
    return Number.isInteger(parsed) ? parsed : value;
  }
  if (field === "organization_type" && value === "label") return "record_label";
  if (typeof value === "string") return normalizeDisplayName(value);
  return value;
}
function sameFieldValue(left: unknown, right: unknown, field: string): boolean {
  return JSON.stringify(comparableFieldValue(left, field)) === JSON.stringify(comparableFieldValue(right, field));
}

async function loadWork(): Promise<ReviewWork[]> {
  const { rows } = await getPool().query<DecisionRow>(`
    SELECT d.id::text AS decision_id,d.review_id::text,d.verdict,d.decided_by,d.applied_at,
           q.kind::text,q.status::text,q.claim_a_id::text AS claim_id,q.conflict_id::text,
           q.payload,d.context AS decision_context,c.entity_kind::text,c.identity_key,c.field,
           c.source_id::text,
           er.input_context AS resolution_input,
           er.candidates->0->>'candidateId' AS top_candidate_id,
           COALESCE(c.artist_id,c.person_id,c.organization_id,c.album_id,c.track_id)::text AS claim_target_id
      FROM ingest.review_decisions d
      JOIN ingest.review_queue q ON q.id=d.review_id
      LEFT JOIN ingest.claims c ON c.id=q.claim_a_id
      LEFT JOIN ingest.entity_resolution_decisions er
        ON er.id=CASE
          WHEN q.payload->>'resolutionDecisionId' ~ '^[1-9][0-9]*$'
          THEN (q.payload->>'resolutionDecisionId')::bigint
        END
     WHERE d.status='active'
     ORDER BY CASE WHEN q.kind='field_conflict' THEN 2 ELSE 1 END,
              CASE c.entity_kind::text WHEN 'organization' THEN 1 WHEN 'artist' THEN 2
                   WHEN 'person' THEN 3 WHEN 'album' THEN 4 WHEN 'track' THEN 5 ELSE 9 END,
              c.identity_key,
              CASE WHEN c.field IN ('name','title') THEN 0 ELSE 1 END,
              q.id,d.id`);

  const grouped = new Map<number, ReviewWork & { verdicts: Set<MesaVerdict>; actors: Set<string> }>();
  for (const row of rows) {
    const reviewId = Number(row.review_id);
    let item = grouped.get(reviewId);
    if (!item) {
      item = {
        reviewId, decisionIds: [], verdict: row.verdict, decidedBy: row.decided_by,
        applied: false, appliedAny: false, appliedDecisionIds: [], kind: row.kind, status: row.status,
        ...(row.claim_id === null ? {} : { claimId: Number(row.claim_id) }),
        ...(row.source_id === null ? {} : { sourceId: Number(row.source_id) }),
        ...(row.conflict_id === null ? {} : { conflictId: Number(row.conflict_id) }),
        payload: row.payload ?? {},
        decisionContext: row.decision_context ?? {},
        ...(row.entity_kind === null ? {} : { entityKind: row.entity_kind }),
        ...(row.identity_key === null ? {} : { identityKey: row.identity_key }),
        ...(row.field === null ? {} : { field: row.field }),
        ...(row.resolution_input === null ? {} : { resolutionInput: row.resolution_input }),
        ...(asPositiveNumber(row.top_candidate_id) === undefined ? {} : { topCandidateId: Number(row.top_candidate_id) }),
        ...(asPositiveNumber(row.claim_target_id) === undefined ? {} : { claimTargetId: Number(row.claim_target_id) }),
        verdicts: new Set(), actors: new Set(),
      };
      grouped.set(reviewId, item);
    }
    item.decisionIds.push(Number(row.decision_id));
    if (row.applied_at !== null) item.appliedDecisionIds.push(Number(row.decision_id));
    item.verdicts.add(row.verdict);
    item.actors.add(row.decided_by);
    item.appliedAny ||= row.applied_at !== null;
  }

  const work = [...grouped.values()].map((item) => {
    // Varias personas pueden coincidir en una misma revisión. El efecto se
    // considera completamente aplicado sólo cuando todas sus filas activas
    // tienen applied_at; una adhesión posterior no debe quedar invisible.
    item.applied = item.appliedDecisionIds.length === item.decisionIds.length;
    if (item.verdicts.size !== 1) item.error = `veredictos activos incompatibles: ${[...item.verdicts].join(", ")}`;
    item.verdict = [...item.verdicts][0] ?? item.verdict;
    item.decidedBy = [...item.actors].join(", ");
    if (MATCH_KINDS.has(item.kind) && !MATCH_VERDICTS.has(item.verdict)) {
      item.error = `veredicto ${item.verdict} inválido para ${item.kind}`;
    }
    if (item.kind === "field_conflict" && !CONFLICT_VERDICTS.has(item.verdict)) {
      item.error = `veredicto ${item.verdict} inválido para field_conflict`;
    }
    if (!MATCH_KINDS.has(item.kind) && item.kind !== "field_conflict") {
      item.error = `tipo de revisión no aplicable desde la mesa: ${item.kind}`;
    }
    return item;
  });

  // La mesa puede contener varios careos del mismo claim/entidad, generados
  // en barridos distintos. `different` descarta ESE candidato: solo significa
  // "crear una ficha nueva" cuando todos los candidatos fueron descartados y
  // no queda ningún unsure. Un same positivo fija el destino de la identidad.
  const identities = new Map<string, ReviewWork[]>();
  for (const item of work.filter((candidate) => MATCH_KINDS.has(candidate.kind))) {
    const key = [item.sourceId, item.entityKind, item.identityKey].join("|");
    const group = identities.get(key) ?? [];
    group.push(item);
    identities.set(key, group);
  }
  for (const group of identities.values()) {
    const sameTargets = new Set(group.filter((item) => item.verdict === "same").map((item) => item.topCandidateId).filter((id): id is number => id !== undefined));
    const differentTargets = new Set(group.filter((item) => item.verdict === "different").map((item) => item.topCandidateId).filter((id): id is number => id !== undefined));
    const contradictory = [...sameTargets].filter((id) => differentTargets.has(id));
    if (sameTargets.size > 1 || contradictory.length > 0) {
      const reason = sameTargets.size > 1
        ? `la misma identidad fue marcada same contra varios destinos: ${[...sameTargets].join(", ")}`
        : `la misma identidad fue marcada same y different contra ${contradictory.join(", ")}`;
      for (const item of group) item.error = reason;
      continue;
    }
    const resolvedTargetId = [...sameTargets][0];
    const hasUnsure = group.some((item) => item.verdict === "unsure" && !item.applied);
    for (const item of group) {
      if (item.verdict === "unsure") continue;
      if (resolvedTargetId !== undefined) {
        item.matchMode = "merge";
        item.resolvedTargetId = resolvedTargetId;
      } else if (hasUnsure) {
        // Se incorpora la exclusión humana, pero el claim sigue candidato:
        // todavía no hay autorización para elegir/crear su identidad.
        item.matchMode = "exclude";
      } else {
        item.matchMode = "merge";
      }
      // Una exclusión aplicada mientras aún quedaba un `unsure` cerró su
      // careo sin adjuntar el claim. Cuando la identidad queda finalmente
      // resuelta, ese claim debe reanudarse aunque su decisión ya tenga
      // applied_at; de otro modo se pierden campos como release_year.
      if (item.appliedAny && item.verdict === "different" && item.matchMode === "merge" && item.claimTargetId === undefined) {
        item.replayAppliedExclusion = true;
      }
    }
  }
  // Un descarte vale para la identidad, no para la fuente que lo mostró: el
  // destino que otra fuente ya creó nunca puede ser uno de estos.
  const excludedByIdentity = new Map<string, Set<number>>();
  for (const item of work) {
    if (!MATCH_KINDS.has(item.kind) || item.verdict !== "different" || item.topCandidateId === undefined) continue;
    const key = `${item.entityKind}|${item.identityKey}`;
    const excluded = excludedByIdentity.get(key) ?? new Set<number>();
    excluded.add(item.topCandidateId);
    excludedByIdentity.set(key, excluded);
  }
  for (const item of work) item.excludedTargetIds = [...(excludedByIdentity.get(`${item.entityKind}|${item.identityKey}`) ?? [])];
  return work;
}

function summarize(work: ReviewWork[]): DecisionPlan {
  const byVerdict: DecisionPlan["byVerdict"] = {};
  for (const item of work) byVerdict[item.verdict] = (byVerdict[item.verdict] ?? 0) + 1;
  return {
    total: work.length,
    actionable: work.filter((item) => (!item.applied || item.replayAppliedExclusion) && !item.error && item.verdict !== "unsure").length,
    unsure: work.filter((item) => !item.applied && item.verdict === "unsure").length,
    alreadyApplied: work.filter((item) => item.applied && !item.replayAppliedExclusion).length,
    invalid: work.filter((item) => item.error !== undefined).length,
    byVerdict,
  };
}

/** Previsualización pura: no abre un merge_run ni cambia la cola. */
export async function planReviewDecisions(): Promise<DecisionPlan> {
  return summarize(await loadWork());
}

function withTarget(claim: ClaimToPersist, kind: string, targetId: number): ClaimToPersist {
  if (kind === "artist") return { ...claim, artistId: targetId };
  if (kind === "person") return { ...claim, personId: targetId };
  if (kind === "organization") return { ...claim, organizationId: targetId };
  if (kind === "album") return { ...claim, albumId: targetId };
  if (kind === "track") return { ...claim, trackId: targetId };
  throw new Error(`entity_kind no resoluble: ${kind}`);
}

/**
 * Los claims historicos de album usaban solo el titulo como identity_raw. En
 * esas filas el ResolutionInput persistido tampoco incluye al artista, aunque
 * el claim hermano `artist_name` si lo conserva. Recuperarlo aqui permite que
 * una decision humana `different` cree el album bajo su artista real; sin ese
 * parental el merge solo puede devolver NO_MATCH otra vez.
 */
async function resolutionInputWithSiblingContext(item: ReviewWork): Promise<ResolutionInput | undefined> {
  const input = item.resolutionInput;
  if (item.entityKind !== "album" || input?.kind !== "ALBUM" || input.artist?.id !== undefined) return input;
  let artistName = input.artist?.name;
  if (artistName === undefined) {
    if (item.sourceId === undefined || item.identityKey === undefined) return input;
    const { rows } = await getPool().query<{ value: unknown }>(`
      SELECT COALESCE(normalized_value,raw_value) AS value
        FROM ingest.claims
       WHERE source_id=$1 AND entity_kind='album' AND identity_key=$2
         AND field='artist_name' AND status IN ('candidate','accepted')
       ORDER BY id LIMIT 1`, [item.sourceId, item.identityKey]);
    const value = rows[0]?.value;
    if (typeof value !== "string" || !value.trim()) return input;
    artistName = value.trim();
  }
  // El ER puntúa un alias exacto como POSSIBLE_MATCH, y crear un disco exige
  // un AUTO_MATCH de su artista: "Pacífica" nunca encontraba a Pacifica aunque
  // una persona ya hubiera registrado el alias. Aquí la separación del disco
  // ya la decidió una persona; basta un nombre o alias exacto con un único
  // artista detrás para fijar el parental.
  const key = normalizeEntityName(artistName).primaryKey;
  const { rows: artists } = await getPool().query<{ id: string }>(`
    SELECT DISTINCT id::text FROM (
      SELECT a.id FROM public.artists a WHERE a.name=$1
      UNION SELECT aa.artist_id FROM ingest.artist_aliases aa WHERE aa.normalized_alias=$2
    ) found`, [artistName, key]);
  const artistId = artists.length === 1 ? Number(artists[0]!.id) : undefined;
  return { ...input, artist: { name: artistName, ...(artistId === undefined ? {} : { id: artistId }) } };
}

async function closeReviewAndMark(item: ReviewWork, runId: number, note: string): Promise<number> {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      UPDATE ingest.review_queue
         SET status='approved',resolved_by='human',resolution_note=$2,resolved_at=now(),updated_at=now()
       WHERE id=$1 AND status IN ('open','in_progress')`, [item.reviewId, note]);
    const marked = await client.query(`
      UPDATE ingest.review_decisions
         SET applied_at=COALESCE(applied_at,now()),applied_run_id=COALESCE(applied_run_id,$2)
       WHERE review_id=$1 AND status='active' AND verdict=$3 AND applied_at IS NULL`, [item.reviewId, runId, item.verdict]);
    await client.query("COMMIT");
    return marked.rowCount ?? 0;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function applyMatch(item: ReviewWork, runId: number): Promise<void> {
  if (!item.claimId) throw new Error("careo sin claim");
  if (item.verdict !== "same" && item.verdict !== "different") throw new Error("careo sin resolución concluyente");
  if (item.verdict === "same" && !item.topCandidateId) throw new Error("careo 'same' sin candidato de catálogo");
  if (item.matchMode === "exclude") return;
  const loaded = await loadClaimForApproval(item.claimId);
  if (!loaded) throw new Error(`claim inexistente: ${item.claimId}`);
  const resolutionInput = await resolutionInputWithSiblingContext(item);
  let claim: ClaimToPersist = {
    ...loaded, createdBy: "human", runId,
    ...(resolutionInput === undefined ? {} : { resolutionInput }),
  };
  if (item.resolvedTargetId !== undefined) claim = withTarget(claim, item.entityKind!, item.resolvedTargetId);
  // La hoja y la API afirman el mismo disco con la misma identity_key, pero
  // son fuentes distintas: sin esto, cada `different` crea su propio álbum y
  // el core queda con dos copias. Si otra fuente ya materializó la identidad
  // en un destino que ninguna persona descartó, ese es el destino.
  if (item.verdict === "different" && item.resolvedTargetId === undefined && claim.albumId === undefined
    && item.entityKind && item.identityKey && item.sourceId !== undefined) {
    const spec = ENTITY_SPECS[item.entityKind as ResolvableClaimKind];
    if (spec) {
      const { rows } = await getPool().query<{ id: string }>(`
        SELECT DISTINCT ${spec.targetColumn}::text AS id FROM ingest.claims
         WHERE entity_kind=$1 AND identity_key=$2 AND source_id<>$3 AND status='accepted'
           AND ${spec.targetColumn} IS NOT NULL AND NOT (${spec.targetColumn} = ANY($4::bigint[]))`,
      [item.entityKind, item.identityKey, item.sourceId, item.excludedTargetIds ?? []]);
      if (rows.length === 1) {
        claim = withTarget(claim, item.entityKind, Number(rows[0]!.id));
        item.resolvedTargetId = Number(rows[0]!.id);
      }
    }
  }
  const humanResolution = item.verdict === "same"
    ? { verdict: "same" as const, targetId: item.topCandidateId!, reviewDecisionId: item.decisionIds[0]!, decidedBy: item.decidedBy }
    : item.resolvedTargetId !== undefined
      ? undefined
      : { verdict: "different" as const, reviewDecisionId: item.decisionIds[0]!, decidedBy: item.decidedBy };
  const outcome = await mergeClaim(claim, { id: item.claimId, inserted: false }, {
    ...(humanResolution === undefined ? {} : { humanResolution }),
  });
  if (outcome.action === "candidate" || outcome.action === "unsupported") {
    throw new Error(`el merge no pudo aplicar la decisión: ${outcome.detail}`);
  }
}

async function applyFieldChoice(item: ReviewWork, runId: number, note: string): Promise<void> {
  if (item.verdict !== "canonical" && item.verdict !== "proposed") throw new Error("conflicto sin resolución concluyente");
  if (item.conflictId) {
    if (!item.entityKind || !item.field) throw new Error("conflicto sin entity_kind o field");
    const spec = ENTITY_SPECS[item.entityKind as ResolvableClaimKind];
    if (!spec) throw new Error(`conflicto ${item.entityKind} no resoluble`);
    const column = spec.fields[item.field];
    if (!column) throw new Error(`campo de conflicto no escribible: ${item.entityKind}.${item.field}`);
    const loaded = await getPool().query<{
      status: string; value_a: unknown; value_b: unknown; target_id: string | null;
    }>(`
      SELECT cf.status::text,cf.value_a,cf.value_b,
             COALESCE(a.${spec.targetColumn},b.${spec.targetColumn})::text AS target_id
        FROM ingest.conflicts cf
        JOIN ingest.claims a ON a.id=cf.claim_a_id
        JOIN ingest.claims b ON b.id=cf.claim_b_id
       WHERE cf.id=$1`, [item.conflictId]);
    const row = loaded.rows[0];
    if (!row) throw new Error(`conflicto ${item.conflictId} inexistente`);
    const status = row.status;
    let intended = item.decisionContext["selectedValue"];
    if (intended === undefined) {
      intended = item.payload[item.verdict === "canonical" ? "canonicalValue" : "proposedValue"];
    }
    let expected: ConflictResolution;
    if (intended !== undefined) {
      const aMatches = sameFieldValue(row.value_a, intended, item.field);
      const bMatches = sameFieldValue(row.value_b, intended, item.field);
      if (aMatches === bMatches) throw new Error(`conflicto ${item.conflictId}: la elección no identifica un único lado`);
      expected = aMatches ? "resolved_a" : "resolved_b";
    } else if (status === "open") {
      const targetId = asPositiveNumber(item.payload["targetId"]) ?? asPositiveNumber(row.target_id);
      if (!targetId) throw new Error("claims del conflicto no comparten un target válido");
      const current = (await getPool().query<Record<string, unknown>>(
        `SELECT ${column} FROM ${spec.table} WHERE id=$1`, [targetId],
      )).rows[0]?.[column] ?? null;
      if (item.verdict === "canonical") intended = current;
      else if (sameFieldValue(current, row.value_a, item.field)) intended = row.value_b;
      else if (sameFieldValue(current, row.value_b, item.field)) intended = row.value_a;
      else throw new Error(`conflicto ${item.conflictId}: el core no coincide con A ni B`);
      expected = sameFieldValue(row.value_a, intended, item.field) ? "resolved_a" : "resolved_b";
    } else {
      // Compatibilidad con decisiones antiguas que solo guardaban el nombre
      // traducido para pantalla: aquella interfaz definía actual=A.
      expected = item.verdict === "canonical" ? "resolved_a" : "resolved_b";
    }
    if (status === "open") {
      await resolveFieldConflict(item.conflictId, expected, { actor: "human", note, runId });
    } else if (status !== expected) {
      throw new Error(`conflicto ${item.conflictId} ya quedó como ${status}, no ${expected}`);
    }
    return;
  }

  // Contradicción contra un DEFAULT del DDL: no existe un claim rival ni una
  // fila ingest.conflicts. Elegir la propuesta vuelve a pasar por el merge;
  // elegir el canónico archiva la propuesta sin escribir el core.
  if (!item.claimId || !item.entityKind) throw new Error("contradicción sin claim o entity_kind");
  if (item.verdict === "canonical") {
    await getPool().query("UPDATE ingest.claims SET status='superseded',updated_at=now() WHERE id=$1", [item.claimId]);
    return;
  }
  const targetId = asPositiveNumber(item.payload["targetId"]);
  if (!targetId) throw new Error("contradicción sin targetId");
  const loaded = await loadClaimForApproval(item.claimId);
  if (!loaded) throw new Error(`claim inexistente: ${item.claimId}`);
  const claim = withTarget({ ...loaded, createdBy: "human", runId }, item.entityKind, targetId);
  const outcome = await mergeClaim(claim, { id: item.claimId, inserted: false });
  if (outcome.action === "candidate" || outcome.action === "unsupported" || outcome.action === "conflict") {
    throw new Error(`el merge no pudo aplicar el valor propuesto: ${outcome.detail}`);
  }
}

/**
 * Aplica solo decisiones concluyentes. Cada revisión queda aislada: un fallo
 * produce un run parcial, se informa y no esconde las demás decisiones.
 */
export async function applyReviewDecisions(
  note: string,
  options: { reviewIds?: readonly number[] } = {},
): Promise<DecisionApplicationResult> {
  if (!note.trim()) throw new Error("nota de aplicación obligatoria");
  // `reviewIds` acota QUÉ se aplica, no con qué se razona: la agrupación por
  // identidad (un same fija el destino, los different excluyen candidatos) se
  // calcula con todas las decisiones activas, igual que en la Mesa. La API
  // decide una revisión cada vez y no debe arrastrar las pendientes de otros.
  const scope = options.reviewIds === undefined ? undefined : new Set(options.reviewIds);
  const work = (await loadWork()).filter((item) => scope === undefined || scope.has(item.reviewId));
  const plan = summarize(work);
  const opened = await getPool().query<{ id: string }>(`
    INSERT INTO ingest.scrape_runs(kind,status,params)
    VALUES('merge_run','running',$1::jsonb) RETURNING id`, [JSON.stringify({
    action: "apply_review_decisions", note: note.trim(), plan,
    ...(scope === undefined ? {} : { reviewIds: [...scope] }),
  })]);
  const runId = Number(opened.rows[0]?.id);
  if (!runId) throw new Error("no se pudo abrir el merge_run de decisiones");
  const result: DecisionApplicationResult = {
    ...plan, runId, appliedReviews: 0, appliedDecisionRows: 0, failed: 0, errors: [],
  };
  const runNote = `[mesa ${runId}] ${note.trim()}`;

  for (const item of work) {
    if ((item.applied && !item.replayAppliedExclusion) || item.verdict === "unsure") continue;
    if (item.error) {
      result.failed += 1;
      result.errors.push({ reviewId: item.reviewId, error: item.error });
      continue;
    }
    try {
      if (MATCH_KINDS.has(item.kind)) await applyMatch(item, runId);
      else await applyFieldChoice(item, runId, runNote);
      if (!item.applied) result.appliedDecisionRows += await closeReviewAndMark(item, runId, runNote);
      result.appliedReviews += 1;
    } catch (error) {
      result.failed += 1;
      if (result.errors.length < 100) result.errors.push({ reviewId: item.reviewId, error: (error as Error).message });
    }
  }

  await finishRun(runId, result.failed === 0 ? "ok" : "partial", {
    actionable: plan.actionable, unsure: plan.unsure, appliedReviews: result.appliedReviews,
    appliedDecisionRows: result.appliedDecisionRows, failed: result.failed,
  }, result.errors.length === 0 ? undefined : JSON.stringify(result.errors));
  log.info({ ...result, errors: result.errors.length }, "decisiones de la mesa aplicadas");
  return result;
}
