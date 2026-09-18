// CRV · Lotes de correcciones de Curaduría (PLAN_CURADURIA E4.2–E4.6: A1, A8, M6, M1).
//
// Toda corrección —de un hallazgo, de una selección o de un grupo filtrado— es
// un LOTE con el mismo ciclo: vista previa → aplicar → verificar → deshacer.
//
// VISTA PREVIA. Una sola foto del catálogo (REPEATABLE READ, solo lectura). Por
// hallazgo: la acción (la recomendada o la pedida), sus parámetros, el nivel
// que admite el modo, las precondiciones y el antes → después con las fichas
// que toca y sus colisiones. Cada ítem guarda el hash de lo que se vio y el
// lote el hash de todos sus ítems. Varios ítems sobre la misma ficha y campo se
// encadenan: cada uno parte de lo que deja el anterior (C4).
//
// APLICAR exige el hash del lote y una nota. Antes de escribir nada se vuelve a
// calcular la vista previa de lo pendiente sobre una foto nueva: si el hash de
// algún ítem ya no es el que la persona vio (la ficha cambió, el hallazgo se
// cerró), 409 con esos ítems y nada escrito; se previsualiza otra vez o se
// excluyen. Ya empezado, cada ítem es su propio `withOperatorRun` —auditoría
// por ficha, igual que una edición a mano— con candados por ficha, y dentro de
// esa transacción se recalcula otra vez su vista previa: un ítem que cambió en
// medio del lote queda `skipped_stale` y el lote sigue. Un fallo tampoco lo
// detiene. Cada llamada aplica hasta `CRV_CURATION_FIX_BATCH_MAX` ítems; el
// resto, con otra llamada explícita (sin la comprobación previa: el lote ya
// está a medias y cada ítem se comprueba al escribirse).
//
// VERIFICAR: tras aplicar, un análisis dirigido a las fichas tocadas y sus
// relacionadas (scan.ts) adjunta al lote lo resuelto, lo nuevo y lo
// desencadenado; los hallazgos corregidos quedan `fixed_by_curation` con el run
// de su ítem (M1).
//
// DESHACER es otro lote (`mode = 'undo'`): recorre lo aplicado en orden
// inverso, un run por corrección, con la inversa de cada acción (CAS inverso de
// campos o `undoMergeRun`). Si algo cambió después, esa corrección queda
// `not_undoable` con el motivo y el resto se deshace igual.
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { getEnv } from "../../config/env.js";
import { getPool } from "../../db/client.js";
import { moduleLogger } from "../../logger/index.js";
import { undoFieldCorrections } from "../../merge/field-undo.js";
import { OperatorError, withOperatorRun, type OperatorContext } from "../../merge/operator.js";
import { undoEntityRemoval, undoRelationCreation } from "../../merge/structural-undo.js";
import { undoMergeRun } from "../../merge/unmerge.js";
import {
  CurationError, getFindingForUpdate, getFindingsByIds, listGroupFindings, type FindingGroupFilter, type FindingRow,
} from "../repository.js";
import { CURATION_UNDO_RUN_PREFIX } from "../resolution.js";
import { runCurationScan, trackCurationWork, type ResolvedRef } from "../scan.js";
import { notifyCatalogWrite } from "../watcher.js";
import type { EntityRef } from "../types.js";
import { liveNameLookup, previewNameLookup } from "./names.js";
import { applicableActions, getFixAction } from "./registry.js";
import type {
  ActionContext, ActionInverse, ActionLevel, ActionPreview, ActionProposal, AnyFixAction, Blocked, BlockedCode, Collision,
  EntityKey, FixMode, Precondition,
} from "./types.js";

const log = moduleLogger("curation:fixes");

export type HumanFixMode = Exclude<FixMode, "auto">;
export type BatchMode = FixMode | "undo";
export const BATCH_STATUSES = ["previewed", "running", "done", "partial", "failed", "undone"] as const;
export type BatchStatus = (typeof BATCH_STATUSES)[number];
export const ITEM_STATUSES = ["pending", "blocked", "excluded", "applied", "skipped_stale", "failed", "undone", "not_undoable"] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

/** Hasta qué nivel se aplica en cada modo (§2.1.5): un grupo, solo lo determinista; el nivel 3 nunca. */
export const MAX_LEVEL: Readonly<Record<FixMode, ActionLevel>> = { individual: 2, selected: 2, group: 1, auto: 0 };

const MODE_NOUN: Readonly<Record<FixMode, string>> = {
  individual: "una corrección individual", selected: "una selección", group: "un grupo", auto: "la autocorrección",
};

/** Ítems que devuelve una respuesta si nadie pide otra página. */
export const DEFAULT_ITEM_PAGE = 50;
/** Filas por INSERT de ítems. */
const ITEM_CHUNK = 500;
/** Hallazgos que la verificación adjunta por lista (los recuentos van siempre completos). */
const VERIFICATION_LIST_MAX = 200;

export interface ItemOverride {
  actionKey?: string | undefined;
  params?: Record<string, unknown> | undefined;
}

export interface FixPreviewRequest {
  mode: HumanFixMode;
  findingIds?: readonly number[] | undefined;
  filter?: FindingGroupFilter | undefined;
  /** Acción común a todos los ítems; sin ella, la recomendada de cada hallazgo. */
  actionKey?: string | undefined;
  overrides?: {
    /** Parámetros comunes (p. ej. el valor escrito a mano de una corrección individual). */
    params?: Record<string, unknown> | undefined;
    /** Acción o parámetros de una fila concreta, por id de hallazgo. */
    byFinding?: Readonly<Record<string, ItemOverride>> | undefined;
  } | undefined;
}

/** Lo que se guarda de la vista previa de un ítem (`curation_fix_items.preview`). */
interface StoredPreview {
  touched: EntityKey[];
  blocked: Blocked | null;
  noop: { coveredBy: number | null } | null;
  collisions: Collision[];
  warnings: string[];
  proposal: ActionProposal | null;
  preconditions: Precondition[];
  hashMaterial?: unknown;
  /** Id pedido que no corresponde a ningún hallazgo (`finding_id` queda NULL). */
  requestedFindingId?: number;
}

export interface FixItemView {
  id: number;
  position: number;
  findingId: number | null;
  finding: {
    id: number; detector: string; signature: string; title: string; entity: EntityRef;
    field: string | null; value: string | null; status: string;
  } | null;
  actionKey: string | null;
  actionLabel: string | null;
  level: number | null;
  params: Record<string, unknown>;
  status: ItemStatus;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  touched: EntityKey[];
  blocked: Blocked | null;
  noop: { coveredBy: number | null } | null;
  collisions: Collision[];
  warnings: string[];
  proposal: ActionProposal | null;
  preconditions: Precondition[];
  runId: number | null;
  undoOfItemId: number | null;
  errorCode: string | null;
  error: string | null;
  appliedAt: string | null;
}

export interface FixBatchView {
  id: number;
  mode: BatchMode;
  filter: Record<string, unknown>;
  actionKey: string | null;
  requestedBy: string;
  appliedBy: string | null;
  note: string | null;
  previewHash: string;
  status: BatchStatus;
  counts: Record<string, unknown>;
  verification: Record<string, unknown> | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  undoOfBatchId: number | null;
  undoneByBatchId: number | null;
  items: FixItemView[];
  pagination: { limit: number; offset: number; total: number };
}

interface BatchRow {
  id: string; mode: BatchMode; filter: Record<string, unknown>; action_key: string | null; requested_by: string; applied_by: string | null;
  note: string | null; preview_hash: string; status: BatchStatus; counts: Record<string, unknown>; verification: Record<string, unknown> | null;
  created_at: Date; started_at: Date | null; finished_at: Date | null; undo_of_batch_id: string | null; undone_by_batch_id: string | null;
}

