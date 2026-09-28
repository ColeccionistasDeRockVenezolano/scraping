// CRV · Barrido de `persons.is_venezuelan` sobre el catálogo entero
// (`crv review derive-venezuelan`). La regla y la escritura viven en
// `merge/venezuelan.ts`; las altas de membresías y créditos ya la aplican al
// momento, así que el barrido recoge lo que esas altas no ven: una fusión de
// personas, un artista que pasa a venezolano, datos de antes de la regla.
import type { PoolClient } from "pg";
import { getPool } from "../db/client.js";
import { withOperatorRun } from "../merge/operator.js";
import { findVenezuelanEvidence, markVenezuelan, type VenezuelanEvidence } from "../merge/venezuelan.js";

export { venezuelanReason, VENEZUELAN_CREDIT_TYPES, type VenezuelanEvidence } from "../merge/venezuelan.js";

export interface VenezuelanSummary {
  persons: number;
  alreadyTrue: number;
  alreadyFalse: number;
  /** Sin dato y sin evidencia: quedan en NULL. */
  withoutEvidence: number;
  evidence: VenezuelanEvidence[];
}

export async function readVenezuelanEvidence(client: Pick<PoolClient, "query">): Promise<VenezuelanSummary> {
  const evidence = await findVenezuelanEvidence(client);
  const counts = await client.query<{ persons: number; yes: number; no: number; unknown: number }>(`
    SELECT count(*)::int AS persons,
           count(*) FILTER (WHERE is_venezuelan)::int AS yes,
           count(*) FILTER (WHERE NOT is_venezuelan)::int AS no,
           count(*) FILTER (WHERE is_venezuelan IS NULL)::int AS unknown
      FROM public.persons`);
  const total = counts.rows[0]!;
  return {
    persons: total.persons, alreadyTrue: total.yes, alreadyFalse: total.no,
    withoutEvidence: total.unknown - evidence.length, evidence,
  };
}

export interface VenezuelanApplyResult { runs: number[]; updated: number; skipped: number }

/**
 * Marca como venezolanas las personas con evidencia, en lotes de un run de
 * operador cada uno (el diario de cambios los liga y `crv runs undo` los
 * deshace).
 */
export async function applyVenezuelanEvidence(
  evidence: readonly VenezuelanEvidence[], options: { note: string; operator: string; batchSize?: number },
): Promise<VenezuelanApplyResult> {
  const result: VenezuelanApplyResult = { runs: [], updated: 0, skipped: 0 };
  const size = options.batchSize ?? 1000;
  for (let start = 0; start < evidence.length; start += size) {
    const batch = evidence.slice(start, start + size);
    const { runId, result: updated } = await withOperatorRun(
      { name: "derivar-venezolano", operator: options.operator, note: options.note, params: { from: start, count: batch.length, rule: "miembro o músico/invitado en disco venezolano" } },
      (context) => markVenezuelan(context.client, batch, context.runId),
    );
    result.runs.push(runId);
    result.updated += updated;
    result.skipped += batch.length - updated;
  }
  return result;
}

/**
 * Barrido completo si hay algo que marcar; sin evidencia no abre ningún run.
 * Lo llaman los procesos largos de la CLI al terminar.
 */
export async function sweepVenezuelan(note: string, operator = "cli"): Promise<VenezuelanApplyResult> {
  const evidence = await findVenezuelanEvidence(getPool());
  if (evidence.length === 0) return { runs: [], updated: 0, skipped: 0 };
  return applyVenezuelanEvidence(evidence, { note, operator });
}
