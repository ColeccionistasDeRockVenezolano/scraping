// E10 · Árbitro para la ambigüedad semántica que las reglas no resuelven.
//
// La IA lee el dosier de una pregunta y propone; el código dispone. Una
// propuesta solo cuenta si cada evidencia cita un hecho del dosier y si la
// decisión se sostiene con esas citas (dos hechos a favor y ninguno en contra
// para un MATCH, y ninguna incertidumbre declarada). Si no, la pregunta queda
// NEEDS_HUMAN con la propuesta a la vista. Una decisión de árbitro nunca se
// aplica en lote: `ambiguity:apply` exige nombrar la revisión.
//
// Dos árbitros con el mismo contrato: DeepSeek por el gateway (con el modelo
// flash, por decisión del propietario) y un archivo JSON con decisiones
// escritas fuera del pipeline, atado al hash del dosier que se vio.
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { aiAmbiguityProposalSchema, type AiAmbiguityProposal } from "../ai/contracts.js";
import type { DeepSeekGateway } from "../ai/gateway.js";
import type { AmbiguityDecision, ApplyTarget, EvidenceItem, QuestionOutcome } from "./types.js";

export interface ArbiterRequest { reviewId: number; caseTitle: string; dossierHash: string; question: QuestionOutcome; }
export interface ArbiterVerdict { proposal: AiAmbiguityProposal; arbiter: string; runId?: number; }
export interface Arbiter { readonly name: string; arbitrate(request: ArbiterRequest): Promise<ArbiterVerdict | null>; }

export const ARBITER_SCHEMA_VERSION = "ambiguity-resolution.v1";
export const ARBITER_INSTRUCTIONS = [
  "Decides un caso ambiguo del catálogo de Coleccionistas de Rock Venezolano usando SOLO los hechos del INPUT (facts).",
  "No uses conocimiento propio. No inventes fechas, nombres, alias ni relaciones.",
  "Cada evidencia cita un fact_id que existe en facts; supports es match, separate o conflict.",
  "MATCH_HIGH_CONFIDENCE exige al menos dos hechos distintos a favor, ninguno en contra y ninguna incertidumbre; en preguntas con opciones, option es la key elegida.",
  "KEEP_SEPARATE exige un hecho que muestre que son distintas; CONFLICT, hechos que se contradicen sobre la misma entidad.",
  "Si dos opciones siguen siendo plausibles, o dudas, responde NEEDS_HUMAN: es un resultado válido.",
  "Responde las cinco claves: decision, option, evidence, reasoning_summary, uncertainties.",
].join("\n");

export function arbiterInput(request: ArbiterRequest): unknown {
  const { question } = request;
  return {
    case: request.caseTitle, question: question.question,
    options: question.options.map((option) => ({ key: option.key, label: option.label })),
    deterministic: { decision: question.decision, rule: question.rule, reasoning: question.reasoning },
    facts: question.facts,
  };
}

export class DeepSeekArbiter implements Arbiter {
  readonly name = "deepseek";
  constructor(private readonly gateway: DeepSeekGateway) {}
  async arbitrate(request: ArbiterRequest): Promise<ArbiterVerdict> {
    const result = await this.gateway.propose({
      taskKind: "hard_entity_resolution", modelClass: "fast", schemaVersion: ARBITER_SCHEMA_VERSION,
      responseSchema: aiAmbiguityProposalSchema, instructions: ARBITER_INSTRUCTIONS, input: arbiterInput(request),
    });
    return { proposal: result.proposal, arbiter: `deepseek:${result.model}`, ...(result.runId === undefined ? {} : { runId: result.runId }) };
  }
}

export const arbiterFileSchema = z.object({
  arbiter: z.string().min(1).max(80),
  decidedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
  decisions: z.array(z.object({
    reviewId: z.number().int().positive(),
    questionKey: z.string().min(1).max(80),
    dossierHash: z.string().regex(/^[0-9a-f]{64}$/u),
    proposal: aiAmbiguityProposalSchema,
  }).strict()),
}).strict();
export type ArbiterFile = z.infer<typeof arbiterFileSchema>;

