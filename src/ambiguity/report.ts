// E10 · reports/ambiguity-resolution.{md,json}: cada caso con su decisión, la
// regla o el árbitro que la tomó, el razonamiento resumido y los hechos
// verificables citados. Se genera desde la tabla, así que incluye lo aplicado.
import type { PoolClient } from "pg";
import type { AmbiguityDecision, ApplyTarget, CaseKind, EvidenceItem, Fact, QuestionOption } from "./types.js";

export interface ReportItem {
  id: number; reviewId: number; reviewKind: string; reviewStatus: string; caseKind: CaseKind; caseTitle: string;
  questionKey: string; question: string; decision: AmbiguityDecision; deterministicDecision: AmbiguityDecision;
  decidedBy: "deterministic" | "ai"; rule: string; reasoning: string; facts: Fact[]; evidence: EvidenceItem[];
  options: QuestionOption[]; target: ApplyTarget | null; arbiter: string | null; aiProposal: unknown; aiFailure: string | null;
  status: "proposed" | "applied"; appliedAt: string | null; appliedNote: string | null;
}

export interface ReportContext {
  scan: { albums?: { candidates: number; enqueued: number; alreadyQueued: number }; persons?: { candidates: number; enqueued: number; alreadyQueued: number; withoutContext: number } } | null;
  unsupported: Array<{ kind: string; count: number }>;
  runId: number | null;
  arbiter: string | null;
}

function caseOf(kind: string, payload: Record<string, unknown>): { caseKind: CaseKind; caseTitle: string } {
  if (kind === "youtube_match") return { caseKind: "youtube", caseTitle: `${String(payload["title"] ?? "(sin título)")} (${String(payload["videoId"] ?? "?")})` };
  if (payload["entity"] === "person") {
    return { caseKind: "person_pair", caseTitle: (Array.isArray(payload["names"]) ? payload["names"] as string[] : []).map((name) => `«${name}»`).join(" / ") };
  }
  const titles = Array.isArray(payload["titles"]) ? payload["titles"] as string[] : [];
  return { caseKind: "album_pair", caseTitle: `${String(payload["artist"] ?? "")}: ${titles.map((title) => `«${title}»`).join(" / ")}` };
}

export async function loadReportItems(client: Pick<PoolClient, "query">): Promise<ReportItem[]> {
  const { rows } = await client.query<Record<string, unknown>>(`
    SELECT r.id::text, r.review_id::text, q.kind::text AS review_kind, q.status::text AS review_status, q.payload,
           r.question_key, r.question, r.decision, r.deterministic_decision, r.decided_by, r.rule, r.reasoning, r.facts, r.evidence,
           r.options, r.target, r.arbiter, r.ai_proposal, r.ai_failure, r.status, r.applied_at, r.applied_note
      FROM ingest.ambiguity_resolutions r JOIN ingest.review_queue q ON q.id=r.review_id
     WHERE r.status IN ('proposed','applied') ORDER BY r.review_id, r.question_key`);
  return rows.map((row) => ({
    id: Number(row["id"]), reviewId: Number(row["review_id"]), reviewKind: String(row["review_kind"]), reviewStatus: String(row["review_status"]),
    ...caseOf(String(row["review_kind"]), (row["payload"] as Record<string, unknown> | null) ?? {}),
    questionKey: String(row["question_key"]), question: String(row["question"]),
    decision: row["decision"] as AmbiguityDecision, deterministicDecision: row["deterministic_decision"] as AmbiguityDecision,
    decidedBy: row["decided_by"] as "deterministic" | "ai", rule: String(row["rule"]), reasoning: String(row["reasoning"]),
    facts: row["facts"] as Fact[], evidence: row["evidence"] as EvidenceItem[], options: row["options"] as QuestionOption[],
    target: (row["target"] as ApplyTarget | null) ?? null, arbiter: (row["arbiter"] as string | null) ?? null,
    aiProposal: row["ai_proposal"] ?? null, aiFailure: (row["ai_failure"] as string | null) ?? null,
    status: row["status"] as "proposed" | "applied",
    appliedAt: row["applied_at"] instanceof Date ? (row["applied_at"] as Date).toISOString() : null,
    appliedNote: (row["applied_note"] as string | null) ?? null,
  }));
}

