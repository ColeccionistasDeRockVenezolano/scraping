// E10 · Resolución de ambigüedades sobre la cola (PHASES.md E10; plan de
// implementación, FASE 10B).
//
//  * SOLO LA COLA. Analiza las revisiones abiertas de `yt:reconcile` y de
//    `ambiguity:scan`; las demás se cuentan en el reporte, no se tocan.
//  * REGLAS PRIMERO. Cada pregunta sale decidida por reglas deterministas; un
//    árbitro de IA solo lee las que quedan NEEDS_HUMAN con ambigüedad
//    semántica real, y su propuesta pasa por `applyArbiterPolicy`.
//  * NADA LLEGA AL CORE. Esta corrida escribe decisiones en
//    `ingest.ambiguity_resolutions`; aplicarlas es `ambiguity:apply`.
//  * IDEMPOTENTE. El hash del dosier identifica la decisión: repetir la corrida
//    con la misma evidencia no crea filas; una evidencia nueva sustituye la
//    anterior (`superseded`), y lo ya aplicado no se toca.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { analyzeAlbumPair, guardAlbumClusters } from "./albums.js";
import { ARBITER_INSTRUCTIONS, applyArbiterPolicy, arbiterInput, type Arbiter, type ArbiterRequest } from "./arbiter.js";
import { loadOpenCases, type LoadedCases } from "./dossiers.js";
import { analyzePersonPair } from "./persons.js";
import { loadReportItems, renderAmbiguityMarkdown, summarizeItems } from "./report.js";
import { FactSheet, RULES_VERSION, question, support, type AmbiguityDecision, type ApplyTarget, type CaseAnalysis, type EvidenceItem, type QuestionOutcome } from "./types.js";
import { analyzeYouTubeReview } from "./youtube.js";

const log = moduleLogger("ambiguity:resolve");

export function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).filter((key) => object[key] !== undefined).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(",")}}`;
}

export function dossierHash(reviewId: number, outcome: QuestionOutcome): string {
  return createHash("sha256").update(stableJson({
    rules: RULES_VERSION, reviewId, questionKey: outcome.questionKey, question: outcome.question,
    facts: outcome.facts, options: outcome.options, decision: outcome.decision, rule: outcome.rule,
  })).digest("hex");
}

/** Plan puro: de los dosieres a las preguntas decididas por reglas. */
export function analyzeCases(loaded: LoadedCases): CaseAnalysis[] {
  const cases: CaseAnalysis[] = [];
  for (const { input, outcome } of guardAlbumClusters(loaded.albumPairs.map((input) => ({ input, outcome: analyzeAlbumPair(input) })))) {
    cases.push({ reviewId: input.reviewId, kind: "album_pair", title: `${input.a.artistName}: «${input.a.title}» / «${input.b.title}»`, questions: [outcome] });
  }
  for (const input of loaded.personPairs) cases.push({ reviewId: input.reviewId, kind: "person_pair", title: `«${input.a.name}» / «${input.b.name}»`, questions: [analyzePersonPair(input)] });
  for (const input of loaded.youtube) cases.push({ reviewId: input.reviewId, kind: "youtube", title: `${input.title ?? "(sin título)"} (${input.videoId})`, questions: analyzeYouTubeReview(input) });
  for (const stale of loaded.stale) {
    const sheet = new FactSheet();
    const fact = sheet.add(`review:${stale.reviewId}`, stale.reason);
    cases.push({ reviewId: stale.reviewId, kind: stale.kind, title: stale.title, questions: [question({
      questionKey: "review", question: `¿Sigue vigente la revisión #${stale.reviewId}?`, options: [], decision: "NEEDS_HUMAN", rule: "review.stale",
      reasoning: `${stale.reason}; una persona decide si la revisión se cierra`, facts: sheet.facts, evidence: [support(fact, "context")], target: null, aiEligible: false,
    })] });
  }
  return cases.sort((x, y) => x.reviewId - y.reviewId);
}

export interface ResolveOptions {
  dryRun?: boolean;
  arbiter?: Arbiter;
  /** Limita a qué revisiones se escriben decisiones o se consulta al árbitro; el análisis ve toda la cola. */
  reviewIds?: number[];
  reportDir?: string;
  /** Escribe los dosieres que siguen NEEDS_HUMAN con ambigüedad semántica, para un árbitro externo. */
  exportPath?: string;
}

export interface ResolveSummary {
  cases: number; questions: number;
  byDecision: Record<AmbiguityDecision, number>;
  rows: { created: number; reused: number; superseded: number; alreadyApplied: number };
  arbiter: { name: string | null; consulted: number; accepted: number; rejected: number; unavailable: number; withoutDecision: number };
  aiEligiblePending: number;
  unsupported: Array<{ kind: string; count: number }>;
}
export interface ResolveResult { dryRun: boolean; runId?: number; summary: ResolveSummary; cases: CaseAnalysis[]; reportFiles: string[]; exported?: string; }

