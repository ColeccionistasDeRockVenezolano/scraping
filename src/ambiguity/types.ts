// E10 · Tipos del resolutor de ambigüedades (PHASES.md E10; plan de
// implementación, FASE 10B).
//
// Un caso de la cola se descompone en preguntas. Cada pregunta lleva su
// dosier —hechos verificables con un id y la referencia de dónde salen— y una
// decisión que solo puede apoyarse en esos hechos: la evidencia cita ids, no
// frases libres. `assertGrounded` hace cumplir esa regla antes de que nada se
// guarde, y el DDL de 0012 la repite.

export const AMBIGUITY_DECISIONS = ["MATCH_HIGH_CONFIDENCE", "KEEP_SEPARATE", "NEEDS_HUMAN", "CONFLICT"] as const;
export type AmbiguityDecision = (typeof AMBIGUITY_DECISIONS)[number];

/** Entra en el hash del dosier: cambiar una regla invalida lo decidido con la anterior. */
export const RULES_VERSION = "ambiguity-rules.v2";

export interface Fact { id: string; ref: string; text: string; }
export type Supports = "match" | "separate" | "conflict" | "context";
export interface EvidenceItem { factId: string; supports: Supports; }

export interface Occurrence { trackId: number; startSeconds: number; endSeconds: number | null; }

/** Lo que `ambiguity:apply` haría si una persona confirma la decisión. */
export type ApplyTarget =
  | { action: "merge_albums"; keepId: number; dropId: number; keepTitle: string; dropTitle: string }
  | { action: "merge_persons"; keepId: number; dropId: number; keepName: string; dropName: string }
  | { action: "link_video_track"; videoDbId: number; videoId: string; trackId: number; startSeconds: number; endSeconds: number | null }
  | { action: "link_video_album"; videoDbId: number; videoId: string; albumId: number; albumKind: "live_concert"; occurrences: Occurrence[] };

/** Una opción entre las que la pregunta admite, con lo que implicaría elegirla. */
export interface QuestionOption { key: string; label: string; target: ApplyTarget; }

export interface QuestionOutcome {
  questionKey: string;
  question: string;
  decision: AmbiguityDecision;
  rule: string;
  reasoning: string;
  facts: Fact[];
  evidence: EvidenceItem[];
  options: QuestionOption[];
  /** Solo en MATCH_HIGH_CONFIDENCE. */
  target: ApplyTarget | null;
  /** Queda ambigüedad semántica real y un árbitro de IA puede leer el dosier. */
  aiEligible: boolean;
}

export type CaseKind = "album_pair" | "person_pair" | "youtube";
export interface CaseAnalysis { reviewId: number; kind: CaseKind; title: string; questions: QuestionOutcome[]; }

export class FactSheet {
  readonly facts: Fact[] = [];
  add(ref: string, text: string): string {
    const id = `F${this.facts.length + 1}`;
    this.facts.push({ id, ref, text });
    return id;
  }
}

export const support = (factId: string, supports: Supports): EvidenceItem => ({ factId, supports });

/**
 * La regla que ninguna resolución puede saltarse: una decisión distinta de
 * NEEDS_HUMAN cita al menos un hecho del dosier en su dirección, y un MATCH
 * dice exactamente qué se aplicaría.
 */
export function assertGrounded(question: QuestionOutcome): void {
  const ids = new Set(question.facts.map((fact) => fact.id));
  const missing = question.evidence.filter((item) => !ids.has(item.factId));
  if (missing.length) throw new Error(`${question.questionKey}: evidencia que cita hechos inexistentes (${missing.map((item) => item.factId).join(", ")})`);
  const needs: Partial<Record<AmbiguityDecision, Supports>> = { MATCH_HIGH_CONFIDENCE: "match", KEEP_SEPARATE: "separate", CONFLICT: "conflict" };
  const direction = needs[question.decision];
  if (direction && !question.evidence.some((item) => item.supports === direction)) {
    throw new Error(`${question.questionKey}: ${question.decision} sin evidencia concreta que lo sostenga`);
  }
  if (question.decision === "MATCH_HIGH_CONFIDENCE" && !question.target) throw new Error(`${question.questionKey}: MATCH sin destino`);
  if (question.decision !== "MATCH_HIGH_CONFIDENCE" && question.target) throw new Error(`${question.questionKey}: solo un MATCH lleva destino`);
}

export function question(fields: QuestionOutcome): QuestionOutcome {
  assertGrounded(fields);
  return fields;
}

/** Degrada una decisión a NEEDS_HUMAN añadiendo el hecho que la vuelve dudosa. */
export function downgrade(original: QuestionOutcome, rule: string, reasoning: string, fact: { ref: string; text: string }): QuestionOutcome {
  const facts = [...original.facts, { id: `F${original.facts.length + 1}`, ...fact }];
  return question({
    ...original, facts, decision: "NEEDS_HUMAN", rule, reasoning,
    evidence: [...original.evidence.filter((item) => item.supports !== "match"), support(facts.at(-1)!.id, "context")],
    target: null, aiEligible: false,
  });
}
