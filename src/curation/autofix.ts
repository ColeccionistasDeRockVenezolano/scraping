// CRV · Autocorrección segura de Curaduría (PLAN_CURADURIA E10, §2.2).
//
// Es la única parte del sistema que escribe en el core sin que una persona
// pulse nada, así que está construida para no poder hacer daño:
//
//  1. APAGADA POR DEFECTO. `CRV_CURATION_AUTOFIX=false` en el entorno: sin eso
//     no corre nunca, aunque haya reglas encendidas.
//  2. LISTA BLANCA. Solo corrige lo que un administrador autorizó, detector y
//     subgrupo a subgrupo, con UNA acción concreta
//     (`ingest.curation_autofix_rules`). Una regla nace apagada.
//  3. SOLO NIVEL 0: acciones deterministas y reversibles, sin criterio humano
//     (quitar invisibles, colapsar espacios, decodificar entidades HTML). El
//     marco lo vuelve a exigir al previsualizar (`MAX_LEVEL.auto = 0`).
//  4. TOPES por análisis y por día, y un lote por regla: si algo sale mal, se
//     sabe exactamente qué regla lo hizo y se deshace en bloque.
//  5. INTERRUPTOR DE EMERGENCIA. Cada lote automático se verifica dirigido
//     antes de seguir. Si la verificación encuentra hallazgos DESENCADENADOS
//     —la corrección abrió problemas nuevos— el lote se deshace entero y la
//     regla queda apagada con el motivo, a la vista en el panorama.
//  6. TODO AUDITADO: cada lote es un lote normal (`mode = 'auto'`, firmado
//     `crv-curaduria-auto`) con su vista previa, su nota, sus runs y su
//     deshacer; y cada cambio de regla deja un evento con quién y por qué.
//
// Corre tras cada análisis COMPLETO guardado (`setAfterFullScan`). Nunca tras
// uno dirigido: un dirigido es justo la verificación de una corrección, y
// encadenar correcciones automáticas sin mirar el catálogo entero es la forma
// segura de irse por un barranco.
import { getEnv } from "../config/env.js";
import { getPool } from "../db/client.js";
import { moduleLogger } from "../logger/index.js";
import { DETECTOR_DEFINITIONS } from "./analyze.js";
import { applyFixBatch, previewFixBatch, undoFixBatch, type FixBatchView } from "./actions/batches.js";
import { applicableActions, getFixAction } from "./actions/registry.js";
import { CurationError, listAutofixCandidates } from "./repository.js";
import { setAfterFullScan, type ScanSummary } from "./scan.js";

const log = moduleLogger("curation:autofix");

/** Con quién se firman los lotes y los runs de la autocorrección. */
export const AUTOFIX_OPERATOR = "crv-curaduria-auto";

/** Candado entre procesos: dos APIs no autocorrigen a la vez. */
const AUTOFIX_LOCK = "crv:curation:autofix";

const DETECTOR_BY_KEY = new Map(DETECTOR_DEFINITIONS.map((detector) => [detector.key, detector]));

export interface AutofixRule {
  id: number;
  detector: string;
  /** null = todos los subgrupos del detector. */
  signature: string | null;
  actionKey: string;
  enabled: boolean;
  /** Tope propio; null = el del entorno. */
  maxPerScan: number | null;
  note: string | null;
  createdBy: string;
  createdAt: string;
  updatedBy: string | null;
  updatedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  disabledByBatchId: number | null;
  /** Etiquetas para la pantalla: el detector y la acción tal como se llaman. */
  detectorLabel: string;
  actionLabel: string;
}

export interface AutofixEvent {
  id: number;
  ruleId: number | null;
  detector: string;
  signature: string | null;
  actionKey: string;
  event: string;
  operator: string;
  note: string | null;
  batchId: number | null;
  detail: Record<string, unknown>;
  at: string;
}

const RULE_COLUMNS = `id::text, detector, signature, action_key, enabled, max_per_scan, note, created_by, created_at,
  updated_by, updated_at, disabled_at, disabled_reason, disabled_by_batch_id::text`;

interface RawRule {
  id: string; detector: string; signature: string | null; action_key: string; enabled: boolean; max_per_scan: number | null;
  note: string | null; created_by: string; created_at: Date; updated_by: string | null; updated_at: Date | null;
  disabled_at: Date | null; disabled_reason: string | null; disabled_by_batch_id: string | null;
}