/** Decisiones escritas fuera del pipeline. Una decisión sobre otro dosier no se usa. */
export class FileArbiter implements Arbiter {
  readonly name: string;
  private readonly byQuestion: Map<string, ArbiterFile["decisions"][number]>;
  constructor(file: ArbiterFile) {
    this.name = file.arbiter;
    this.byQuestion = new Map(file.decisions.map((item) => [`${item.reviewId}|${item.questionKey}`, item]));
  }
  static async load(path: string): Promise<FileArbiter> {
    return new FileArbiter(arbiterFileSchema.parse(JSON.parse(await readFile(path, "utf8"))));
  }
  async arbitrate(request: ArbiterRequest): Promise<ArbiterVerdict | null> {
    const item = this.byQuestion.get(`${request.reviewId}|${request.question.questionKey}`);
    return item && item.dossierHash === request.dossierHash ? { proposal: item.proposal, arbiter: this.name } : null;
  }
}

export interface PolicyResult {
  accepted: boolean;
  decision: AmbiguityDecision;
  evidence: EvidenceItem[];
  reasoning: string;
  target: ApplyTarget | null;
  rejection?: string;
}

/** Convierte una propuesta en decisión solo si se sostiene con el dosier; si no, NEEDS_HUMAN. */
export function applyArbiterPolicy(question: QuestionOutcome, proposal: AiAmbiguityProposal): PolicyResult {
  const reject = (rejection: string): PolicyResult => ({
    accepted: false, decision: "NEEDS_HUMAN", evidence: question.evidence, target: null, rejection,
    reasoning: `${question.reasoning}; propuesta del árbitro descartada: ${rejection}`,
  });
  const ids = new Set(question.facts.map((fact) => fact.id));
  const unknown = proposal.evidence.filter((item) => !ids.has(item.fact_id)).map((item) => item.fact_id);
  if (unknown.length) return reject(`cita hechos que no están en el dosier (${[...new Set(unknown)].join(", ")})`);
  const evidence: EvidenceItem[] = proposal.evidence.map((item) => ({ factId: item.fact_id, supports: item.supports }));
  const count = (supports: string): number => new Set(proposal.evidence.filter((item) => item.supports === supports).map((item) => item.fact_id)).size;
  const reasoning = `árbitro: ${proposal.reasoning_summary}`;
  switch (proposal.decision) {
    case "NEEDS_HUMAN":
      return { accepted: true, decision: "NEEDS_HUMAN", evidence: evidence.length ? evidence : question.evidence, reasoning, target: null };
    case "MATCH_HIGH_CONFIDENCE": {
      const option = proposal.option === null && question.options.length === 1 ? question.options[0] : question.options.find((item) => item.key === proposal.option);
      if (!option) return reject(`la opción «${proposal.option ?? "(ninguna)"}» no está entre las de la pregunta`);
      if (count("match") < 2) return reject("un MATCH necesita al menos dos hechos a favor");
      if (count("separate") || count("conflict")) return reject("cita hechos en contra de su propio MATCH");
      if (proposal.uncertainties.length) return reject(`declara incertidumbres: ${proposal.uncertainties.join("; ")}`);
      return { accepted: true, decision: "MATCH_HIGH_CONFIDENCE", evidence, reasoning, target: option.target };
    }
    case "KEEP_SEPARATE":
      if (!count("separate")) return reject("KEEP_SEPARATE sin un hecho que muestre que son distintas");
      if (count("match")) return reject("cita hechos a favor de que son la misma");
      return { accepted: true, decision: "KEEP_SEPARATE", evidence, reasoning, target: null };
    case "CONFLICT":
      if (!count("conflict")) return reject("CONFLICT sin hechos que se contradigan");
      return { accepted: true, decision: "CONFLICT", evidence, reasoning, target: null };
  }
}
