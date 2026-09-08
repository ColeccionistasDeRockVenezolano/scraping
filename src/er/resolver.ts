import { aiResolutionProposalSchema } from "../ai/contracts.js";
import type { DeepSeekGateway } from "../ai/gateway.js";
import { getEnv } from "../config/env.js";
import { resolveEntityDeterministically } from "./scoring.js";
import { resolutionThresholdsSchema, type ResolutionCandidate, type ResolutionDecision, type ResolutionInput, type ResolutionThresholds } from "./types.js";

export function resolutionThresholdsFromEnv(): ResolutionThresholds {
  const env = getEnv();
  return resolutionThresholdsSchema.parse({
    AUTO_MATCH: env.ER_AUTO_MATCH_THRESHOLD,
    POSSIBLE_MATCH: env.ER_POSSIBLE_MATCH_THRESHOLD,
    REVIEW: env.ER_REVIEW_THRESHOLD,
    NO_MATCH: env.ER_NO_MATCH_THRESHOLD,
    minimumMargin: env.ER_MINIMUM_MARGIN,
  });
}

export interface ResolveOptions {
  thresholds?: ResolutionThresholds;
  gateway?: DeepSeekGateway;
}

/**
 * DeepSeek solo entra en bandas ambiguas. Su propuesta se adjunta a la
 * decision, pero nunca eleva la accion determinista a AUTO_MATCH.
 */
export async function resolveEntity(
  input: ResolutionInput,
  candidates: ResolutionCandidate[],
  options: ResolveOptions = {},
): Promise<ResolutionDecision> {
  const deterministic = resolveEntityDeterministically(input, candidates, options.thresholds ?? resolutionThresholdsFromEnv());
  if (!options.gateway || (deterministic.action !== "POSSIBLE_MATCH" && deterministic.action !== "REVIEW")) return deterministic;
  try {
    const arbitration = await options.gateway.propose({
      taskKind: "hard_entity_resolution",
      schemaVersion: "entity-resolution-proposal.v1",
      responseSchema: aiResolutionProposalSchema,
      instructions: [
        "Evalua si el input y el candidato recomendado representan la misma entidad historica.",
        "La similitud de texto por si sola no es evidencia suficiente.",
        "Responde las cinco claves exactas del contrato JSON solicitado.",
      ].join(" "),
      input: {
        entity: input,
        deterministic_decision: {
          action: deterministic.action,
          score: deterministic.score,
          features: deterministic.features,
          explanation: deterministic.explanation,
        },
        candidates: deterministic.candidates.slice(0, 5),
      },
    });
    return {
      ...deterministic,
      // La accion no cambia: IA propone; humano/codigo gobierna.
      explanation: `${deterministic.explanation}; DeepSeek adjunto como propuesta no vinculante`,
      aiProposal: arbitration.proposal,
      ...(arbitration.runId === undefined ? {} : { aiRunId: arbitration.runId }),
    };
  } catch (error) {
    const aiFailure = error instanceof Error ? error.message : String(error);
    return {
      ...deterministic,
      explanation: `${deterministic.explanation}; arbitraje DeepSeek rechazado/no disponible, se conserva revision determinista`,
      aiFailure,
    };
  }
}
