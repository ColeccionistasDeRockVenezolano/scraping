// CRV · Curaduría › resolución de «valores en disputa» (PLAN_CURADURIA E7).
//
// `conflictos_abiertos` son conflictos de campo SIN una revisión viva que los
// lleve a una persona (src/curation/detectors/queue.ts): la pareja conflicto +
// revisión nace junta (src/conflicts/engine.ts), pero la revisión pudo cerrarse
// por otra vía dejando el conflicto abierto. Por eso se resuelven directo
// contra `ingest.conflicts` (src/review/operator-review.ts#resolveOpenConflict),
// sin depender de un `review_queue.id`.
import { getEnv } from "../config/env.js";
import { resolveOpenConflict } from "../review/operator-review.js";
import { CurationError, getFinding, listGroupFindings, type FindingGroupFilter, type FindingRow } from "./repository.js";

const CONFLICTS_DETECTOR = "conflictos_abiertos";

function conflictIdOf(finding: Pick<FindingRow, "id" | "evidence">): number {
  const id = finding.evidence["conflictId"];
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
    throw new CurationError("not_fixable", `el hallazgo ${finding.id} no tiene un conflicto asociado`);
  }
  return id;
}

export interface ResolveConflictInput {
  operator: string;
  note: string;
  choice?: "a" | "b" | "both" | "dismiss";
  value?: string | number | boolean | null;
}

/**
 * Resuelve el conflicto de un hallazgo `conflictos_abiertos`: «Elegir A» /
 * «Elegir B» / conservar ambos / descartar, o afirmar «otro valor» que no sea
 * ninguno de los dos rivales.
 */
export async function resolveConflictFinding(findingId: number, input: ResolveConflictInput) {
  const finding = await getFinding(findingId);
  if (!finding) throw new CurationError("not_found", `hallazgo inexistente: ${findingId}`);
  if (finding.detector !== CONFLICTS_DETECTOR) {
    throw new CurationError("invalid", `el hallazgo ${findingId} no es un conflicto abierto (${finding.detector})`);
  }
  if (finding.status !== "open") throw new CurationError("not_open", "solo se puede resolver un hallazgo abierto");
  return resolveOpenConflict(conflictIdOf(finding), input);
}

/**
 * «high»/«api» primero: el canal de YouTube del proyecto es la fuente `api` y
 * es la verdad principal por decisión de Brian (2026-09-13, Mesa de Cotejo);
 * el resto ordena por confianza declarada. Un empate no se decide solo.
 */
const TRUST_RANK: Readonly<Record<string, number>> = { api: 4, high: 3, medium: 2, low: 1 };

export interface ResolveConflictsGroupOutcome {
  /** Hallazgos `conflictos_abiertos` que cumplían el filtro (tope `CRV_CURATION_FIX_BATCH_MAX`). */
  total: number;
  applied: number;
  /** Mismo `trust_level` a ambos lados: nadie decidió, queda para una persona. */
  tied: number;
  failed: number;
  errors: Array<{ findingId: number; error: string }>;
  /** Quedan más hallazgos que el tope de esta llamada: hay que repetirla. */
  more: boolean;
}

/**
 * Acción de grupo «aplicar la fuente de mayor confianza» (PLAN_CURADURIA
 * E7.2): sobre exactamente los hallazgos que cumplen el filtro visible (igual
 * que ignorar o corregir en grupo, C3), resuelve cada conflicto por el lado de
 * mayor `trust_level`; los empates quedan fuera y siguen abiertos.
 */
export async function resolveConflictsGroupByTrust(
  filter: FindingGroupFilter, operator: string, note: string,
): Promise<ResolveConflictsGroupOutcome> {
  if (filter.detector !== CONFLICTS_DETECTOR) {
    throw new CurationError("invalid", "esta acción solo aplica al detector «conflictos_abiertos»");
  }
  const max = getEnv().CRV_CURATION_FIX_BATCH_MAX;
  const { rows, total } = await listGroupFindings(filter, max);
  const outcome: ResolveConflictsGroupOutcome = { total: rows.length, applied: 0, tied: 0, failed: 0, errors: [], more: total > rows.length };
  for (const finding of rows) {
    const sourceA = finding.evidence["sourceA"] as { trustLevel?: string } | undefined;
    const sourceB = finding.evidence["sourceB"] as { trustLevel?: string } | undefined;
    const rankA = TRUST_RANK[sourceA?.trustLevel ?? ""] ?? 0;
    const rankB = TRUST_RANK[sourceB?.trustLevel ?? ""] ?? 0;
    if (rankA === rankB) { outcome.tied += 1; continue; }
    try {
      await resolveOpenConflict(conflictIdOf(finding), { operator, note, choice: rankA > rankB ? "a" : "b" });
      outcome.applied += 1;
    } catch (error) {
      outcome.failed += 1;
      outcome.errors.push({ findingId: finding.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return outcome;
}