interface FinalDecision {
  decision: AmbiguityDecision; evidence: EvidenceItem[]; reasoning: string; target: ApplyTarget | null; decidedBy: "deterministic" | "ai";
  arbiter: string | null; aiProposal: unknown; aiRunId: number | null; aiFailure: string | null;
}
interface LiveRow { id: string; dossier_hash: string; status: string; has_ai: boolean; }

function deterministic(outcome: QuestionOutcome): FinalDecision {
  return { decision: outcome.decision, evidence: outcome.evidence, reasoning: outcome.reasoning, target: outcome.target, decidedBy: "deterministic", arbiter: null, aiProposal: null, aiRunId: null, aiFailure: null };
}

export async function resolveAmbiguities(options: ResolveOptions = {}): Promise<ResolveResult> {
  const dryRun = options.dryRun ?? false;
  const only = options.reviewIds?.length ? new Set(options.reviewIds) : null;
  const client: PoolClient = await getPool().connect();
  try {
    await client.query("BEGIN");
    const run = await client.query<{ id: string }>(`
      INSERT INTO ingest.scrape_runs(kind, status, params) VALUES ('merge_run', 'running', $1::jsonb) RETURNING id::text`,
    [JSON.stringify({ action: "ambiguity_resolve", dryRun, arbiter: options.arbiter?.name ?? null, reviewIds: options.reviewIds ?? null, rules: RULES_VERSION })]);
    const runId = Number(run.rows[0]!.id);
    const loaded = await loadOpenCases(client);
    const cases = analyzeCases(loaded);
    const summary: ResolveSummary = {
      cases: 0, questions: 0, byDecision: { MATCH_HIGH_CONFIDENCE: 0, KEEP_SEPARATE: 0, NEEDS_HUMAN: 0, CONFLICT: 0 },
      rows: { created: 0, reused: 0, superseded: 0, alreadyApplied: 0 },
      arbiter: { name: options.arbiter?.name ?? null, consulted: 0, accepted: 0, rejected: 0, unavailable: 0, withoutDecision: 0 },
      aiEligiblePending: 0, unsupported: loaded.unsupported,
    };
    const exported: unknown[] = [];

    const consult = async (request: ArbiterRequest): Promise<FinalDecision> => {
      const base = deterministic(request.question);
      if (!options.arbiter || request.question.decision !== "NEEDS_HUMAN" || !request.question.aiEligible) return base;
      summary.arbiter.consulted += 1;
      try {
        const verdict = await options.arbiter.arbitrate(request);
        if (!verdict) { summary.arbiter.withoutDecision += 1; return base; }
        const policy = applyArbiterPolicy(request.question, verdict.proposal);
        if (policy.accepted) summary.arbiter.accepted += 1; else summary.arbiter.rejected += 1;
        return {
          decision: policy.decision, evidence: policy.evidence, reasoning: policy.reasoning, target: policy.target,
          decidedBy: policy.accepted ? "ai" : "deterministic", arbiter: verdict.arbiter, aiProposal: verdict.proposal,
          aiRunId: verdict.runId ?? null, aiFailure: policy.rejection ?? null,
        };
      } catch (error) {
        summary.arbiter.unavailable += 1;
        return { ...base, aiFailure: `árbitro no disponible: ${error instanceof Error ? error.message : String(error)}` };
      }
    };

    for (const item of cases) {
      if (only && !only.has(item.reviewId)) continue;
      summary.cases += 1;
      await client.query(`
        UPDATE ingest.ambiguity_resolutions SET status='superseded'
         WHERE review_id=$1 AND status='proposed' AND NOT (question_key = ANY($2::text[]))`, [item.reviewId, item.questions.map((q) => q.questionKey)]);
      for (const outcome of item.questions) {
        summary.questions += 1;
        const hash = dossierHash(item.reviewId, outcome);
        const request: ArbiterRequest = { reviewId: item.reviewId, caseTitle: item.title, dossierHash: hash, question: outcome };
        const live = (await client.query<LiveRow>(`
          SELECT id::text, dossier_hash, status, ai_proposal IS NOT NULL AS has_ai FROM ingest.ambiguity_resolutions
           WHERE review_id=$1 AND question_key=$2 AND status IN ('proposed','applied')`, [item.reviewId, outcome.questionKey])).rows[0];
        let final: FinalDecision;
        if (live?.status === "applied") {
          summary.rows.alreadyApplied += 1;
          const stored = (await client.query<{ decision: AmbiguityDecision }>("SELECT decision FROM ingest.ambiguity_resolutions WHERE id=$1", [live.id])).rows[0]!;
          summary.byDecision[stored.decision] += 1;
          continue;
        }
        if (live && live.dossier_hash === hash && (live.has_ai || !options.arbiter)) {
          summary.rows.reused += 1;
          const stored = (await client.query<{ decision: AmbiguityDecision; has_ai: boolean; decided_by: string }>(
            "SELECT decision, ai_proposal IS NOT NULL AS has_ai, decided_by FROM ingest.ambiguity_resolutions WHERE id=$1", [live.id])).rows[0]!;
          summary.byDecision[stored.decision] += 1;
          if (stored.decision === "NEEDS_HUMAN" && outcome.aiEligible && !stored.has_ai) {
            summary.aiEligiblePending += 1;
            exported.push({ reviewId: item.reviewId, questionKey: outcome.questionKey, dossierHash: hash, input: arbiterInput(request) });
          }
          continue;
        }
        final = await consult(request);
        if (live && live.dossier_hash === hash && final.aiProposal === null) {
          // El árbitro no aportó nada nuevo sobre la misma evidencia: la fila sigue valiendo.
          summary.rows.reused += 1;
          summary.byDecision[outcome.decision] += 1;
          if (outcome.decision === "NEEDS_HUMAN" && outcome.aiEligible) {
            summary.aiEligiblePending += 1;
            exported.push({ reviewId: item.reviewId, questionKey: outcome.questionKey, dossierHash: hash, input: arbiterInput(request) });
          }
          continue;
        }
        if (live) {
          await client.query("UPDATE ingest.ambiguity_resolutions SET status='superseded' WHERE id=$1", [live.id]);
          summary.rows.superseded += 1;
        }
        await client.query(`
          INSERT INTO ingest.ambiguity_resolutions(
            review_id, question_key, question, dossier_hash, decision, deterministic_decision, decided_by, rule, reasoning,
            facts, evidence, options, target, arbiter, ai_proposal, ai_run_id, ai_failure, run_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::jsonb,$16,$17,$18)`,
        [item.reviewId, outcome.questionKey, outcome.question, hash, final.decision, outcome.decision, final.decidedBy, outcome.rule, final.reasoning,
          JSON.stringify(outcome.facts), JSON.stringify(final.evidence), JSON.stringify(outcome.options),
          final.target ? JSON.stringify(final.target) : null, final.arbiter, final.aiProposal === null ? null : JSON.stringify(final.aiProposal),
          final.aiRunId, final.aiFailure, runId]);
        summary.rows.created += 1;
        summary.byDecision[final.decision] += 1;
        if (final.decision === "NEEDS_HUMAN" && outcome.aiEligible && final.aiProposal === null) {
          summary.aiEligiblePending += 1;
          exported.push({ reviewId: item.reviewId, questionKey: outcome.questionKey, dossierHash: hash, input: arbiterInput(request) });
        }
      }
    }

    await client.query("UPDATE ingest.scrape_runs SET status='ok', finished_at=now(), counters=$2::jsonb WHERE id=$1",
      [runId, JSON.stringify({ cases: summary.cases, questions: summary.questions, ...summary.byDecision, rows: summary.rows, arbiter: summary.arbiter })]);
    const items = await loadReportItems(client);
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");

    const reportFiles: string[] = [];
    if (!dryRun) {
      const dir = options.reportDir ?? "reports";
      await mkdir(dir, { recursive: true });
      const scan = (await getPool().query<{ counters: ResolveReportScan }>(`
        SELECT counters FROM ingest.scrape_runs WHERE params->>'action'='ambiguity_scan' AND status='ok'
           AND coalesce((params->>'dryRun')::boolean, false) = false ORDER BY id DESC LIMIT 1`)).rows[0]?.counters ?? null;
      const context = { scan, unsupported: loaded.unsupported, runId, arbiter: options.arbiter?.name ?? null };
      const jsonPath = path.join(dir, "ambiguity-resolution.json");
      const mdPath = path.join(dir, "ambiguity-resolution.md");
      await writeFile(jsonPath, `${JSON.stringify({ runId, rules: RULES_VERSION, summary: summarizeItems(items), run: summary, scan, unsupported: loaded.unsupported, items }, null, 2)}\n`);
      await writeFile(mdPath, renderAmbiguityMarkdown(items, context));
      reportFiles.push(jsonPath, mdPath);
    }
    let exportedPath: string | undefined;
    if (options.exportPath) {
      await mkdir(path.dirname(options.exportPath), { recursive: true });
      await writeFile(options.exportPath, `${JSON.stringify({ instructions: ARBITER_INSTRUCTIONS, contract: "aiAmbiguityProposalSchema (src/ai/contracts.ts)", rules: RULES_VERSION, items: exported }, null, 2)}\n`);
      exportedPath = options.exportPath;
    }
    log.info({ ...summary.byDecision, rows: summary.rows, dryRun, runId }, "resolución de ambigüedades");
    return { dryRun, ...(dryRun ? {} : { runId }), summary, cases, reportFiles, ...(exportedPath ? { exported: exportedPath } : {}) };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

type ResolveReportScan = { albums?: { candidates: number; enqueued: number; alreadyQueued: number }; persons?: { candidates: number; enqueued: number; alreadyQueued: number; withoutContext: number } };
