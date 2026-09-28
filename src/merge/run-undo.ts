// CRV · Deshacer un run, venga de donde venga (API, Curaduría o CLI).
//
// Es la puerta única: `POST /changes/:runId/undo`, `crv runs undo`, el
// deshacer de lotes de Curaduría y el de fusiones pasan por aquí.
//
//  * CON DIARIO (runs desde la migración 0028): `undoRunWithJournal` devuelve
//    cada fila a como estaba. No depende de la acción: fusiones, divisiones,
//    conversiones, retiros, ediciones y lotes de la CLI se deshacen igual.
//  * SIN DIARIO (runs anteriores): la inversa propia de la acción, si la hay
//    (fusión, retiro, relación creada, corrección de campo). Si no, se dice.
//  * UN RUN DESHECHO NO SE DESHACE DOS VECES. `ingest.run_undos` guarda qué
//    run deshizo a cuál; para volver a aplicarlo se deshace el deshacer
//    (rehacer), que también queda en el diario.
import type { PoolClient } from "pg";
import { undoFieldCorrections } from "./field-undo.js";
import { runHasJournal, undoRunWithJournal, planJournalUndo, type JournalUndoPlan } from "./journal-undo.js";
import { OperatorError, type OperatorContext } from "./operator.js";
import { undoEntityRemoval, undoRelationCreation } from "./structural-undo.js";
import { undoMergeRun } from "./unmerge.js";

export type LegacyInverse = (context: OperatorContext, runId: number) => Promise<unknown>;

export interface RunUndoResult {
  /** Run deshecho. */
  undoneRunId: number;
  method: "journal" | "legacy";
  result: unknown;
}

/** Un run sigue «en curso» un rato: deshacerlo a medias dejaría la mitad de lo que haga después. */
const RUNNING_GRACE = "1 hour";

/**
 * Run que tiene deshecho a `runId` ahora mismo, o null. Un deshacer que a su
 * vez se deshizo (rehacer) ya no cuenta.
 */
export async function activeUndoOf(client: Pick<PoolClient, "query">, runId: number, depth = 0): Promise<number | null> {
  if (depth > 20) return null;
  const { rows } = await client.query<{ undo_run_id: string }>(
    "SELECT undo_run_id::text FROM ingest.run_undos WHERE run_id=$1 ORDER BY id DESC", [runId]);
  for (const row of rows) {
    const undoRunId = Number(row.undo_run_id);
    if (await activeUndoOf(client, undoRunId, depth + 1) === null) return undoRunId;
  }
  return null;
}

/** Inversa propia de un run anterior al diario, deducida de lo que dejó en la auditoría y en sus params. */
async function detectLegacyInverse(client: PoolClient, runId: number, params: Record<string, unknown>): Promise<LegacyInverse | null> {
  const fields = (await client.query<{ field: string }>(
    "SELECT DISTINCT field FROM ingest.merge_audit WHERE run_id=$1", [runId])).rows.map((row) => row.field);
  if (fields.includes("merged_duplicate")) return undoMergeRun;
  if (params["removed"]) return undoEntityRemoval;
  if (params["relationCreated"] || params["entityCreated"]) return undoRelationCreation;
  if (fields.length > 0) return undoFieldCorrections;
  return null;
}

interface RunRow {
  id: string;
  status: string;
  params: Record<string, unknown> | null;
  recent: boolean;
}

async function loadRun(client: Pick<PoolClient, "query">, runId: number): Promise<RunRow> {
  const { rows } = await client.query<RunRow>(`
    SELECT id::text, status::text, params, started_at > now() - interval '${RUNNING_GRACE}' AS recent
      FROM ingest.scrape_runs WHERE id=$1`, [runId]);
  const run = rows[0];
  if (!run) throw new OperatorError("not_found", `el cambio #${runId} no existe`, { runId });
  return run;
}

async function assertUndoable(client: Pick<PoolClient, "query">, run: RunRow, runId: number, ownRunId?: number): Promise<void> {
  if (ownRunId === runId) throw new OperatorError("invalid", "un cambio no puede deshacerse a sí mismo", { runId });
  if (run.status === "running" && run.recent) {
    throw new OperatorError("not_open", `el cambio #${runId} sigue en curso: espera a que termine para deshacerlo`, { runId });
  }
  const undoneBy = await activeUndoOf(client, runId);
  if (undoneBy !== null) {
    throw new OperatorError("not_open",
      `el cambio #${runId} ya está deshecho (por #${undoneBy}); para volver a aplicarlo, deshaz #${undoneBy}`,
      { runId, undoneBy });
  }
}

export interface RunUndoPreview {
  runId: number;
  method: "journal" | "legacy" | null;
  /** false: no se puede deshacer; `reason` dice por qué. */
  undoable: boolean;
  reason: string | null;
  undoneBy: number | null;
  plan: JournalUndoPlan | null;
}