interface ItemRow {
  id: string; position: number; finding_id: string | null; action_key: string | null; level: number | null;
  params: Record<string, unknown>; preview: StoredPreview; preview_hash: string | null; status: ItemStatus;
  run_id: string | null; undo_of_item_id: string | null; error_code: string | null; error: string | null;
  before: Record<string, unknown> | null; after: Record<string, unknown> | null; applied_at: Date | null;
}

const BATCH_COLUMNS = `id::text, mode, filter, action_key, requested_by, applied_by, note, preview_hash, status, counts, verification,
  created_at, started_at, finished_at, undo_of_batch_id::text, undone_by_batch_id::text`;
const ITEM_COLUMNS = `i.id::text, i.position, i.finding_id::text, i.action_key, i.level, i.params, i.preview, i.preview_hash, i.status,
  i.run_id::text, i.undo_of_item_id::text, i.error_code, i.error, i.before, i.after, i.applied_at`;

const iso = (value: Date | null): string | null => (value === null ? null : new Date(value).toISOString());

// ---------------------------------------------------------------------------
// Hash: lo que la persona vio, en forma canónica.
// ---------------------------------------------------------------------------

/** JSON con las claves ordenadas: el mismo contenido da el mismo hash, venga de donde venga. */
export function stableJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

/** Tal como queda en JSONB: fechas como texto, sin `undefined`. */
function plain<T>(value: T): T {
  return (value === undefined ? null : JSON.parse(JSON.stringify(value))) as T;
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

export interface ItemHashInput {
  findingId: number | null;
  actionKey: string | null;
  level: number | null;
  params: unknown;
  before: unknown;
  after: unknown;
  blocked: string | null;
  noop: boolean;
  material: unknown;
}

/** Hash de un ítem: hallazgo, acción, nivel, parámetros, antes, después, bloqueo y los hechos propios de la acción. */
export function itemHash(input: ItemHashInput): string {
  return sha256(stableJson(plain([
    input.findingId, input.actionKey, input.level, input.params ?? null, input.before ?? null, input.after ?? null,
    input.blocked, input.noop, input.material ?? null,
  ])));
}

// ---------------------------------------------------------------------------
// Vista previa
// ---------------------------------------------------------------------------

interface Candidate {
  order: number;
  requestedId: number;
  finding: FindingRow | null;
  action: AnyFixAction | null;
  params: Record<string, unknown> | null;
  level: ActionLevel | null;
  blocked: Blocked | null;
  chain: { key: string; rank: number } | null;
}

interface PlannedItem {
  position: number;
  finding_id: number | null;
  action_key: string | null;
  level: number | null;
  params: Record<string, unknown>;
  preview: StoredPreview;
  preview_hash: string;
  status: ItemStatus;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  error_code: string | null;
  error: string | null;
  undo_of_item_id: number | null;
}

const blockedBy = (code: BlockedCode, message: string): Blocked => ({ code, message });

function previewContext(client: PoolClient, mode: FixMode): ActionContext {
  return { client, mode: "preview", batchMode: mode, pending: new Map(), names: previewNameLookup(client) };
}

function applyContext(client: PoolClient, mode: FixMode): ActionContext {
  return { client, mode: "apply", batchMode: mode, pending: new Map(), names: liveNameLookup(client) };
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>, begin = "BEGIN"): Promise<T> {
  const client = await getPool().connect();
  try {
    await client.query(begin);
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** Una foto del catálogo para toda la vista previa: los ítems no ven estados distintos. */
const withSnapshot = <T>(work: (client: PoolClient) => Promise<T>): Promise<T> =>
  inTransaction(work, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");

async function resolveCandidate(request: FixPreviewRequest, finding: FindingRow, order: number, ctx: ActionContext): Promise<Candidate> {
  const base: Candidate = { order, requestedId: finding.id, finding, action: null, params: null, level: null, blocked: null, chain: null };
  const override = request.overrides?.byFinding?.[String(finding.id)];
  const explicitKey = override?.actionKey ?? request.actionKey;
  const explicitParams = override?.params ?? request.overrides?.params;
  const offered = applicableActions(finding);
  const action = explicitKey === undefined ? offered[0] : getFixAction(explicitKey);
  if (!action) {
    return {
      ...base,
      blocked: explicitKey === undefined
        ? blockedBy("not_applicable", "el hallazgo no tiene una corrección disponible: hay que editar la ficha")
        : blockedBy("invalid", `acción desconocida: ${explicitKey}`),
    };
  }
  const withAction: Candidate = { ...base, action };
  if (finding.status !== "open") return { ...withAction, blocked: blockedBy("not_open", `el hallazgo ${finding.id} no está abierto`) };

  // El detector la ofrece para este subgrupo, o la acción acepta que se la pida a mano (p. ej. fusionar tras una colisión).
  const declared = offered.includes(action);
  const defaults = declared ? await action.defaultParams(finding, ctx) : null;
  if (defaults === null && explicitParams === undefined) {
    return { ...withAction, blocked: blockedBy("not_applicable", `«${action.label}» no aplica a este hallazgo`) };
  }
  const parsed = action.paramsSchema.safeParse({ ...(defaults ?? {}), ...(explicitParams ?? {}) });
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`).join("; ");
    return { ...withAction, blocked: blockedBy("invalid", `parámetros inválidos para «${action.label}»: ${detail}`) };
  }
  const params = parsed.data;
  if (!declared && !(action.acceptsExplicit?.(finding, params) ?? false)) {
    return { ...withAction, params, blocked: blockedBy("not_applicable", `«${action.label}» no se ofrece para este hallazgo`) };
  }
  const level = action.levelFor(finding, params);
  const chain = action.chain?.(finding, params) ?? null;
  const max = MAX_LEVEL[request.mode];
  if (level > max) {
    return {
      ...withAction, params, level, chain,
      blocked: blockedBy("level", `nivel ${level}: ${MODE_NOUN[request.mode]} solo aplica acciones de nivel ${max} o menos`),
    };
  }
  return { ...withAction, params, level, chain };
}

/** Los ítems encadenados (misma ficha y campo) van juntos, en el orden de su acción; el resto conserva el pedido. */
function chainOrder(candidates: Candidate[]): Candidate[] {
  const chains = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    if (!candidate.chain) continue;
    const list = chains.get(candidate.chain.key);
    if (list) list.push(candidate); else chains.set(candidate.chain.key, [candidate]);
  }
  const ordered: Candidate[] = [];
  const emitted = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.chain) { ordered.push(candidate); continue; }
    if (emitted.has(candidate.chain.key)) continue;
    emitted.add(candidate.chain.key);
    ordered.push(...chains.get(candidate.chain.key)!.sort((a, b) => a.chain!.rank - b.chain!.rank || a.order - b.order));
  }
  return ordered;
}

async function planItem(candidate: Candidate, position: number, ctx: ActionContext): Promise<PlannedItem> {
  const { finding, action, params } = candidate;
  let blocked = candidate.blocked;
  let checks: Precondition[] = [];
  let preview: ActionPreview | null = null;
  if (!blocked && finding && action && params) {
    checks = await action.preconditions(finding, params, ctx);
    const failed = checks.find((check) => !check.ok);
    if (failed) {
      blocked = blockedBy(failed.code ?? "invalid", failed.message ?? `no se cumple «${failed.key}»`);
    } else {
      preview = await action.preview(finding, params, ctx);
      blocked = preview.blocked;
      if (!blocked && preview.noop && preview.noop.coveredBy === null) {
        blocked = blockedBy("noop", "la corrección no cambiaría nada: la ficha ya tiene ese valor");
      }
      // El siguiente ítem sobre la misma ficha y campo parte de lo que deja este.
      if (!blocked && !preview.noop && preview.chain) ctx.pending.set(preview.chain.key, { value: preview.chain.value, findingId: finding.id });
    }
  }
  const stored = plain<StoredPreview>({
    touched: preview?.touched ?? [],
    blocked,
    noop: preview?.noop ?? null,
    collisions: preview?.collisions ?? [],
    warnings: preview?.warnings ?? [],
    proposal: preview?.proposal ?? null,
    preconditions: checks,
    ...(preview?.hashMaterial === undefined ? {} : { hashMaterial: preview.hashMaterial }),
    ...(finding ? {} : { requestedFindingId: candidate.requestedId }),
  });
  const before = preview ? plain(preview.before) : null;
  const after = preview ? plain(preview.after) : null;
  return {
    position,
    finding_id: finding?.id ?? null,
    action_key: action?.key ?? null,
    level: candidate.level,
    params: params ?? {},
    preview: stored,
    preview_hash: itemHash({
      findingId: finding?.id ?? candidate.requestedId, actionKey: action?.key ?? null, level: candidate.level, params,
      before, after, blocked: blocked?.code ?? null, noop: Boolean(preview?.noop), material: preview?.hashMaterial,
    }),
    status: blocked ? "blocked" : "pending",
    before, after,
    error_code: blocked?.code ?? null,
    error: blocked?.message ?? null,
    undo_of_item_id: null,
  };
}

const STATUS_COUNT_KEY: Readonly<Record<ItemStatus, string>> = {
  pending: "pending", blocked: "blocked", excluded: "excluded", applied: "applied",
  skipped_stale: "skippedStale", failed: "failed", undone: "undone", not_undoable: "notUndoable",
};

function countsByStatus(statuses: Iterable<ItemStatus>): Record<string, number> {
  const counts: Record<string, number> = Object.fromEntries(ITEM_STATUSES.map((status) => [STATUS_COUNT_KEY[status], 0]));
  for (const status of statuses) counts[STATUS_COUNT_KEY[status]] = (counts[STATUS_COUNT_KEY[status]] ?? 0) + 1;
  return counts;
}

async function insertItems(client: PoolClient, batchId: number, items: PlannedItem[]): Promise<void> {
  for (let offset = 0; offset < items.length; offset += ITEM_CHUNK) {
    await client.query(`
      INSERT INTO ingest.curation_fix_items
        (batch_id, position, finding_id, action_key, level, params, preview, preview_hash, status, before, after, error_code, error, undo_of_item_id)
      SELECT $1, x.position, x.finding_id, x.action_key, x.level, x.params, x.preview, x.preview_hash, x.status, x.before, x.after, x.error_code, x.error, x.undo_of_item_id
        FROM jsonb_to_recordset($2::jsonb) AS x(position integer, finding_id bigint, action_key text, level smallint, params jsonb, preview jsonb,
             preview_hash text, status text, before jsonb, after jsonb, error_code text, error text, undo_of_item_id bigint)`,
    [batchId, JSON.stringify(items.slice(offset, offset + ITEM_CHUNK).map((item) => ({
      ...item, error_code: item.error_code?.slice(0, 40) ?? null, error: item.error?.slice(0, 2000) ?? null,
    })))]);
  }
}

/**
 * Crea un lote `previewed`: nada se escribe en el catálogo. Individual y
 * selección se piden por ids; un grupo, con el filtro exacto del listado (C3).
 */
export interface ItemPage {
  limit: number;
  offset: number;
  status?: ItemStatus | undefined;
}

const FIRST_PAGE: ItemPage = { limit: DEFAULT_ITEM_PAGE, offset: 0 };

export async function previewFixBatch(
  request: FixPreviewRequest, operator: string, options: { page?: ItemPage; groupLimit?: number } = {},
): Promise<FixBatchView> {
  const previewMax = Math.min(options.groupLimit ?? Number.POSITIVE_INFINITY, getEnv().CRV_CURATION_FIX_PREVIEW_MAX);
  if (request.actionKey !== undefined && !getFixAction(request.actionKey)) {
    throw new CurationError("invalid", `acción desconocida: ${request.actionKey}`);
  }
  if (request.overrides?.params && request.mode !== "individual" && request.actionKey === undefined) {
    throw new CurationError("invalid", "unos parámetros comunes necesitan una acción común (`actionKey`)");
  }

  let filter: Record<string, unknown>;
  let ids: number[] | undefined;
  if (request.mode === "group") {
    if (!request.filter || request.findingIds?.length) throw new CurationError("invalid", "un grupo se pide con el filtro del listado, no con ids");
    filter = { ...request.filter };
  } else {
    if (request.filter) throw new CurationError("invalid", "una corrección individual o una selección se piden con ids, no con un filtro");
    ids = [...new Set(request.findingIds ?? [])];
    if (ids.length === 0) throw new CurationError("invalid", "elige al menos un hallazgo");
    if (request.mode === "individual" && ids.length !== 1) throw new CurationError("invalid", "una corrección individual es de un solo hallazgo");
    if (ids.length > previewMax) throw new CurationError("invalid", `como mucho ${previewMax} hallazgos por lote`);
    filter = { findingIds: ids };
  }

  const planned = await withSnapshot(async (client) => {
    // Hallazgos y catálogo se leen con el mismo snapshot. Si se tomaran antes
    // de abrir la transacción, una vista previa podría mezclar el estado viejo
    // de un hallazgo con el nombre nuevo de su ficha.
    let entries: Array<{ requestedId: number; finding: FindingRow | null }>;
    let matched: number;
    let truncated = false;
    if (request.mode === "group") {
      const selected = await listGroupFindings(request.filter!, previewMax, client);
      entries = selected.rows.map((finding) => ({ requestedId: finding.id, finding }));
      matched = selected.total;
      truncated = selected.total > selected.rows.length;
    } else {
      const byId = new Map((await getFindingsByIds(ids!, client)).map((finding) => [finding.id, finding]));
      entries = ids!.map((id) => ({ requestedId: id, finding: byId.get(id) ?? null }));
      matched = ids!.length;
    }
    const ctx = previewContext(client, request.mode);
    const candidates: Candidate[] = [];
    let notApplicable = 0;
    for (const [order, entry] of entries.entries()) {
      if (!entry.finding) {
        candidates.push({
          order, requestedId: entry.requestedId, finding: null, action: null, params: null, level: null, chain: null,
          blocked: blockedBy("not_found", `hallazgo inexistente: ${entry.requestedId}`),
        });
        continue;
      }
      const candidate = await resolveCandidate(request, entry.finding, order, ctx);
      // Un grupo trae todo lo que cumple el filtro: lo que no tiene corrección se cuenta, no se lista.
      if (request.mode === "group" && candidate.blocked?.code === "not_applicable") { notApplicable += 1; continue; }
      candidates.push(candidate);
    }
    const items: PlannedItem[] = [];
    for (const candidate of chainOrder(candidates)) items.push(await planItem(candidate, items.length, ctx));
    return { items, notApplicable, matched, truncated };
  });

  const byAction: Record<string, number> = {};
  for (const item of planned.items) if (item.action_key) byAction[item.action_key] = (byAction[item.action_key] ?? 0) + 1;
  const counts = {
    matched: planned.matched, notApplicable: planned.notApplicable, truncated: planned.truncated, items: planned.items.length, byAction,
    ...countsByStatus(planned.items.map((item) => item.status)),
  };
  const previewHash = sha256(stableJson(plain([
    request.mode, filter, request.actionKey ?? null,
    planned.items.map((item) => [item.position, item.finding_id, item.action_key, item.status, item.preview_hash]),
  ])));

  const batchId = await inTransaction(async (client) => {
    const created = await client.query<{ id: string }>(`
      INSERT INTO ingest.curation_fix_batches (mode, filter, action_key, requested_by, preview_hash, counts)
      VALUES ($1, $2::jsonb, $3, $4, $5, $6::jsonb) RETURNING id::text`,
    [request.mode, JSON.stringify(filter), request.actionKey ?? null, operator, previewHash, JSON.stringify(counts)]);
    const id = Number(created.rows[0]!.id);
    await insertItems(client, id, planned.items);
    return id;
  });
  return getFixBatch(batchId, options.page ?? FIRST_PAGE);
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

async function loadBatch(batchId: number): Promise<BatchRow> {
  const { rows } = await getPool().query<BatchRow>(`SELECT ${BATCH_COLUMNS} FROM ingest.curation_fix_batches WHERE id = $1`, [batchId]);
  if (!rows[0]) throw new CurationError("not_found", `lote de correcciones inexistente: ${batchId}`);
  return rows[0];
}

type ItemWithFinding = ItemRow & {
  f_detector: string | null; f_signature: string | null; f_title: string | null; f_entity_kind: string | null; f_entity_id: string | null;
  f_entity_label: string | null; f_field: string | null; f_value: string | null; f_status: string | null; total: string;
};

function itemView(row: ItemWithFinding): FixItemView {
  const preview: Partial<StoredPreview> = row.preview ?? {};
  return {
    id: Number(row.id),
    position: row.position,
    findingId: row.finding_id !== null ? Number(row.finding_id) : preview.requestedFindingId ?? null,
    finding: row.finding_id !== null && row.f_detector !== null ? {
      id: Number(row.finding_id), detector: row.f_detector, signature: row.f_signature ?? "", title: row.f_title ?? "",
      entity: { kind: (row.f_entity_kind ?? "") as EntityRef["kind"], id: row.f_entity_id === null ? null : Number(row.f_entity_id), label: row.f_entity_label ?? "" },
      field: row.f_field, value: row.f_value, status: row.f_status ?? "",
    } : null,
    actionKey: row.action_key,
    actionLabel: row.action_key ? getFixAction(row.action_key)?.label ?? null : null,
    level: row.level,
    params: row.params ?? {},
    status: row.status,
    before: row.before,
    after: row.after,
    touched: preview.touched ?? [],
    blocked: preview.blocked ?? null,
    noop: preview.noop ?? null,
    collisions: preview.collisions ?? [],
    warnings: preview.warnings ?? [],
    proposal: preview.proposal ?? null,
    preconditions: preview.preconditions ?? [],
    runId: row.run_id === null ? null : Number(row.run_id),
    undoOfItemId: row.undo_of_item_id === null ? null : Number(row.undo_of_item_id),
    errorCode: row.error_code,
    error: row.error,
    appliedAt: iso(row.applied_at),
  };
}

export async function getFixBatch(batchId: number, page: ItemPage): Promise<FixBatchView> {
  const batch = await loadBatch(batchId);
  const { rows } = await getPool().query<ItemWithFinding>(`
    SELECT ${ITEM_COLUMNS},
           f.detector AS f_detector, f.signature AS f_signature, f.title AS f_title, f.entity_kind AS f_entity_kind,
           f.entity_id::text AS f_entity_id, f.entity_label AS f_entity_label, f.field AS f_field, f.value AS f_value, f.status AS f_status,
           count(*) OVER ()::text AS total
      FROM ingest.curation_fix_items i
      LEFT JOIN ingest.curation_findings f ON f.id = i.finding_id
     WHERE i.batch_id = $1 AND ($2::text IS NULL OR i.status = $2)
     ORDER BY i.position
     LIMIT $3 OFFSET $4`, [batchId, page.status ?? null, page.limit, page.offset]);
  return {
    id: Number(batch.id), mode: batch.mode, filter: batch.filter, actionKey: batch.action_key,
    requestedBy: batch.requested_by, appliedBy: batch.applied_by, note: batch.note, previewHash: batch.preview_hash,
    status: batch.status, counts: batch.counts, verification: batch.verification,
    createdAt: iso(batch.created_at)!, startedAt: iso(batch.started_at), finishedAt: iso(batch.finished_at),
    undoOfBatchId: batch.undo_of_batch_id === null ? null : Number(batch.undo_of_batch_id),
    undoneByBatchId: batch.undone_by_batch_id === null ? null : Number(batch.undone_by_batch_id),
    items: rows.map(itemView),
    pagination: { limit: page.limit, offset: page.offset, total: Number(rows[0]?.total ?? 0) },
  };
}

export interface FindingActionView {
  key: string;
  label: string;
  description: string;
  level: ActionLevel;
  inverse: ActionInverse | null;
  recommended: boolean;
  /** Parámetros por defecto; null = no aplicable a este hallazgo ahora. */
  params: Record<string, unknown> | null;
  preconditions: Precondition[];
  /** Se puede previsualizar y aplicar ya (abierto, con parámetros y precondiciones cumplidas). */
  available: boolean;
}

/** `GET /curation/findings/:id/actions`: las acciones que se ofrecen, con parámetros por defecto, nivel y precondiciones. */
export async function describeFindingActions(findingId: number): Promise<{ findingId: number; status: string; actions: FindingActionView[] }> {
  return withSnapshot(async (client) => {
    const [finding] = await getFindingsByIds([findingId], client);
    if (!finding) throw new CurationError("not_found", `hallazgo inexistente: ${findingId}`);
    const ctx = previewContext(client, "individual");
    const out: FindingActionView[] = [];
    for (const [index, action] of applicableActions(finding).entries()) {
      const params = await action.defaultParams(finding, ctx);
      const preconditions = params && finding.status === "open" ? await action.preconditions(finding, params, ctx) : [];
      out.push({
        key: action.key, label: action.label, description: action.description,
        level: action.levelFor(finding, params), inverse: action.inverse ?? null, recommended: index === 0,
        params: params ? plain(params) : null, preconditions,
        available: finding.status === "open" && params !== null && preconditions.every((check) => check.ok),
      });
    }
    return { findingId, status: finding.status, actions: out };
  });
}

// ---------------------------------------------------------------------------
// Aplicar
// ---------------------------------------------------------------------------

/** Un solo proceso aplica o deshace un lote a la vez (candado de sesión sobre el lote original). */
async function withBatchLock<T>(batchId: number, work: () => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  const key = `crv:curation:fix-batch:${batchId}`;
  let locked = false;
  try {
    const { rows } = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [key]);
    locked = rows[0]?.locked === true;
    if (!locked) throw new CurationError("busy", `el lote ${batchId} se está aplicando o deshaciendo en este momento`);
    return await work();
  } finally {
    let reusable = true;
    if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [key]).catch(() => { reusable = false; });
    client.release(!reusable);
  }
}

/** Candados por ficha, siempre en el mismo orden: dos lotes que tocan lo mismo no se cruzan. */
function lockKeys(touched: readonly EntityKey[]): string[] {
  return [...new Set(touched.map((ref) => `${ref.kind}:${ref.id}`))].sort();
}

async function lockEntities(client: PoolClient, keys: readonly string[]): Promise<void> {
  for (const key of keys) await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`crv:curation:fix:${key}`]);
}

/** Interbloqueo o serialización: se reintenta una vez. */
function isRetryable(error: unknown): boolean {
  const code = (error as { code?: unknown }).code;
  return code === "40P01" || code === "40001";
}

function describeError(error: unknown): { code: string; message: string } {
  if (error instanceof OperatorError || error instanceof CurationError) return { code: error.code, message: error.message };
  const pg = error as { code?: unknown; detail?: unknown; message?: unknown };
  if (typeof pg.code === "string" && /^[0-9A-Z]{5}$/u.test(pg.code)) {
    return { code: `pg_${pg.code}`, message: typeof pg.detail === "string" && pg.detail ? pg.detail : String(pg.message) };
  }
  return { code: "error", message: error instanceof Error ? error.message : String(error) };
}

class StaleItem extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

async function markItem(itemId: number | string, status: ItemStatus, code: string | null, message: string | null): Promise<ItemStatus> {
  await getPool().query("UPDATE ingest.curation_fix_items SET status = $2, error_code = $3, error = $4 WHERE id = $1",
    [itemId, status, code?.slice(0, 40) ?? null, message?.slice(0, 2000) ?? null]);
  return status;
}

/** Recalcula la vista previa de un ítem dentro de la transacción que va a escribir. */
async function recompute(action: AnyFixAction, finding: FindingRow, params: Record<string, unknown>, ctx: ActionContext) {
  const checks = await action.preconditions(finding, params, ctx);
  const failed = checks.find((check) => !check.ok);
  if (failed) return { preview: null, hash: null, blocked: blockedBy(failed.code ?? "invalid", failed.message ?? `no se cumple «${failed.key}»`) };
  const preview = await action.preview(finding, params, ctx);
  const hash = itemHash({
    findingId: finding.id, actionKey: action.key, level: action.levelFor(finding, params), params,
    before: preview.before, after: preview.after, blocked: preview.blocked?.code ?? null, noop: Boolean(preview.noop), material: preview.hashMaterial,
  });
  return { preview, hash, blocked: preview.blocked };
}

/**
 * «409 si el hash cambió»: vuelve a planificar lo pendiente, en su orden y con
 * el mismo encadenado que la vista previa, sobre una foto nueva del catálogo.
 * Devuelve los ítems no excluidos cuyo hash ya no es el guardado.
 */
async function changedSincePreview(batch: BatchRow, items: readonly ItemRow[], excluded: ReadonlySet<number>): Promise<number[]> {
  return withSnapshot(async (client) => {
    const findings = new Map((await getFindingsByIds(
      items.flatMap((item) => (item.finding_id === null ? [] : [Number(item.finding_id)])), client,
    )).map((finding) => [finding.id, finding]));
    const ctx = previewContext(client, batch.mode as FixMode);
    const changed: number[] = [];
    for (const item of items) {
      const id = Number(item.id);
      const finding = item.finding_id === null ? undefined : findings.get(Number(item.finding_id));
      const action = item.action_key ? getFixAction(item.action_key) : undefined;
      const parsed = action?.paramsSchema.safeParse(item.params);
      if (!finding || !action || !parsed?.success) {
        if (!excluded.has(id)) changed.push(id);
        continue;
      }
      const params = parsed.data;
      // Los excluidos también se planifican: el ítem siguiente de su cadena partió de lo que ellos dejaban.
      const planned = await planItem({
        order: item.position, requestedId: finding.id, finding, action, params,
        level: action.levelFor(finding, params), chain: action.chain?.(finding, params) ?? null,
        blocked: finding.status === "open" ? null : blockedBy("not_open", `el hallazgo ${finding.id} ya no está abierto`),
      }, item.position, ctx);
      if (planned.preview_hash !== item.preview_hash && !excluded.has(id)) changed.push(id);
    }
    return changed;
  });
}

async function applyItem(batch: BatchRow, item: ItemRow, finding: FindingRow | undefined, operator: string, note: string): Promise<ItemStatus> {
  const action = item.action_key ? getFixAction(item.action_key) : undefined;
  if (!action) return markItem(item.id, "failed", "invalid", `acción desconocida: ${item.action_key ?? "(ninguna)"}`);
  if (!finding) return markItem(item.id, "skipped_stale", "not_found", "el hallazgo ya no existe");
  if (finding.status !== "open") return markItem(item.id, "skipped_stale", "not_open", `el hallazgo ${finding.id} ya no está abierto`);
  const parsed = action.paramsSchema.safeParse(item.params);
  if (!parsed.success) return markItem(item.id, "failed", "invalid", "los parámetros guardados ya no son válidos para la acción");
  const params = parsed.data;
  const mode = batch.mode as FixMode;
  const keys = lockKeys(item.preview.touched ?? []);
  if (item.preview.noop) return applyCovered(batch, item, action, finding, params, keys);

  for (let attempt = 1; ; attempt += 1) {
    try {
      await withOperatorRun({
        name: `api:curation:fix:${action.key}`, operator, note,
        params: { batchId: Number(batch.id), itemId: Number(item.id), findingId: finding.id, actionKey: action.key },
      }, async (context) => {
        await lockEntities(context.client, keys);
        const currentFinding = await getFindingForUpdate(finding.id, context.client);
        if (!currentFinding) throw new StaleItem("not_found", "el hallazgo ya no existe");
        if (currentFinding.status !== "open") throw new StaleItem("not_open", `el hallazgo ${currentFinding.id} ya no está abierto`);
        const fresh = await recompute(action, currentFinding, params, applyContext(context.client, mode));
        if (fresh.blocked) throw new StaleItem(fresh.blocked.code === "stale" ? "stale" : fresh.blocked.code, fresh.blocked.message);
        if (fresh.hash !== item.preview_hash) throw new StaleItem("stale", "la ficha cambió desde la vista previa");
        const outcome = await action.apply(context, currentFinding, params, fresh.preview!);
        await context.client.query(`
          UPDATE ingest.curation_fix_items
             SET status = 'applied', run_id = $2, before = $3::jsonb, after = $4::jsonb, applied_at = now(), error_code = NULL, error = NULL
           WHERE id = $1`,
        [item.id, context.runId, JSON.stringify(plain(fresh.preview!.before)), JSON.stringify(plain({ ...fresh.preview!.after, ...outcome.after }))]);
      });
      return "applied";
    } catch (error) {
      if (error instanceof StaleItem) return markItem(item.id, "skipped_stale", error.code, error.message);
      if (isRetryable(error) && attempt < 2) continue;
      const { code, message } = describeError(error);
      // La fusión recalcula su propia vista previa bajo candado: si cambió, es obsolescencia, no un fallo.
      if (code === "stale_preview" || code === "stale") return markItem(item.id, "skipped_stale", code, message);
      log.warn({ err: error, batchId: batch.id, itemId: item.id, action: action.key }, "falló un ítem del lote de correcciones");
      return markItem(item.id, "failed", code, message);
    }
  }
}

/**
 * Ítem cubierto por uno anterior del lote (dos limpiezas sobre el mismo
 * nombre): no escribe nada. Si el que lo cubría se aplicó y el valor vivo sigue
 * siendo el prometido, queda aplicado con el run de ese ítem (su corrección).
 */
async function applyCovered(
  batch: BatchRow, item: ItemRow, action: AnyFixAction, finding: FindingRow, params: Record<string, unknown>, keys: string[],
): Promise<ItemStatus> {
  const coveredBy = item.preview.noop?.coveredBy ?? null;
  const cover = coveredBy === null ? undefined : (await getPool().query<{ status: ItemStatus; run_id: string | null }>(`
    SELECT status, run_id::text FROM ingest.curation_fix_items
     WHERE batch_id = $1 AND finding_id = $2 AND position < $3 ORDER BY position DESC LIMIT 1`, [batch.id, coveredBy, item.position])).rows[0];
  if (!cover || cover.status !== "applied" || cover.run_id === null) {
    return markItem(item.id, "skipped_stale", "stale", "no se aplicó la corrección anterior del lote que también resolvía este hallazgo");
  }
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    await lockEntities(client, keys);
    const currentFinding = await getFindingForUpdate(finding.id, client);
    if (!currentFinding) {
      await client.query("ROLLBACK");
      return markItem(item.id, "skipped_stale", "not_found", "el hallazgo ya no existe");
    }
    if (currentFinding.status !== "open") {
      await client.query("ROLLBACK");
      return markItem(item.id, "skipped_stale", "not_open", `el hallazgo ${currentFinding.id} ya no está abierto`);
    }
    const fresh = await recompute(action, currentFinding, params, applyContext(client, batch.mode as FixMode));
    if (fresh.blocked || fresh.hash !== item.preview_hash || !fresh.preview?.noop) {
      await client.query("ROLLBACK");
      return markItem(item.id, "skipped_stale", "stale", "la ficha cambió desde la vista previa");
    }
    await client.query(`
      UPDATE ingest.curation_fix_items
         SET status = 'applied', run_id = $2, before = $3::jsonb, after = $4::jsonb, applied_at = now(), error_code = NULL, error = NULL
       WHERE id = $1`, [item.id, cover.run_id, JSON.stringify(plain(fresh.preview.before)), JSON.stringify(plain(fresh.preview.after))]);
    await client.query("COMMIT");
    return "applied";
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    const { code, message } = describeError(error);
    log.warn({ err: error, batchId: batch.id, itemId: item.id }, "falló un ítem cubierto del lote de correcciones");
    return markItem(item.id, "failed", code, message);
  } finally {
    client.release();
  }
}

async function itemCounts(batchId: number | string): Promise<Record<ItemStatus, number>> {
  const { rows } = await getPool().query<{ status: ItemStatus; n: number }>(
    "SELECT status, count(*)::int AS n FROM ingest.curation_fix_items WHERE batch_id = $1 GROUP BY status", [batchId]);
  const counts = Object.fromEntries(ITEM_STATUSES.map((status) => [status, 0])) as Record<ItemStatus, number>;
  for (const row of rows) counts[row.status] = row.n;
  return counts;
}

const camelCounts = (counts: Record<ItemStatus, number>): Record<string, number> =>
  Object.fromEntries(ITEM_STATUSES.map((status) => [STATUS_COUNT_KEY[status], counts[status]]));

/** Estado del lote según sus ítems: queda `running` mientras haya pendientes (continuación explícita). */
async function settleBatch(batchId: number | string): Promise<BatchStatus> {
  const counts = await itemCounts(batchId);
  let status: BatchStatus;
  if (counts.pending > 0) {
    status = "running";
  } else {
    const done = counts.applied + counts.undone + counts.not_undoable;
    const problems = counts.skipped_stale + counts.failed;
    status = problems === 0 ? "done" : done === 0 ? "failed" : "partial";
  }
  await getPool().query(`
    UPDATE ingest.curation_fix_batches
       SET status = $2::text, counts = counts || $3::jsonb, finished_at = CASE WHEN $2::text = 'running' THEN NULL ELSE now() END
     WHERE id = $1`, [batchId, status, JSON.stringify(camelCounts(counts))]);
  return status;
}

export interface ApplyFixInput {
  previewHash: string;
  excludeItemIds?: readonly number[] | undefined;
  note: string;
}

/** Ítems cambiados que un 409 enumera (el recuento va siempre completo). */
const CHANGED_LIST_MAX = 500;

/**
 * Aplica un lote previsualizado (o continúa uno a medias). Un hash que no es el
 * de la vista previa, o una vista previa que ya no da lo mismo, → `stale_preview`
 * sin tocar nada. `recheck: false` solo para los alias obsoletos, que
 * previsualizan y aplican en la misma llamada: nadie vio esa vista previa.
 */
export async function applyFixBatch(
  batchId: number, input: ApplyFixInput, operator: string, page: ItemPage = FIRST_PAGE, options: { recheck?: boolean } = {},
): Promise<FixBatchView> {
  const note = input.note.trim();
  if (!note) throw new CurationError("invalid", "nota obligatoria");
  await withBatchLock(batchId, async () => {
    const batch = await loadBatch(batchId);
    if (batch.mode === "undo") throw new CurationError("not_open", "un lote de deshacer no se aplica");
    if (batch.status !== "previewed" && batch.status !== "running") {
      throw new CurationError("not_open", `el lote ${batchId} ya no se puede aplicar (estado: ${batch.status})`);
    }
    if (batch.preview_hash !== input.previewHash) {
      throw new CurationError("stale_preview", "el hash no es el de la vista previa de este lote: vuelve a previsualizar");
    }
    const excluded = new Set(input.excludeItemIds ?? []);
    const { rows: pending } = await getPool().query<ItemRow>(`
      SELECT ${ITEM_COLUMNS} FROM ingest.curation_fix_items i WHERE i.batch_id = $1 AND i.status = 'pending' ORDER BY i.position`, [batchId]);
    if (pending.every((item) => excluded.has(Number(item.id)))) {
      throw new CurationError("not_fixable", "el lote no tiene nada que aplicar: todos sus ítems están bloqueados, excluidos o ya se aplicaron");
    }
    if (batch.status === "previewed" && options.recheck !== false) {
      const changed = await changedSincePreview(batch, pending, excluded);
      if (changed.length) {
        throw new CurationError("stale_preview",
          `${changed.length === 1 ? "1 corrección cambió" : `${changed.length} correcciones cambiaron`} desde la vista previa: vuelve a previsualizar o exclúyelas`,
          { changed: changed.length, changedItemIds: changed.slice(0, CHANGED_LIST_MAX) });
      }
    }

    await getPool().query(`
      UPDATE ingest.curation_fix_batches
         SET status = 'running', started_at = coalesce(started_at, now()), applied_by = coalesce(applied_by, $2), note = coalesce(note, $3)
       WHERE id = $1`, [batchId, operator, note]);
    if (excluded.size) {
      await getPool().query(`
        UPDATE ingest.curation_fix_items SET status = 'excluded', error_code = 'excluded', error = 'excluido al aplicar'
         WHERE batch_id = $1 AND id = ANY($2::bigint[]) AND status = 'pending'`, [batchId, [...excluded]]);
    }

    const { rows: items } = await getPool().query<ItemRow>(`
      SELECT ${ITEM_COLUMNS} FROM ingest.curation_fix_items i
       WHERE i.batch_id = $1 AND i.status = 'pending' ORDER BY i.position LIMIT $2`, [batchId, getEnv().CRV_CURATION_FIX_BATCH_MAX]);
    const findings = new Map((await getFindingsByIds(items.flatMap((item) => (item.finding_id === null ? [] : [Number(item.finding_id)]))))
      .map((finding) => [finding.id, finding]));
    const applied: number[] = [];
    for (const item of items) {
      const finding = item.finding_id === null ? undefined : findings.get(Number(item.finding_id));
      if (await applyItem(batch, item, finding, operator, note) === "applied") applied.push(Number(item.id));
    }
    await settleBatch(batchId);
    scheduleVerification(batchId, applied, operator);
  });
  return getFixBatch(batchId, page);
}

// ---------------------------------------------------------------------------
// Verificación dirigida (E4.6)
// ---------------------------------------------------------------------------

/** Fichas del foco: las que tocaron los ítems y las de sus hallazgos (la propia y las relacionadas). */
async function focusOf(itemIds: readonly number[]): Promise<Array<{ kind: string; id: number }>> {
  const { rows } = await getPool().query<{ touched: EntityKey[] | null; entity_kind: string | null; entity_id: string | null; related: EntityRef[] | null }>(`
    SELECT i.preview->'touched' AS touched, f.entity_kind, f.entity_id::text, f.related
      FROM ingest.curation_fix_items i LEFT JOIN ingest.curation_findings f ON f.id = i.finding_id
     WHERE i.id = ANY($1::bigint[])`, [itemIds]);
  const focus = new Map<string, { kind: string; id: number }>();
  const add = (kind: string | null | undefined, id: number | string | null | undefined) => {
    if (!kind || id === null || id === undefined || !Number.isSafeInteger(Number(id))) return;
    focus.set(`${kind}:${id}`, { kind, id: Number(id) });
  };
  for (const row of rows) {
    for (const ref of row.touched ?? []) add(ref.kind, ref.id);
    add(row.entity_kind, row.entity_id);
    for (const ref of row.related ?? []) add(ref.kind, ref.id);
  }
  return [...focus.values()];
}

interface Verification {
  status: "running" | "done" | "skipped" | "failed";
  scans: Array<{ scanId: number | null; status: string; at: string; durationMs: number; focus: number; error?: string }>;
  resolvedCount: number;
  fixedByCuration: number;
  appearedCount: number;
  triggeredCount: number;
  resolved: Array<ResolvedRef & { resolution: string }>;
  appeared: ResolvedRef[];
  triggered: ResolvedRef[];
}

/** Devuelve si la verificación quedó guardada. */
async function verifyBatch(batchId: number, itemIds: readonly number[], requestedBy: string): Promise<boolean> {
  const focus = await focusOf(itemIds);
  if (!focus.length) return true;
  await getPool().query(`
    UPDATE ingest.curation_fix_batches SET verification = coalesce(verification, '{}'::jsonb) || '{"status": "running"}'::jsonb WHERE id = $1`, [batchId]);
  const summary = await runCurationScan({ trigger: "correccion", requestedBy: requestedBy || null, detail: `lote de correcciones ${batchId}`, focus });
  const details = summary.details ?? { resolved: [], appeared: [], triggered: [] };
  const saved = summary.status === "ok" || summary.status === "partial";
  await inTransaction(async (client) => {
    const { rows } = await client.query<{ verification: Partial<Verification> | null }>(
      "SELECT verification FROM ingest.curation_fix_batches WHERE id = $1 FOR UPDATE", [batchId]);
    const previous = rows[0]?.verification ?? {};
    const next: Verification = {
      status: saved ? "done" : summary.status === "skipped" ? "skipped" : "failed",
      scans: [...(previous.scans ?? []), {
        scanId: summary.scanId, status: summary.status, at: new Date().toISOString(), durationMs: summary.durationMs, focus: focus.length,
        ...(summary.error ? { error: summary.error } : {}),
      }],
      resolvedCount: (previous.resolvedCount ?? 0) + details.resolved.length,
      fixedByCuration: (previous.fixedByCuration ?? 0) + details.resolved.filter((ref) => ref.resolution === "fixed_by_curation").length,
      appearedCount: (previous.appearedCount ?? 0) + details.appeared.length,
      triggeredCount: (previous.triggeredCount ?? 0) + details.triggered.length,
      resolved: [...(previous.resolved ?? []), ...details.resolved].slice(0, VERIFICATION_LIST_MAX),
      appeared: [...(previous.appeared ?? []), ...details.appeared].slice(0, VERIFICATION_LIST_MAX),
      triggered: [...(previous.triggered ?? []), ...details.triggered].slice(0, VERIFICATION_LIST_MAX),
    };
    await client.query("UPDATE ingest.curation_fix_batches SET verification = $2::jsonb WHERE id = $1", [batchId, JSON.stringify(next)]);
  });
  return saved;
}

/**
 * La verificación no retrasa la respuesta: corre detrás y el lote la muestra al
 * terminar. Si no se pudo (otro proceso analizaba demasiado rato, la base
 * falló), el análisis completo de siempre la cubre: los hallazgos corregidos se
 * resuelven igual con el run de su ítem.
 */
function scheduleVerification(batchId: number, itemIds: readonly number[], requestedBy: string): void {
  if (!itemIds.length) return;
  const fallback = () => notifyCatalogWrite(requestedBy || null, `lote de correcciones ${batchId}`);
  void trackCurationWork(verifyBatch(batchId, itemIds, requestedBy).then((verified) => {
    if (!verified) fallback();
  }, (error: unknown) => {
    log.error({ err: error, batchId }, "no se pudo verificar el lote de correcciones");
    fallback();
  }));
}

// ---------------------------------------------------------------------------
// Deshacer (E4.5)
// ---------------------------------------------------------------------------

type Inverse = (context: OperatorContext, runId: number) => Promise<unknown>;

const INVERSES: Readonly<Record<ActionInverse, Inverse | null>> = {
  field_restore: (context, runId) => undoFieldCorrections(context, runId),
  merge_undo: (context, runId) => undoMergeRun(context, runId),
  relation_delete: (context, runId) => undoRelationCreation(context, runId),
  entity_restore: (context, runId) => undoEntityRemoval(context, runId),
};

/** El CAS inverso o la precondición de la inversa no se cumplen: deshacer pisaría algo posterior. */
const UNDO_REFUSED = new Set(["not_open", "invalid", "not_found", "already_exists"]);
/** O el catálogo ya no admite lo que había (otro artista tomó el nombre, una ficha referida ya no está). */
const UNDO_CONSTRAINTS = new Set(["23505", "23503", "23514", "23502"]);

async function createUndoBatch(original: BatchRow, operator: string, note: string): Promise<number | null> {
  const { rows } = await getPool().query<ItemRow>(`
    SELECT ${ITEM_COLUMNS} FROM ingest.curation_fix_items i WHERE i.batch_id = $1 AND i.status = 'applied' ORDER BY i.position DESC`, [original.id]);
  if (!rows.length) return null;
  // Un deshacer por run: una limpieza cubierta por otra del lote comparte su run.
  const groups = new Map<string, ItemRow[]>();
  for (const row of rows) {
    const key = row.run_id ?? `item:${row.id}`;
    const list = groups.get(key);
    if (list) list.push(row); else groups.set(key, [row]);
  }
  const items: PlannedItem[] = [...groups.values()].map((group, position) => {
    const main = group.find((row) => !row.preview?.noop) ?? group[group.length - 1]!;
    const runId = main.run_id === null ? null : Number(main.run_id);
    const itemIds = group.map((row) => Number(row.id));
    const touched = [...new Map(group.flatMap((row) => row.preview?.touched ?? []).map((ref) => [`${ref.kind}:${ref.id}`, ref])).values()];
    return {
      position,
      finding_id: main.finding_id === null ? null : Number(main.finding_id),
      action_key: main.action_key,
      level: main.level,
      params: { runId, itemIds },
      preview: { touched, blocked: null, noop: null, collisions: [], warnings: [], proposal: null, preconditions: [] },
      preview_hash: sha256(stableJson(["undo", Number(main.id), runId, itemIds])),
      status: "pending",
      // Deshacer deja lo que había antes de la corrección.
      before: main.after,
      after: main.before,
      error_code: null,
      error: null,
      undo_of_item_id: Number(main.id),
    };
  });
  return inTransaction(async (client) => {
    const created = await client.query<{ id: string }>(`
      INSERT INTO ingest.curation_fix_batches
        (mode, filter, action_key, requested_by, applied_by, note, preview_hash, status, started_at, undo_of_batch_id, counts)
      VALUES ('undo', $1::jsonb, $2, $3, $3, $4, $5, 'running', now(), $6, $7::jsonb) RETURNING id::text`,
    [JSON.stringify({ undoOfBatchId: Number(original.id) }), original.action_key, operator, note,
      sha256(stableJson(["undo", Number(original.id), items.map((item) => item.preview_hash)])), original.id,
      JSON.stringify({ items: items.length, ...countsByStatus(items.map((item) => item.status)) })]);
    const undoId = Number(created.rows[0]!.id);
    await insertItems(client, undoId, items);
    await client.query("UPDATE ingest.curation_fix_batches SET undone_by_batch_id = $2 WHERE id = $1", [original.id, undoId]);
    return undoId;
  });
}

async function markOriginals(itemIds: readonly number[], status: ItemStatus, code: string | null, message: string | null): Promise<void> {
  await getPool().query(`
    UPDATE ingest.curation_fix_items SET status = $2, error_code = $3, error = $4 WHERE id = ANY($1::bigint[]) AND status = 'applied'`,
  [itemIds, status, code?.slice(0, 40) ?? null, message?.slice(0, 2000) ?? null]);
}

/** Revierte un ítem de deshacer (un run); devuelve los ítems originales que quedaron deshechos. */
async function undoItem(original: BatchRow, undoId: number, item: ItemRow, operator: string, note: string): Promise<number[]> {
  const runId = typeof item.params["runId"] === "number" ? item.params["runId"] : null;
  const originals = Array.isArray(item.params["itemIds"]) ? item.params["itemIds"].filter((id): id is number => typeof id === "number") : [];
  const action = item.action_key ? getFixAction(item.action_key) : undefined;
  const inverse = action?.inverse ? INVERSES[action.inverse] : null;
  if (runId === null || !action || !inverse) {
    const message = runId === null
      ? "la corrección ya no conserva su run: no se puede deshacer"
      : `«${action?.label ?? item.action_key ?? "?"}» todavía no sabe deshacerse`;
    await markItem(item.id, "skipped_stale", "not_undoable", message);
    await markOriginals(originals, "not_undoable", "not_undoable", message);
    return [];
  }
  for (let attempt = 1; ; attempt += 1) {
    try {
      await withOperatorRun({
        name: `${CURATION_UNDO_RUN_PREFIX}${action.key}`, operator, note,
        params: { batchId: undoId, undoOfBatchId: Number(original.id), itemId: Number(item.id), undoesRunId: runId },
      }, async (context) => {
        await lockEntities(context.client, lockKeys(item.preview?.touched ?? []));
        const result = await inverse(context, runId);
        await context.client.query(`
          UPDATE ingest.curation_fix_items
             SET status = 'applied', run_id = $2, after = $3::jsonb, applied_at = now(), error_code = NULL, error = NULL
           WHERE id = $1`, [item.id, context.runId, JSON.stringify(plain({ ...(item.after ?? {}), undo: result }))]);
        await context.client.query(`
          UPDATE ingest.curation_fix_items SET status = 'undone', error_code = NULL, error = NULL
           WHERE id = ANY($1::bigint[]) AND status = 'applied'`, [originals]);
      });
      return originals;
    } catch (error) {
      if (isRetryable(error) && attempt < 2) continue;
      const { code, message } = describeError(error);
      const pgCode = (error as { code?: unknown }).code;
      if ((error instanceof OperatorError && UNDO_REFUSED.has(error.code)) || (typeof pgCode === "string" && UNDO_CONSTRAINTS.has(pgCode))) {
        await markItem(item.id, "skipped_stale", code, message);
        await markOriginals(originals, "not_undoable", code, message);
      } else {
        log.warn({ err: error, batchId: undoId, itemId: item.id }, "falló un ítem al deshacer un lote de correcciones");
        await markItem(item.id, "failed", code, message);
      }
      return [];
    }
  }
}

/**
 * Deshace lo aplicado de un lote, en orden inverso, como un lote nuevo
 * (`mode = 'undo'`). Lo que ya no se puede deshacer sin pisar un cambio
 * posterior queda `not_undoable` con el motivo. Hasta
 * `CRV_CURATION_FIX_BATCH_MAX` correcciones por llamada; otra llamada sigue.
 */
export async function undoFixBatch(batchId: number, input: { note: string }, operator: string, page: ItemPage = FIRST_PAGE): Promise<FixBatchView> {
  const note = input.note.trim();
  if (!note) throw new CurationError("invalid", "nota obligatoria");
  const undoId = await withBatchLock(batchId, async () => {
    const original = await loadBatch(batchId);
    if (original.mode === "undo") throw new CurationError("not_open", "un deshacer no se deshace: vuelve a previsualizar la corrección");
    if (original.status === "previewed") throw new CurationError("not_open", "el lote no se aplicó: no hay nada que deshacer");
    if (original.status === "undone") throw new CurationError("not_open", "el lote ya se deshizo");

    // Lo que quedaba pendiente ya no se aplicará: el lote se está deshaciendo.
    const leftover = await getPool().query(`
      UPDATE ingest.curation_fix_items SET status = 'excluded', error_code = 'undone_batch', error = 'el lote se deshizo antes de aplicar este ítem'
       WHERE batch_id = $1 AND status = 'pending'`, [batchId]);
    if (leftover.rowCount) await settleBatch(batchId);

    // Un deshacer a medias sigue; si no, uno nuevo con lo aplicado que queda.
    let undoing = original.undone_by_batch_id === null ? null : await loadBatch(Number(original.undone_by_batch_id));
    if (undoing?.status !== "running") {
      const created = await createUndoBatch(original, operator, note);
      if (created === null) throw new CurationError("not_fixable", "el lote no tiene correcciones aplicadas que deshacer");
      undoing = await loadBatch(created);
    }
    const currentUndoId = Number(undoing.id);
    const { rows: items } = await getPool().query<ItemRow>(`
      SELECT ${ITEM_COLUMNS} FROM ingest.curation_fix_items i
       WHERE i.batch_id = $1 AND i.status = 'pending' ORDER BY i.position LIMIT $2`, [currentUndoId, getEnv().CRV_CURATION_FIX_BATCH_MAX]);
    const undone: number[] = [];
    for (const item of items) undone.push(...await undoItem(original, currentUndoId, item, operator, note));

    await settleBatch(currentUndoId);
    const counts = await itemCounts(batchId);
    const fullyUndone = counts.pending === 0 && counts.applied === 0 && counts.not_undoable === 0 && counts.undone > 0;
    await getPool().query(`
      UPDATE ingest.curation_fix_batches
         SET counts = counts || $2::jsonb, status = CASE WHEN $3::boolean THEN 'undone' ELSE status END
       WHERE id = $1`, [batchId, JSON.stringify(camelCounts(counts)), fullyUndone]);
    scheduleVerification(currentUndoId, undone, operator);
    return currentUndoId;
  });
  return getFixBatch(undoId, page);
}

// ---------------------------------------------------------------------------
// Alias obsoletos (E3 → E4): corregir en una sola llamada.
// ---------------------------------------------------------------------------

/**
 * Vista previa y aplicación en una llamada, con todos los ítems: lo usan
 * `fix`, `fix-selected` y `fix-group` mientras la web no pase por el marco (E8).
 */
export async function fixWithoutReview(
  request: FixPreviewRequest, operator: string, note: string,
): Promise<{ batch: FixBatchView; items: FixItemView[] }> {
  // Un grupo de E3 corregía hasta 500 por llamada: la vista previa no trae más de lo que se aplica de una vez.
  const preview = await previewFixBatch(request, operator, { groupLimit: getEnv().CRV_CURATION_FIX_BATCH_MAX });
  const pending = typeof preview.counts["pending"] === "number" ? preview.counts["pending"] : 0;
  if (pending > 0) await applyFixBatch(preview.id, { previewHash: preview.previewHash, note }, operator, FIRST_PAGE, { recheck: false });
  const all = await getFixBatch(preview.id, { limit: getEnv().CRV_CURATION_FIX_PREVIEW_MAX, offset: 0 });
  return { batch: all, items: all.items };
}