export function describeTarget(target: ApplyTarget): string {
  switch (target.action) {
    case "merge_albums": return `fusionar el disco ${target.dropId} «${target.dropTitle}» en ${target.keepId} «${target.keepTitle}» (el título perdido queda como alias)`;
    case "merge_persons": return `fusionar la persona ${target.dropId} «${target.dropName}» en ${target.keepId} «${target.keepName}» (la grafía perdida queda como alias)`;
    case "link_video_track": return `enlazar el video ${target.videoId} con la pista ${target.trackId} desde ${target.startSeconds} s${target.endSeconds ? ` hasta ${target.endSeconds} s` : ""}`;
    case "link_video_album": return `enlazar el video ${target.videoId} con el disco ${target.albumId} como ${target.albumKind}${target.occurrences.length ? ` y ${target.occurrences.length} ocurrencias de pista` : ""}`;
  }
}

const DECISION_TEXT: Readonly<Record<AmbiguityDecision, string>> = {
  MATCH_HIGH_CONFIDENCE: "coinciden con evidencia concreta; se aplican solo con `crv ambiguity:apply --confirm`",
  CONFLICT: "la evidencia dice que es la misma entidad, pero las fuentes se contradicen: una persona elige",
  KEEP_SEPARATE: "hay evidencia de que son distintas; aplicarlo solo cierra la revisión",
  NEEDS_HUMAN: "la evidencia no permite distinguir; queda para una persona (resultado válido, no un fallo)",
};
const SUPPORT_TEXT: Readonly<Record<string, string>> = { match: "a favor", separate: "separa", conflict: "contradice", context: "contexto" };
const KIND_TEXT: Readonly<Record<CaseKind, string>> = { album_pair: "discos", person_pair: "personas", youtube: "YouTube" };
const DECISIONS: AmbiguityDecision[] = ["MATCH_HIGH_CONFIDENCE", "CONFLICT", "KEEP_SEPARATE", "NEEDS_HUMAN"];

export function summarizeItems(items: ReportItem[]) {
  const count = (filter: (item: ReportItem) => boolean): number => items.filter(filter).length;
  return {
    reviews: new Set(items.map((item) => item.reviewId)).size,
    questions: items.length,
    byDecision: Object.fromEntries(DECISIONS.map((decision) => [decision, count((item) => item.decision === decision)])) as Record<AmbiguityDecision, number>,
    byKind: Object.fromEntries((Object.keys(KIND_TEXT) as CaseKind[]).map((kind) =>
      [kind, Object.fromEntries(DECISIONS.map((decision) => [decision, count((item) => item.caseKind === kind && item.decision === decision)]))])) as Record<CaseKind, Record<AmbiguityDecision, number>>,
    decidedBy: { deterministic: count((item) => item.decidedBy === "deterministic"), ai: count((item) => item.decidedBy === "ai") },
    applied: count((item) => item.status === "applied"),
    pendingToApply: count((item) => item.status === "proposed" && (item.decision === "MATCH_HIGH_CONFIDENCE" || item.decision === "KEEP_SEPARATE")),
    aiProposalsRejected: count((item) => item.aiProposal !== null && item.decidedBy === "deterministic"),
    withoutEvidence: count((item) => item.decision !== "NEEDS_HUMAN" && item.evidence.length === 0),
  };
}