const iso = (value: Date | null): string | null => (value === null ? null : new Date(value).toISOString());

function ruleRow(row: RawRule): AutofixRule {
  return {
    id: Number(row.id), detector: row.detector, signature: row.signature, actionKey: row.action_key, enabled: row.enabled,
    maxPerScan: row.max_per_scan, note: row.note, createdBy: row.created_by, createdAt: iso(row.created_at)!,
    updatedBy: row.updated_by, updatedAt: iso(row.updated_at), disabledAt: iso(row.disabled_at),
    disabledReason: row.disabled_reason, disabledByBatchId: row.disabled_by_batch_id === null ? null : Number(row.disabled_by_batch_id),
    detectorLabel: DETECTOR_BY_KEY.get(row.detector)?.label ?? row.detector,
    actionLabel: getFixAction(row.action_key)?.label ?? row.action_key,
  };
}

// ---------------------------------------------------------------------------
// Reglas: lista blanca editable solo por administradores, con auditoría
// ---------------------------------------------------------------------------

export interface AutofixRuleInput {
  detector: string;
  signature?: string | null | undefined;
  actionKey: string;
  enabled?: boolean | undefined;
  maxPerScan?: number | null | undefined;
  note?: string | null | undefined;
}

/**
 * Una regla solo puede existir si el detector existe, la acción existe, el
 * detector la propone y es de NIVEL 0. Lo comprueba al guardarla, no al
 * aplicarla: una lista blanca con una regla imposible es una lista blanca que
 * miente.
 */
function assertRule(detector: string, signature: string | null, actionKey: string): void {
  const definition = DETECTOR_BY_KEY.get(detector);
  if (!definition) throw new CurationError("invalid", `detector desconocido: ${detector}`);
  const action = getFixAction(actionKey);
  if (!action) throw new CurationError("invalid", `acción desconocida: ${actionKey}`);
  if (action.level !== 0) {
    throw new CurationError("invalid", `«${action.label}» es de nivel ${action.level}: la autocorrección solo aplica acciones de nivel 0`);
  }
  const declared = definition.actions ?? {};
  const offered = signature === null
    ? new Set(Object.values(declared).flatMap((keys) => [...keys]))
    : new Set([...(declared[signature] ?? []), ...(declared["*"] ?? [])]);
  if (!offered.has(actionKey)) {
    throw new CurationError("invalid",
      `«${definition.label}»${signature === null ? "" : ` (${signature})`} no propone «${action.label}»`);
  }
}

/** Una combinación que la lista blanca admitiría: detector + subgrupo + acción de nivel 0. */
export interface AutofixOption {
  detector: string;
  detectorLabel: string;
  /** null = todos los subgrupos del detector. */
  signature: string | null;
  actionKey: string;
  actionLabel: string;
  actionDescription: string;
}

/**
 * Lo que se puede autorizar, para que la pantalla no tenga que adivinarlo ni
 * el administrador escribir claves a mano: de cada detector, las acciones que
 * propone que además son de nivel 0. Es la misma regla que valida `assertRule`,
 * dicha en positivo.
 */
export function autofixCatalog(): AutofixOption[] {
  return DETECTOR_DEFINITIONS.flatMap((detector) =>
    Object.entries(detector.actions ?? {}).flatMap(([signature, keys]) =>
      [...keys].flatMap((key) => {
        const action = getFixAction(key);
        if (!action || action.level !== 0) return [];
        return [{
          detector: detector.key, detectorLabel: detector.label,
          signature: signature === "*" ? null : signature,
          actionKey: action.key, actionLabel: action.label, actionDescription: action.description,
        }];
      })));
}

export async function listAutofixRules(): Promise<AutofixRule[]> {
  const { rows } = await getPool().query<RawRule>(
    `SELECT ${RULE_COLUMNS} FROM ingest.curation_autofix_rules ORDER BY detector, coalesce(signature, ''), action_key`);
  return rows.map(ruleRow);
}

async function getRule(id: number): Promise<AutofixRule> {
  const { rows } = await getPool().query<RawRule>(`SELECT ${RULE_COLUMNS} FROM ingest.curation_autofix_rules WHERE id = $1`, [id]);
  if (!rows[0]) throw new CurationError("not_found", `regla de autocorrección inexistente: ${id}`);
  return ruleRow(rows[0]);
}