/** Qué pasaría al deshacer el run, sin escribir nada (la web lo muestra antes de confirmar). */
export async function previewRunUndo(client: PoolClient, runId: number): Promise<RunUndoPreview> {
  const run = await loadRun(client, runId);
  const undoneBy = await activeUndoOf(client, runId);
  const base = { runId, undoneBy };
  try {
    await assertUndoable(client, run, runId);
  } catch (error) {
    if (error instanceof OperatorError) return { ...base, method: null, undoable: false, reason: error.message, plan: null };
    throw error;
  }
  if (await runHasJournal(client, runId)) {
    const plan = await planJournalUndo(client, runId);
    if (plan.conflicts.length) {
      const later = [...new Set(plan.conflicts.map((conflict) => conflict.laterRunId).filter((id): id is number => id !== null))];
      return {
        ...base, method: "journal", undoable: false, plan,
        reason: `${plan.conflicts.length === 1 ? "Una ficha cambió" : `${plan.conflicts.length} filas del catálogo cambiaron`} después de este cambio`
          + (later.length ? `: deshaz primero ${later.map((id) => `#${id}`).join(", ")}.` : "."),
      };
    }
    return { ...base, method: "journal", undoable: true, reason: null, plan };
  }
  const legacy = await detectLegacyInverse(client, runId, run.params ?? {});
  return legacy
    ? { ...base, method: "legacy", undoable: true, reason: "Cambio anterior al diario: se deshace con la inversa propia de la acción, que comprueba al aplicar que nada cambió después.", plan: null }
    : { ...base, method: null, undoable: false, plan: null, reason: "Cambio anterior al diario de cambios (22-09-2026) y sin una inversa propia: no se puede deshacer desde aquí." };
}

/**
 * Deshace `runId` dentro de la transacción de `context` (un run de operador
 * nuevo). `legacyInverse` fuerza la inversa propia cuando el run no tiene
 * diario (Curaduría sabe cuál es la de cada acción).
 */
export async function undoRun(
  context: OperatorContext, runId: number, options: { legacyInverse?: LegacyInverse | null } = {},
): Promise<RunUndoResult> {
  const client = context.client;
  // Dos deshacer a la vez sobre filas vecinas podrían cruzarse: uno por vez.
  await client.query("SELECT pg_advisory_xact_lock(hashtext('crv:run-undo'))");
  const run = await loadRun(client, runId);
  await assertUndoable(client, run, runId, context.runId);

  let method: RunUndoResult["method"];
  let result: unknown;
  if (await runHasJournal(client, runId)) {
    method = "journal";
    result = await undoRunWithJournal(context, runId);
  } else {
    const inverse = options.legacyInverse ?? await detectLegacyInverse(client, runId, run.params ?? {});
    if (!inverse) {
      throw new OperatorError("not_open",
        `el cambio #${runId} es anterior al diario de cambios y no tiene una inversa propia: no se puede deshacer desde aquí`, { runId });
    }
    method = "legacy";
    result = await inverse(context, runId);
  }
  await client.query(
    "INSERT INTO ingest.run_undos(run_id, undo_run_id, method, summary) VALUES ($1, $2, $3, $4::jsonb)",
    [runId, context.runId, method, JSON.stringify(summaryOf(result))]);
  await client.query(
    "UPDATE ingest.scrape_runs SET params=COALESCE(params,'{}'::jsonb) || jsonb_build_object('undoOfRun', $2::bigint) WHERE id=$1",
    [context.runId, runId]);
  // Una corrección de Curaduría deshecha desde el historial general también
  // queda deshecha en su lote.
  await client.query(
    "UPDATE ingest.curation_fix_items SET status='undone', error_code=NULL, error=NULL WHERE run_id=$1 AND status='applied'", [runId]);
  return { undoneRunId: runId, method, result };
}

/** Lo que se guarda del resultado en `run_undos.summary`: los recuentos, no las filas. */
function summaryOf(result: unknown): Record<string, unknown> {
  if (!result || typeof result !== "object") return {};
  const source = result as Record<string, unknown>;
  const summary: Record<string, unknown> = {};
  for (const key of ["changes", "steps", "claimsSuperseded", "claimsDetached", "claimsToSupersede"]) {
    if (key in source) summary[key] = source[key];
  }
  if (Array.isArray(source["entities"])) summary["entities"] = (source["entities"] as unknown[]).slice(0, 20);
  if (Array.isArray(source["skipped"])) summary["skipped"] = (source["skipped"] as unknown[]).length;
  if (Array.isArray(source["restored"])) summary["restored"] = source["restored"];
  return summary;
}