export function renderAmbiguityMarkdown(items: ReportItem[], context: ReportContext): string {
  const summary = summarizeItems(items);
  const lines: string[] = [
    "# Resolución de ambigüedades",
    "",
    "> Generado por `crv ambiguity:resolve` (PHASES.md E10; plan, FASE 10B). Solo casos de la",
    "> cola: las revisiones `youtube_match` de `yt:reconcile` y los `possible_duplicate` que",
    "> encoló `crv ambiguity:scan`. Primero reglas deterministas; un árbitro de IA solo lee",
    "> los casos con ambigüedad semántica y su propuesta cuenta solo si cita hechos del dosier.",
    "> Nada de esto tocó el core: `crv ambiguity:apply --confirm` aplica lo que una persona confirme.",
    "",
    "## Resumen",
    "",
    "| Medida | Valor |",
    "|---|---|",
    `| Revisiones analizadas | ${summary.reviews} (${summary.questions} preguntas) |`,
    ...DECISIONS.map((decision) => `| ${decision} | ${summary.byDecision[decision]} — ${DECISION_TEXT[decision]} |`),
    `| Decididas por reglas / por árbitro | ${summary.decidedBy.deterministic} / ${summary.decidedBy.ai}${context.arbiter ? ` (árbitro de esta corrida: ${context.arbiter})` : ""} |`,
    `| Propuestas de árbitro descartadas por la política | ${summary.aiProposalsRejected} |`,
    `| Ya aplicadas / pendientes de aplicar | ${summary.applied} / ${summary.pendingToApply} |`,
    `| Resoluciones automáticas sin evidencia | ${summary.withoutEvidence} |`,
    "",
    "| Tipo | MATCH | CONFLICT | KEEP_SEPARATE | NEEDS_HUMAN |",
    "|---|---|---|---|---|",
    ...(Object.keys(KIND_TEXT) as CaseKind[]).map((kind) => `| ${KIND_TEXT[kind]} | ${DECISIONS.map((decision) => summary.byKind[kind][decision]).join(" | ")} |`),
    "",
  ];
  if (context.scan?.persons) {
    lines.push(`Barrido: ${context.scan.albums?.candidates ?? 0} pares de discos y ${context.scan.persons.candidates} de personas con banda en común. `
      + `${context.scan.persons.withoutContext} pares de personas con nombres parecidos pero sin ninguna banda en común **no se encolaron** `
      + "(el parecido del nombre no es evidencia); la lista completa está en `reports/ambiguity-scan.json`.", "");
  }
  if (context.unsupported.length) {
    lines.push(`Revisiones abiertas de otros tipos, fuera de este resolutor: ${context.unsupported.map((item) => `${item.kind} ${item.count}`).join(" · ")}.`, "");
  }
  for (const decision of DECISIONS) {
    const group = items.filter((item) => item.decision === decision);
    lines.push(`## ${decision} (${group.length})`, "", DECISION_TEXT[decision], "");
    if (!group.length) { lines.push("Ninguno.", ""); continue; }
    for (const kind of Object.keys(KIND_TEXT) as CaseKind[]) {
      const byKind = group.filter((item) => item.caseKind === kind);
      if (!byKind.length) continue;
      lines.push(`### ${KIND_TEXT[kind]} (${byKind.length})`, "");
      for (const item of byKind) {
        const by = item.decidedBy === "ai" ? `árbitro ${item.arbiter}` : `regla \`${item.rule}\``;
        lines.push(`- **#${item.reviewId} · ${item.caseTitle}** — ${by}${item.status === "applied" ? ` · **aplicada** ${item.appliedAt?.slice(0, 10) ?? ""}` : ""}`);
        if (item.questionKey !== "pair" && item.questionKey !== "video_track") lines.push(`  - pregunta: ${item.question}`);
        lines.push(`  - ${item.reasoning}`);
        const facts = new Map(item.facts.map((fact) => [fact.id, fact]));
        for (const evidence of item.evidence) {
          const fact = facts.get(evidence.factId);
          if (fact) lines.push(`  - ${evidence.factId} [${SUPPORT_TEXT[evidence.supports] ?? evidence.supports}] \`${fact.ref}\` — ${fact.text}`);
        }
        if (item.target) lines.push(`  - aplicaría: ${describeTarget(item.target)}`);
        if (item.decidedBy === "ai" && item.deterministicDecision !== item.decision) lines.push(`  - las reglas deterministas decían ${item.deterministicDecision} (\`${item.rule}\`)`);
        if (item.aiFailure) lines.push(`  - árbitro${item.arbiter ? ` ${item.arbiter}` : ""}: ${item.aiFailure}`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}