interface EventInput {
  rule: { id: number | null; detector: string; signature: string | null; actionKey: string };
  event: "created" | "updated" | "enabled" | "disabled" | "deleted" | "auto_disabled" | "applied" | "undone";
  operator: string;
  note?: string | null;
  batchId?: number | null;
  detail?: Record<string, unknown>;
}

async function recordEvent(input: EventInput): Promise<void> {
  await getPool().query(`
    INSERT INTO ingest.curation_autofix_events (rule_id, detector, signature, action_key, event, operator, note, batch_id, detail)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
  [input.rule.id, input.rule.detector, input.rule.signature, input.rule.actionKey, input.event, input.operator,
    input.note ?? null, input.batchId ?? null, JSON.stringify(input.detail ?? {})]);
}

export async function createAutofixRule(input: AutofixRuleInput, operator: string): Promise<AutofixRule> {
  const signature = input.signature ?? null;
  assertRule(input.detector, signature, input.actionKey);
  const { rows } = await getPool().query<RawRule>(`
    INSERT INTO ingest.curation_autofix_rules (detector, signature, action_key, enabled, max_per_scan, note, created_by)
    VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (detector, coalesce(signature, '*'), action_key) DO NOTHING
    RETURNING ${RULE_COLUMNS}`,
  [input.detector, signature, input.actionKey, input.enabled ?? false, input.maxPerScan ?? null, input.note ?? null, operator]);
  if (!rows[0]) throw new CurationError("not_open", "ya existe una regla para ese detector, subgrupo y acción");
  const rule = ruleRow(rows[0]);
  await recordEvent({ rule, event: "created", operator, note: rule.note, detail: { enabled: rule.enabled, maxPerScan: rule.maxPerScan } });
  if (rule.enabled) await recordEvent({ rule, event: "enabled", operator, note: rule.note });
  return rule;
}

export interface AutofixRuleChange {
  enabled?: boolean | undefined;
  maxPerScan?: number | null | undefined;
  note?: string | null | undefined;
}

/** Encender una regla borra el motivo por el que estuvo apagada: es una decisión nueva. */
export async function updateAutofixRule(id: number, change: AutofixRuleChange, operator: string): Promise<AutofixRule> {
  const before = await getRule(id);
  const enabled = change.enabled ?? before.enabled;
  if (enabled) assertRule(before.detector, before.signature, before.actionKey);
  const { rows } = await getPool().query<RawRule>(`
    UPDATE ingest.curation_autofix_rules
       SET enabled = $2,
           max_per_scan = CASE WHEN $3::boolean THEN $4 ELSE max_per_scan END,
           note = CASE WHEN $5::boolean THEN $6 ELSE note END,
           updated_by = $7, updated_at = now(),
           disabled_at = CASE WHEN $2 THEN NULL ELSE disabled_at END,
           disabled_reason = CASE WHEN $2 THEN NULL ELSE disabled_reason END,
           disabled_by_batch_id = CASE WHEN $2 THEN NULL ELSE disabled_by_batch_id END
     WHERE id = $1
    RETURNING ${RULE_COLUMNS}`,
  [id, enabled, change.maxPerScan !== undefined, change.maxPerScan ?? null, change.note !== undefined, change.note ?? null, operator]);
  const rule = ruleRow(rows[0]!);
  await recordEvent({ rule, event: "updated", operator, note: rule.note, detail: { enabled: rule.enabled, maxPerScan: rule.maxPerScan } });
  if (before.enabled !== rule.enabled) await recordEvent({ rule, event: rule.enabled ? "enabled" : "disabled", operator, note: change.note ?? null });
  return rule;
}

export async function deleteAutofixRule(id: number, operator: string): Promise<AutofixRule> {
  const rule = await getRule(id);
  await getPool().query("DELETE FROM ingest.curation_autofix_rules WHERE id = $1", [id]);
  await recordEvent({ rule: { ...rule, id: null }, event: "deleted", operator });
  return rule;
}

export async function listAutofixEvents(limit = 50): Promise<AutofixEvent[]> {
  const { rows } = await getPool().query<{
    id: string; rule_id: string | null; detector: string; signature: string | null; action_key: string; event: string;
    operator: string; note: string | null; batch_id: string | null; detail: Record<string, unknown>; at: Date;
  }>(`
    SELECT id::text, rule_id::text, detector, signature, action_key, event, operator, note, batch_id::text, detail, at
      FROM ingest.curation_autofix_events ORDER BY id DESC LIMIT $1`, [limit]);
  return rows.map((row) => ({
    id: Number(row.id), ruleId: row.rule_id === null ? null : Number(row.rule_id), detector: row.detector, signature: row.signature,
    actionKey: row.action_key, event: row.event, operator: row.operator, note: row.note,
    batchId: row.batch_id === null ? null : Number(row.batch_id), detail: row.detail, at: new Date(row.at).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Informe del panorama (E10.4)
// ---------------------------------------------------------------------------

export interface AutofixTodayBatch {
  batchId: number;
  detector: string;
  signature: string | null;
  actionKey: string;
  status: string;
  applied: number;
  undone: number;
  triggered: number;
  at: string;
  undoneByBatchId: number | null;
}

export interface AutofixAlert {
  ruleId: number | null;
  detector: string;
  signature: string | null;
  actionKey: string;
  reason: string;
  batchId: number | null;
  at: string;
}

export interface AutofixReport {
  /** El interruptor del entorno: sin él no corre aunque haya reglas encendidas. */
  enabled: boolean;
  rules: { total: number; active: number };
  today: { batches: number; applied: number; undone: number };
  batches: AutofixTodayBatch[];
  /** Reglas que el interruptor de emergencia apagó solo (las últimas). */
  alerts: AutofixAlert[];
}

const TODAY = "b.created_at >= date_trunc('day', now())";

export async function autofixReport(): Promise<AutofixReport> {
  const pool = getPool();
  const [rules, batches, alerts] = await Promise.all([
    pool.query<{ total: string; active: string }>(
      "SELECT count(*)::text AS total, count(*) FILTER (WHERE enabled)::text AS active FROM ingest.curation_autofix_rules"),
    pool.query<{
      id: string; status: string; filter: Record<string, unknown>; action_key: string | null; counts: Record<string, unknown>;
      verification: Record<string, unknown> | null; created_at: Date; undone_by_batch_id: string | null;
    }>(`
      SELECT b.id::text, b.status, b.filter, b.action_key, b.counts, b.verification, b.created_at, b.undone_by_batch_id::text
        FROM ingest.curation_fix_batches b
       WHERE b.mode = 'auto' AND ${TODAY} AND b.status <> 'previewed'
       ORDER BY b.id DESC LIMIT 50`),
    pool.query<{
      rule_id: string | null; detector: string; signature: string | null; action_key: string; note: string | null;
      batch_id: string | null; at: Date;
    }>(`
      SELECT rule_id::text, detector, signature, action_key, note, batch_id::text, at
        FROM ingest.curation_autofix_events WHERE event = 'auto_disabled' ORDER BY id DESC LIMIT 10`),
  ]);
  const count = (counts: Record<string, unknown>, key: string): number => (typeof counts[key] === "number" ? counts[key] : 0);
  const today = batches.rows.map((row) => ({
    batchId: Number(row.id),
    detector: typeof row.filter["detector"] === "string" ? row.filter["detector"] : "",
    signature: typeof row.filter["signature"] === "string" ? row.filter["signature"] : null,
    actionKey: row.action_key ?? "",
    status: row.status,
    applied: count(row.counts, "applied"),
    undone: count(row.counts, "undone"),
    triggered: typeof row.verification?.["triggeredCount"] === "number" ? row.verification["triggeredCount"] : 0,
    at: new Date(row.created_at).toISOString(),
    undoneByBatchId: row.undone_by_batch_id === null ? null : Number(row.undone_by_batch_id),
  }));
  return {
    enabled: getEnv().CRV_CURATION_AUTOFIX,
    rules: { total: Number(rules.rows[0]?.total ?? 0), active: Number(rules.rows[0]?.active ?? 0) },
    today: {
      batches: today.length,
      applied: today.reduce((sum, item) => sum + item.applied, 0),
      undone: today.reduce((sum, item) => sum + item.undone, 0),
    },
    batches: today,
    alerts: alerts.rows.map((row) => ({
      ruleId: row.rule_id === null ? null : Number(row.rule_id), detector: row.detector, signature: row.signature,
      actionKey: row.action_key, reason: row.note ?? "", batchId: row.batch_id === null ? null : Number(row.batch_id),
      at: new Date(row.at).toISOString(),
    })),
  };
}

/** Lo que el panorama necesita saber de un vistazo (sin la lista de lotes). */
export type AutofixSummary = Omit<AutofixReport, "batches">;

export async function autofixSummary(): Promise<AutofixSummary> {
  const report = await autofixReport();
  return { enabled: report.enabled, rules: report.rules, today: report.today, alerts: report.alerts };
}

// ---------------------------------------------------------------------------
// La pasada automática
// ---------------------------------------------------------------------------

export type AutofixStatus = "apagada" | "sin_reglas" | "sin_candidatos" | "tope_diario" | "ocupada" | "hecha";

export interface AutofixRuleOutcome {
  ruleId: number;
  detector: string;
  signature: string | null;
  actionKey: string;
  batchId: number | null;
  applied: number;
  failed: number;
  triggered: number;
  /** El interruptor de emergencia deshizo el lote y apagó la regla. */
  reverted: boolean;
}

export interface AutofixRun {
  status: AutofixStatus;
  applied: number;
  rules: AutofixRuleOutcome[];
}

const EMPTY: Omit<AutofixRun, "status"> = { applied: 0, rules: [] };

/** Cuántas correcciones automáticas llevan aplicadas hoy (el tope diario). */
async function appliedToday(): Promise<number> {
  const { rows } = await getPool().query<{ n: string }>(`
    SELECT count(*)::text AS n
      FROM ingest.curation_fix_items i JOIN ingest.curation_fix_batches b ON b.id = i.batch_id
     WHERE b.mode = 'auto' AND i.status = 'applied' AND i.applied_at >= date_trunc('day', now())`);
  return Number(rows[0]?.n ?? 0);
}

const number = (counts: Record<string, unknown>, key: string): number => (typeof counts[key] === "number" ? counts[key] : 0);

/**
 * Aplica las reglas encendidas sobre lo que hay abierto. Un lote por regla:
 * previsualizar → aplicar → verificar → (si desencadenó algo) deshacer y apagar.
 */
export async function runAutofix(trigger: { scanId: number | null }): Promise<AutofixRun> {
  const env = getEnv();
  if (!env.CRV_CURATION_AUTOFIX) return { status: "apagada", ...EMPTY };
  const rules = (await listAutofixRules()).filter((rule) => rule.enabled);
  if (!rules.length) return { status: "sin_reglas", ...EMPTY };

  const client = await getPool().connect();
  let locked = false;
  try {
    const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [AUTOFIX_LOCK]);
    locked = lock.rows[0]?.locked === true;
    if (!locked) return { status: "ocupada", ...EMPTY };

    let dayBudget = env.CRV_CURATION_AUTOFIX_MAX_PER_DAY - await appliedToday();
    if (dayBudget <= 0) return { status: "tope_diario", ...EMPTY };
    let scanBudget = env.CRV_CURATION_AUTOFIX_MAX_PER_SCAN;
    const outcomes: AutofixRuleOutcome[] = [];
    let applied = 0;

    for (const rule of rules) {
      const budget = Math.min(rule.maxPerScan ?? scanBudget, scanBudget, dayBudget);
      if (budget <= 0) break;
      const outcome = await applyRule(rule, budget, trigger.scanId);
      if (!outcome) continue;
      outcomes.push(outcome);
      applied += outcome.applied;
      scanBudget -= outcome.applied;
      dayBudget -= outcome.applied;
    }
    return { status: outcomes.length ? "hecha" : "sin_candidatos", applied, rules: outcomes };
  } finally {
    let reusable = true;
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [AUTOFIX_LOCK]).catch(() => { reusable = false; });
    client.release(!reusable);
  }
}

async function applyRule(rule: AutofixRule, budget: number, scanId: number | null): Promise<AutofixRuleOutcome | null> {
  // Solo los hallazgos a los que esa acción se ofrece de verdad: pedir una
  // acción que el hallazgo no admite solo llenaría el lote de ítems bloqueados.
  const candidates = (await listAutofixCandidates(rule.detector, rule.signature, budget))
    .filter((finding) => applicableActions(finding).some((action) => action.key === rule.actionKey));
  if (!candidates.length) return null;

  const note = `Autocorrección: ${rule.detectorLabel} › ${rule.actionLabel}${scanId === null ? "" : ` (análisis ${scanId})`}`;
  const preview = await previewFixBatch({
    mode: "auto",
    findingIds: candidates.map((finding) => finding.id),
    actionKey: rule.actionKey,
    // Queda escrito en el lote de qué regla salió: el historial de correcciones
    // y el informe del panorama lo leen de ahí.
    origin: { autofixRuleId: rule.id, detector: rule.detector, ...(rule.signature === null ? {} : { signature: rule.signature }) },
  }, AUTOFIX_OPERATOR);
  const pending = number(preview.counts, "pending");
  const base: AutofixRuleOutcome = {
    ruleId: rule.id, detector: rule.detector, signature: rule.signature, actionKey: rule.actionKey,
    batchId: preview.id, applied: 0, failed: 0, triggered: 0, reverted: false,
  };
  if (pending === 0) return null;

  // La vista previa la acaba de hacer este mismo proceso y nadie la ha visto:
  // volver a comprobarla sería comparar el lote consigo mismo.
  const applied = await applyFixBatch(preview.id, { previewHash: preview.previewHash, note }, AUTOFIX_OPERATOR,
    { limit: 1, offset: 0 }, { recheck: false, verify: "await" });
  const outcome: AutofixRuleOutcome = {
    ...base,
    applied: number(applied.counts, "applied"),
    failed: number(applied.counts, "failed") + number(applied.counts, "skippedStale"),
    triggered: typeof applied.verification?.["triggeredCount"] === "number" ? applied.verification["triggeredCount"] : 0,
  };

  if (outcome.triggered > 0 && outcome.applied > 0) return revert(rule, applied, outcome);
  await recordEvent({
    rule, event: "applied", operator: AUTOFIX_OPERATOR, batchId: preview.id, note,
    detail: { applied: outcome.applied, failed: outcome.failed, scanId },
  });
  if (outcome.failed > 0) log.warn({ batchId: preview.id, detector: rule.detector, failed: outcome.failed }, "autocorrección con ítems que no se aplicaron");
  return outcome;
}

/**
 * Interruptor de emergencia (E10.3): la corrección automática hizo aparecer
 * hallazgos nuevos donde acababa de resolver otros. Se deshace el lote entero y
 * la regla queda apagada hasta que una persona decida otra cosa.
 */
async function revert(rule: AutofixRule, batch: FixBatchView, outcome: AutofixRuleOutcome): Promise<AutofixRuleOutcome> {
  const reason = `La verificación encontró ${outcome.triggered} ${outcome.triggered === 1 ? "hallazgo surgido" : "hallazgos surgidos"} tras el lote ${batch.id}: se deshizo y la regla quedó apagada.`;
  log.warn({ batchId: batch.id, ruleId: rule.id, detector: rule.detector, triggered: outcome.triggered },
    "interruptor de emergencia de la autocorrección: se deshace el lote y se apaga la regla");
  let reverted = false;
  try {
    await undoFixBatch(batch.id, { note: reason }, AUTOFIX_OPERATOR, { limit: 1, offset: 0 });
    reverted = true;
  } catch (error) {
    log.error({ err: error, batchId: batch.id }, "no se pudo deshacer el lote automático; la regla queda apagada igual");
  }
  await getPool().query(`
    UPDATE ingest.curation_autofix_rules
       SET enabled = false, disabled_at = now(), disabled_reason = $2, disabled_by_batch_id = $3, updated_by = $4, updated_at = now()
     WHERE id = $1`, [rule.id, reason, batch.id, AUTOFIX_OPERATOR]);
  await recordEvent({
    rule, event: "auto_disabled", operator: AUTOFIX_OPERATOR, batchId: batch.id, note: reason,
    detail: { triggered: outcome.triggered, applied: outcome.applied, undone: reverted },
  });
  if (reverted) await recordEvent({ rule, event: "undone", operator: AUTOFIX_OPERATOR, batchId: batch.id, note: reason });
  return { ...outcome, reverted };
}

/**
 * Engancha la autocorrección al final de cada análisis completo. Lo llaman los
 * dos sitios que analizan: la API al construirse y la CLI. Explícito a
 * propósito: nada que escriba solo en el core debería activarse por el mero
 * hecho de importar un módulo.
 */
export function installAutofix(): void {
  setAfterFullScan(async (summary: ScanSummary) => {
    const result = await runAutofix({ scanId: summary.scanId });
    if (result.status === "hecha") {
      log.info({ scanId: summary.scanId, applied: result.applied, rules: result.rules.length }, "autocorrección aplicada");
    }
    return result;
  });
}
