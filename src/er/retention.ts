// CRV · Retención de las decisiones de resolución de entidades.
//
// UNA DECISIÓN NO SE BORRA NUNCA: se compacta. Cada fila de
// `ingest.entity_resolution_decisions` guarda el dossier COMPLETO de
// candidatas que evaluó el ER; con el catálogo crecido son miles por decisión
// (~461 kB promedio en las últimas 1.000 filas medidas el 2026-09-18, sobre
// ~9.600 candidatas), y la tabla llegó a 19 GB —18 de ellos TOAST— con la
// primera ingesta masiva.
//
// Lo que el sistema vuelve a leer de una decisión es su cabeza: acción, score,
// features (la explicación del ganador), explanation, decided_by y
// `candidates->0` (mesa de cotejo, operator-review, dossiers de ambigüedad).
// El dossier completo de las 9.600 candidatas solo tiene valor forense
// reciente. Por eso la retención conserva:
//
//   * filas con menos de `keepFullDays` días: intactas;
//   * filas más viejas: las 20 mejores candidatas {candidateId,
//     canonicalName, score, action} —el orden del dossier es por score—, el
//     conteo original en `candidates_count` y `compacted_at` con la fecha.
//
// `input_context` NO se toca: aplicar una decisión vieja de la Mesa
// (src/review/decisions.ts) lo necesita tal cual para reconstruir el claim.
//
// Se ejecuta por lotes (`FOR UPDATE SKIP LOCKED`, una transacción por lotes)
// bajo candado de sesión `pg_try_advisory_lock`: la CLI y la API pueden pedirlo
// a la vez sin pisarse —el segundo ve `skipped`— y un proceso interrumpido se
// reanuda solo, porque cada lote es idempotente (lo compactado sale del WHERE).
import { getEnv } from "../config/env.js";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("er:retention");

/** Clave del candado entre procesos, igual en la API, la CLI y los scripts. */
export const ER_RETENTION_LOCK = "crv:er:retention";

/** Cuántas candidatas se conservan al compactar (las mejores, en su orden). */
export const KEEP_CANDIDATES = 20;

/** Espera del primer barrido en la API: no competir con el arranque. */
export const FIRST_RUN_DELAY_MS = 5 * 60 * 1000;

export interface CompactOptions {
  dryRun: boolean;
  /** Días de dossier completo conservados; por defecto ER_DECISION_FULL_DAYS. */
  keepFullDays?: number;
  /** Tope de filas por corrida; 0 o ausente = sin tope (uso de la CLI). */
  maxRows?: number;
  /** Filas por lote transaccional (por defecto 2.000). */
  batchSize?: number;
}

export interface CompactResult {
  dryRun: boolean;
  /** skipped = otro proceso tenía el candado; no se tocó nada. */
  status: "ok" | "skipped";
  keepFullDays: number;
  /** Filas pendientes de compactar al empezar (por el índice parcial). */
  pending: number;
  /** Filas compactadas en esta corrida. */
  compacted: number;
}

const PENDING_SQL = `
  SELECT count(*)::text AS n
    FROM ingest.entity_resolution_decisions
   WHERE compacted_at IS NULL AND created_at < now() - make_interval(days => $1::int)`;

// El lote se marca con FOR UPDATE SKIP LOCKED: dos procesos con el candado
// vencido no se esperan entre sí, y lo ya compactado (compacted_at IS NOT
// NULL) queda fuera del índice parcial, así que cada pasada cuesta lo que
// queda por hacer y no la tabla entera.
const COMPACT_BATCH_SQL = `
  WITH batch AS (
    SELECT id FROM ingest.entity_resolution_decisions
     WHERE compacted_at IS NULL AND created_at < now() - make_interval(days => $1::int)
     ORDER BY id
     LIMIT $2
     FOR UPDATE SKIP LOCKED
  )
  UPDATE ingest.entity_resolution_decisions d SET
    candidates_count = COALESCE(d.candidates_count, jsonb_array_length(d.candidates)),
    candidates = COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'candidateId', item->'candidateId',
               'canonicalName', item->'canonicalName',
               'score', item->'score',
               'action', item->'action') ORDER BY ord)
        FROM jsonb_array_elements(d.candidates) WITH ORDINALITY AS t(item, ord)
       WHERE ord <= ${KEEP_CANDIDATES}
    ), '[]'::jsonb),
    compacted_at = now()
  FROM batch
  WHERE d.id = batch.id`;

/**
 * Compacta los dossiers de candidatas más viejos que la ventana.
 * `--dry-run` cuenta pendientes sin escribir; en real, el candado decide quién
 * trabaja (el resto responde `skipped`).
 */
export async function compactEntityResolutionDecisions(options: CompactOptions): Promise<CompactResult> {
  const keepFullDays = Math.max(0, options.keepFullDays ?? getEnv().ER_DECISION_FULL_DAYS);
  const batchSize = Math.max(1, options.batchSize ?? 2_000);
  const maxRows = Math.max(0, options.maxRows ?? 0);
  const base = { dryRun: options.dryRun, keepFullDays };
  const client = await getPool().connect();
  let locked = false;
  try {
    const pending = Number((await client.query<{ n: string }>(PENDING_SQL, [keepFullDays])).rows[0]?.n ?? 0);
    if (options.dryRun) return { ...base, status: "ok", pending, compacted: 0 };

    const lock = await client.query<{ locked: boolean }>(
      "SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [ER_RETENTION_LOCK]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { ...base, status: "skipped", pending, compacted: 0 };

    let compacted = 0;
    while (maxRows === 0 || compacted < maxRows) {
      const limit = maxRows === 0 ? batchSize : Math.min(batchSize, maxRows - compacted);
      const result = await client.query(COMPACT_BATCH_SQL, [keepFullDays, limit]);
      const done = result.rowCount ?? 0;
      compacted += done;
      // Un lote incompleto significa que ya no quedan pendientes.
      if (done < limit) break;
    }
    return { ...base, status: "ok", pending, compacted };
  } finally {
    // El candado vive en la sesión: se suelta siempre, incluso si un lote falló.
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [ER_RETENTION_LOCK]).catch(() => undefined);
    client.release();
  }
}

/**
 * Retención programada de la API: primer barrido a los 5 minutos del arranque
 * (no competir con el calentamiento) y luego cada `intervalMs`, siempre con
 * tope de filas para no monopolizar el disco. Nada de aquí puede rechazar sin
 * manejarse: corre en background y un rechazo suelto terminaría el proceso.
 */
export function startEntityResolutionRetention(intervalMs: number, maxRowsPerRun: number): () => void {
  let stopped = false;
  const runOnce = (): void => {
    if (stopped) return;
    compactEntityResolutionDecisions({ dryRun: false, maxRows: maxRowsPerRun })
      .then((result) => {
        if (result.status === "skipped") return;
        if (result.compacted > 0 || result.pending > 0) {
          log.info({ compacted: result.compacted, pendingBefore: result.pending, keepFullDays: result.keepFullDays },
            "retención de decisiones ER");
        }
      })
      .catch((error: unknown) => log.error({ err: error }, "la retención de decisiones ER falló"));
  };
  const first = setTimeout(runOnce, FIRST_RUN_DELAY_MS);
  const timer = setInterval(runOnce, intervalMs);
  first.unref();
  timer.unref();
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
  };
}
