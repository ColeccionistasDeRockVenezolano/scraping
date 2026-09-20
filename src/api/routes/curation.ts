// CRV · Curaduría: detector de conflictos en la API.
//
// Lecturas solo para administradores (ADMIN_READS en auth.ts). Las decisiones
// —analizar ahora, ignorar, reabrir— son escrituras y pasan la misma guarda de
// sesión admin + CSRF que el resto.
//
// VERIFICACIÓN DE CORRECCIONES: `registerCurationRoutes` engancha un
// `onResponse` que, ante cualquier escritura correcta del catálogo, pide un
// análisis (src/curation/watcher.ts). El análisis marca los hallazgos que
// nacen donde otro acaba de resolverse, así la web muestra si una corrección
// desencadenó errores nuevos. Qué es «escritura del catálogo» lo dice una
// lista explícita (`CATALOG_WRITES`), no una lista de exclusión.
//
// CORREGIR vive en el marco de acciones (curation-actions.ts, PLAN_CURADURIA
// E4): lotes con vista previa, aplicación, verificación dirigida y deshacer.
// `fix`, `fix-selected` y `fix-group` quedan como alias obsoletos sobre ese
// marco durante una versión, con la forma de respuesta de E3.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getEnv } from "../../config/env.js";
import { ApiError, notFound } from "../http-errors.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, writeErrorResponses } from "../schemas.js";
import { fixWithoutReview, type FixItemView } from "../../curation/actions/batches.js";
import { resolveConflictFinding, resolveConflictsGroupByTrust } from "../../curation/conflicts.js";
import {
  CurationError, DISTINCT_PAIR_KINDS, IGNORE_REASONS, acknowledgeChain, acknowledgeChainGroup, declareDistinctPair,
  getCurationSummary, getFinding, ignoreFinding, ignoreGroup, listDistinctPairs, listFindings, listScans, removeDistinctPair, reopenFinding,
} from "../../curation/repository.js";
import { autofixSummary } from "../../curation/autofix.js";
import { getCurationMetrics } from "../../curation/metrics.js";
import { isCurationScanRunning, runCurationScan } from "../../curation/scan.js";
import type { FocusRef } from "../../curation/snapshot.js";
import type { FindingEntityKind } from "../../curation/types.js";
import { flushCurationWork, notifyCatalogWrite } from "../../curation/watcher.js";

const severitySchema = z.enum(["high", "medium", "low"]);
const entityRefSchema = z.object({ kind: z.string(), id: z.number().int().nullable(), label: z.string() });

const scanSchema = z.object({
  id: z.number().int(), status: z.string(), scope: z.string(), trigger: z.string(), requestedBy: z.string().nullable(),
  startedAt: z.string(), finishedAt: z.string().nullable(), error: z.string().nullable(), counters: z.record(z.unknown()),
});

/** Autocorrección en el panorama (PLAN_CURADURIA E10.4): lo de hoy y los avisos. */
const autofixSummarySchema = z.object({
  enabled: z.boolean(),
  rules: z.object({ total: z.number().int(), active: z.number().int() }),
  today: z.object({ batches: z.number().int(), applied: z.number().int(), undone: z.number().int() }),
  alerts: z.array(z.object({
    ruleId: z.number().int().nullable(), detector: z.string(), signature: z.string().nullable(), actionKey: z.string(),
    reason: z.string(), batchId: z.number().int().nullable(), at: z.string(),
  })),
});

const metricsSchema = z.object({
  detectors: z.array(z.object({
    detector: z.string(), label: z.string(), reviewed: z.number().int(), confirmed: z.number().int(), rejected: z.number().int(),
    falsePositives: z.number().int(), intentional: z.number().int(), observedPrecision: z.number().nullable(),
    meanCorrectionSeconds: z.number().nullable(),
  })),
  meanCorrectionSeconds: z.number().nullable(),
  actionCoverage: z.object({
    open: z.number().int(), excludedInformational: z.number().int(),
    level1OrLess: z.number().int(), level2OrLess: z.number().int(),
    level1OrLessPct: z.number().nullable(), level2OrLessPct: z.number().nullable(),
  }),
  batches: z.object({
    total: z.number().int(), previewed: z.number().int(), applied: z.number().int(), undone: z.number().int(),
    autoApplied: z.number().int(), autoReverted: z.number().int(),
  }),
  alerts: z.array(z.object({
    detector: z.string(), label: z.string(), precision: z.number(), reviewed: z.number().int(),
    threshold: z.number(), minimumReviewed: z.number().int(),
  })),
});

const summarySchema = z.object({
  lastScan: scanSchema.nullable(),
  lastCorrection: scanSchema.nullable(),
  running: z.boolean(),
  autofix: autofixSummarySchema,
  metrics: metricsSchema,
  totals: z.object({ open: z.number(), ignored: z.number(), resolved: z.number(), newInLastScan: z.number(), chainedOpen: z.number() }),
  categories: z.array(z.object({
    key: z.string(), label: z.string(), description: z.string(),
    open: z.number(), ignored: z.number(), resolved: z.number(), newInLastScan: z.number(), chainedOpen: z.number(),
    severity: z.object({ high: z.number(), medium: z.number(), low: z.number() }),
    detectors: z.array(z.object({
      key: z.string(), label: z.string(), description: z.string(),
      open: z.number(), ignored: z.number(), resolved: z.number(), newInLastScan: z.number(),
      signatures: z.array(z.object({ key: z.string(), label: z.string(), open: z.number() })),
      actions: z.record(z.array(z.string())).optional(),
    })),
  })),
});

const findingSchema = z.object({
  id: z.number().int(), category: z.string(), detector: z.string(), detectorLabel: z.string(),
  signature: z.string(), signatureLabel: z.string(), severity: severitySchema,
  entity: entityRefSchema, field: z.string().nullable(), value: z.string().nullable(),
  title: z.string(), suggestion: z.string().nullable(), suggestedValue: z.string().nullable(),
  related: z.array(entityRefSchema), evidence: z.record(z.unknown()),
  status: z.enum(["open", "ignored", "resolved"]), isNew: z.boolean(),
  triggeredBy: z.array(z.object({ id: z.number(), title: z.string(), entityKind: z.string(), entityId: z.number().nullable() })),
  firstSeenAt: z.string(), lastSeenAt: z.string(), resolvedAt: z.string().nullable(),
  ignoredAt: z.string().nullable(), ignoredBy: z.string().nullable(), ignoreNote: z.string().nullable(),
  ignoreReason: z.enum(IGNORE_REASONS).nullable(),
  resolution: z.enum(["fixed_by_curation", "changed_elsewhere", "entity_removed", "rules_changed", "declared_distinct"]).nullable(),
  resolvedByRunId: z.number().int().nullable(), resolvedBy: z.string().nullable(),
  actions: z.array(z.object({ key: z.string(), label: z.string(), level: z.number().int() })),
});

const scanResultSchema = z.object({
  scanId: z.number().int().nullable(), status: z.enum(["ok", "partial", "skipped", "failed"]), scope: z.enum(["completo", "dirigido"]), trigger: z.string(), dryRun: z.boolean(),
  durationMs: z.number(), catalogSignature: z.string(), total: z.number(), inserted: z.number(), reopened: z.number(),
  resolved: z.number(), chained: z.number(), byCategory: z.record(z.number()),
  failures: z.array(z.object({ detector: z.string(), error: z.string() })), error: z.string().optional(),
});

const listQuerySchema = paginationQuerySchema.extend({
  category: z.string().max(60).optional(),
  detector: z.string().max(80).optional(),
  signature: z.string().max(300).optional(),
  severity: severitySchema.optional(),
  entityKind: z.string().max(30).optional(),
  status: z.enum(["open", "ignored", "resolved", "all"]).default("open"),
  q: z.string().max(200).optional(),
  scanId: z.coerce.number().int().positive().optional(),
  chained: z.enum(["true", "false"]).transform((value) => value === "true").optional(),
});

const noteSchema = z.string().trim().max(2000);
const ignoreReasonSchema = z.enum(IGNORE_REASONS);

/**
 * Filtro de una acción de grupo: los mismos filtros que el listado (C3,
 * PLAN_CURADURIA E3.1) — antes solo viajaban `category/detector/signature` y
 * la acción tocaba más de lo que la pantalla mostraba (gravedad, tipo de
 * ficha, texto, análisis, encadenados quedaban fuera).
 */
export const groupFilterSchema = {
  category: z.string().min(1).max(60), detector: z.string().min(1).max(80), signature: z.string().max(300).optional(),
  severity: severitySchema.optional(), entityKind: z.string().max(30).optional(), q: z.string().max(200).optional(),
  scanId: z.number().int().positive().optional(), chained: z.boolean().optional(),
};

/**
 * Filtro de «marcar como revisado» en grupo (PLAN_CURADURIA E8.7): los mismos
 * filtros del listado, pero sin exigir categoría ni detector — «Surgidos tras
 * corregir» es justo una vista de todas las categorías. `chained` no viaja:
 * siempre es true, porque solo los encadenados tienen algo que revisar.
 */
const chainGroupFilterSchema = z.object({
  category: z.string().max(60).optional(),
  detector: z.string().max(80).optional(),
  signature: z.string().max(300).optional(),
  severity: severitySchema.optional(),
  entityKind: z.string().max(30).optional(),
  status: z.enum(["open", "ignored", "resolved", "all"]).default("open"),
  q: z.string().max(200).optional(),
  scanId: z.number().int().positive().optional(),
}).strict();

const distinctPairSchema = z.object({
  id: z.number().int(), kind: z.enum(DISTINCT_PAIR_KINDS), aId: z.number().int(), bId: z.number().int(),
  decidedBy: z.string(), note: z.string(), createdAt: z.string(),
});

/** Resolver un conflicto sin revisión viva (PLAN_CURADURIA E7.1): un lado, ambos, descartar, u otro valor. */
const conflictChoiceSchema = z.enum(["a", "b", "both", "dismiss"]);
const conflictResolveBodySchema = z.object({
  note: noteSchema.min(1),
  choice: conflictChoiceSchema.optional().describe("Un lado del conflicto: A, B, conservar ambos o descartarlo."),
  value: z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()]).optional()
    .describe("Corrección manual: el valor correcto, sea uno de los rivales o ninguno. Excluye choice."),
}).strict();
const conflictResolveResultSchema = z.object({
  conflictId: z.number().int(), action: z.literal("resolved"), runId: z.number().int(), detail: z.string(),
});
const conflictResolveGroupResultSchema = z.object({
  total: z.number().int(), applied: z.number().int(), tied: z.number().int(), failed: z.number().int(),
  errors: z.array(z.object({ findingId: z.number().int(), error: z.string() })), more: z.boolean(),
});

/**
 * Escrituras que cambian lo que el detector lee: fichas del core (con sus
 * alias, fusiones y conversiones), relaciones, y decisiones de la cola que
 * tocan el catálogo o los conflictos. Lista explícita: una ruta nueva no
 * dispara un análisis completo hasta que alguien decide que es del catálogo.
 * Fuera quedan `/auth`, las decisiones de Curaduría (sus correcciones avisan
 * por su cuenta) y la prioridad de una revisión, que no cambia el catálogo; la
 * gravedad que deriva de ella la refresca el vigilante en su siguiente vuelta.
 */
const CATALOG_WRITES: readonly RegExp[] = [
  /^\/(?:artists|persons|organizations|albums|tracks)(?:\/|$)/u,
  /^\/(?:artist-members|person-organizations|album-credits|track-credits|album-formats)(?:\/|$)/u,
  /^\/review-queue\/[^/]+\/(?:accept|reject|resolve-conflict)$/u,
  /^\/merge-runs\/[^/]+\/undo$/u,
];

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function isCatalogWrite(method: string, path: string): boolean {
  return WRITE_METHODS.has(method.toUpperCase()) && CATALOG_WRITES.some((pattern) => pattern.test(path));
}

/**
 * Rutas cuyo `:id` ES la ficha que la escritura tocó. Con ella, la escritura se
 * verifica al instante con un análisis dirigido a su vecindad (PLAN_CURADURIA
 * E9.1); sin ella —crear una ficha, editar un crédito, decidir una revisión—
 * solo queda el análisis completo diferido, que llega en menos de un minuto.
 */
const WRITE_ENTITY_BY_PREFIX: Readonly<Record<string, FindingEntityKind>> = {
  artists: "artist", persons: "person", organizations: "organization", albums: "album", tracks: "track",
};

export function writeFocus(routeUrl: string, params: unknown, body?: unknown): FocusRef[] {
  const kind = WRITE_ENTITY_BY_PREFIX[routeUrl.split("/")[1] ?? ""];
  if (!kind) return [];
  const refs: FocusRef[] = [];
  const add = (raw: unknown) => {
    const id = Number(raw);
    if (raw !== undefined && raw !== null && Number.isSafeInteger(id) && id > 0) refs.push({ kind, id });
  };
  add((params as { id?: unknown } | null)?.id);
  // Una fusión retira la otra ficha del mismo tipo: sin ella, sus hallazgos
  // esperarían al análisis completo para darse por resueltos.
  if (routeUrl.endsWith("/merge")) add((body as { dropId?: unknown } | null)?.dropId);
  return refs;
}

const CURATION_STATUS: Readonly<Record<CurationError["code"], number>> = {
  not_found: 404,
  not_fixable: 422,
  invalid: 400,
  // C4: la ficha ya no tiene el valor que vio el análisis (CAS).
  stale: 409,
  // El hash no es el de la vista previa del lote: nada se aplicó (E4).
  stale_preview: 409,
  // Otro proceso aplica o deshace ese lote.
  busy: 409,
  not_open: 409,
};

export function curationError(error: unknown): never {
  if (error instanceof CurationError) throw new ApiError(CURATION_STATUS[error.code], error.code, error.message, error.details);
  throw error;
}

/**
 * Un ítem que no se aplicó, con la forma de error de E3: 404 sin hallazgo, 409
 * si no está abierto, cambió la ficha o el nombre choca, 422 si no tiene
 * corrección disponible.
 */
function legacyFixError(item: FixItemView | undefined): ApiError {
  if (!item) return new ApiError(422, "not_fixable", "el hallazgo no tiene una corrección disponible: hay que editar la ficha");
  const code = item.errorCode ?? item.blocked?.code ?? "not_fixable";
  const message = item.error ?? item.blocked?.message ?? "no se pudo corregir";
  if (code === "not_found") return new ApiError(404, "not_found", message);
  if (code === "not_open") return new ApiError(409, "not_open", message);
  if (code === "stale" || code === "stale_preview") return new ApiError(409, "stale", message);
  if (code === "collision") return new ApiError(409, "collision", message, item.proposal ? { proposal: item.proposal } : undefined);
  if (["not_applicable", "invalid", "empty", "noop", "level"].includes(code)) return new ApiError(422, "not_fixable", message);
  return new ApiError(409, code, message);
}

const legacyOutcome = (id: number, item: FixItemView | undefined) => ({
  id,
  ok: item?.status === "applied",
  error: item?.status === "applied" ? null : item?.error ?? item?.blocked?.message ?? "el hallazgo no tiene una corrección disponible",
});

export async function registerCurationRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  if (getEnv().CRV_CURATION_AUTOSCAN) {
    app.addHook("onResponse", async (request, reply) => {
      if (reply.statusCode >= 400 || !isCatalogWrite(request.method, request.url.split("?")[0] ?? "")) return;
      const route = request.routeOptions.url ?? request.url.split("?")[0] ?? "";
      notifyCatalogWrite(request.operator || null, `${request.method} ${route}`, writeFocus(route, request.params, request.body));
    });
    app.addHook("onClose", async () => { await flushCurationWork(); });
  }

  server.get("/curation/summary", {
    schema: {
      tags: ["curation"],
      summary: "Categorías del detector de conflictos con sus conteos, el último análisis y la última verificación tras una corrección.",
      response: { 200: summarySchema },
    },
  }, async () => {
    const [summary, metrics, autofix] = await Promise.all([
      getCurationSummary(isCurationScanRunning()), getCurationMetrics(), autofixSummary(),
    ]);
    return { ...summary, metrics, autofix };
  });

  server.get("/curation/findings", {
    schema: {
      tags: ["curation"],
      summary: "Hallazgos del detector, filtrables por categoría, detector, subgrupo, gravedad, tipo de ficha, estado, texto, análisis o encadenamiento.",
      querystring: listQuerySchema,
      response: { 200: z.object({ data: z.array(findingSchema), pagination: z.object({ limit: z.number(), offset: z.number(), total: z.number() }) }) },
    },
  }, async (request) => {
    const { rows, total } = await listFindings(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/curation/scans", {
    schema: {
      tags: ["curation"],
      summary: "Últimos análisis del catálogo, con qué los disparó y qué encontraron.",
      querystring: z.object({ limit: z.coerce.number().int().positive().max(100).default(20) }),
      response: { 200: z.object({ data: z.array(scanSchema) }) },
    },
  }, async (request) => ({ data: await listScans(request.query.limit) }));

  server.post("/curation/scan", {
    schema: {
      tags: ["curation"],
      summary: "Analiza el catálogo ahora y devuelve lo nuevo, lo resuelto y lo que apareció tras una corrección.",
      security: OPERATOR_SECURITY,
      response: { 200: scanResultSchema, ...writeErrorResponses },
    },
  }, async (request) => runCurationScan({ trigger: "manual", requestedBy: request.operator || null }));

  server.post("/curation/findings/:id/ignore", {
    schema: {
      tags: ["curation"],
      summary: "Marca un hallazgo como «no es un problema» con su motivo (falso positivo, correcto a propósito o fuera de alcance). Dura mientras el detector lo siga viendo; si el problema desaparece, se resuelve.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: z.object({ reason: ignoreReasonSchema, note: noteSchema.optional() }).strict(),
      response: { 200: findingSchema, ...writeErrorResponses },
    },
  }, async (request) => ignoreFinding(request.params.id, request.operator, request.body.reason, request.body.note || null).catch(curationError));

  server.post("/curation/findings/:id/reopen", {
    schema: {
      tags: ["curation"],
      summary: "Vuelve a abrir un hallazgo ignorado.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      response: { 200: findingSchema, ...writeErrorResponses },
    },
  }, async (request) => reopenFinding(request.params.id).catch(curationError));

  // SURGIDOS TRAS CORREGIR (PLAN_CURADURIA E8.7, M2): darlos por revisados no
  // cierra nada —el problema sigue abierto— solo quita la marca «apareció al
  // corregir» y la guarda en el historial del hallazgo. No toca el catálogo,
  // así que no pide análisis.
  server.post("/curation/findings/:id/acknowledge-chain", {
    schema: {
      tags: ["curation"],
      summary: "Da por revisado un hallazgo «surgido tras corregir»: la marca pasa a evidence.triggeredHistory con quién y cuándo, y sale de la lista de encadenados. El hallazgo sigue abierto.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      response: { 200: findingSchema, ...writeErrorResponses },
    },
  }, async (request) => acknowledgeChain(request.params.id, request.operator).catch(curationError));

  server.post("/curation/findings/acknowledge-chain-group", {
    schema: {
      tags: ["curation"],
      summary: "Da por revisados exactamente los hallazgos encadenados que cumplen el filtro visible. No cierra ninguno ni cambia el catálogo.",
      security: OPERATOR_SECURITY,
      body: chainGroupFilterSchema,
      response: { 200: z.object({ acknowledged: z.number().int() }), ...writeErrorResponses },
    },
  }, async (request) => ({ acknowledged: await acknowledgeChainGroup(request.body, request.operator).catch(curationError) }));

  // VALORES EN DISPUTA (PLAN_CURADURIA E7.1): `conflictos_abiertos` no tiene
  // una revisión viva (`review_queue`) que lo lleve a una persona —la pareja
  // conflicto+revisión nace junta, pero la revisión pudo cerrarse por otra
  // vía— así que se resuelve directo contra `ingest.conflicts`.
  server.post("/curation/findings/:id/resolve-conflict", {
    schema: {
      tags: ["curation"],
      summary: "Resuelve el conflicto de un hallazgo «conflictos_abiertos»: un lado, ambos, descartarlo, o afirmar un valor distinto.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: conflictResolveBodySchema,
      response: { 200: conflictResolveResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const body = request.body;
    const result = await resolveConflictFinding(request.params.id, {
      operator: request.operator, note: body.note,
      ...(body.choice === undefined ? {} : { choice: body.choice }),
      ...(Object.hasOwn(body, "value") && body.value !== undefined ? { value: body.value } : {}),
    }).catch(curationError);
    // Un conflicto resuelto lo ve el detector de cola, que es global: no hay
    // verificación dirigida posible, así que el completo no espera (E9.2).
    notifyCatalogWrite(request.operator || null, "POST /curation/findings/:id/resolve-conflict", [], { fullScan: "soon" });
    return result;
  });

  server.post("/curation/findings/resolve-conflicts-group", {
    schema: {
      tags: ["curation"],
      summary: "«Aplicar la fuente de mayor confianza»: resuelve cada conflicto abierto que cumple el filtro visible por el lado de mayor trust_level; los empates quedan fuera.",
      security: OPERATOR_SECURITY,
      body: z.object({ ...groupFilterSchema, note: noteSchema.min(1) }).strict(),
      response: { 200: conflictResolveGroupResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const { note, ...filter } = request.body;
    const result = await resolveConflictsGroupByTrust(filter, request.operator, note).catch(curationError);
    if (result.applied > 0) notifyCatalogWrite(request.operator || null, "POST /curation/findings/resolve-conflicts-group", [], { fullScan: "soon" });
    return result;
  });

  server.post("/curation/findings/ignore-group", {
    schema: {
      tags: ["curation"],
      summary: "Ignora exactamente los hallazgos abiertos que cumplen el filtro visible (categoría, detector, subgrupo, gravedad, tipo de ficha, texto, análisis, encadenados). Motivo y nota obligatorios.",
      security: OPERATOR_SECURITY,
      body: z.object({ ...groupFilterSchema, reason: ignoreReasonSchema, note: noteSchema.min(1) }).strict(),
      response: { 200: z.object({ ignored: z.number().int() }), ...writeErrorResponses },
    },
  }, async (request) => ({ ignored: await ignoreGroup(request.body, request.operator, request.body.reason, request.body.note) }));

  server.get("/curation/distinct-pairs", {
    schema: {
      tags: ["curation"],
      summary: "Pares de fichas declarados distintos: el detector de duplicados no los vuelve a proponer.",
      querystring: paginationQuerySchema.extend({ kind: z.enum(DISTINCT_PAIR_KINDS).optional() }),
      response: { 200: z.object({ data: z.array(distinctPairSchema), pagination: z.object({ limit: z.number(), offset: z.number(), total: z.number() }) }) },
    },
  }, async (request) => {
    const { rows, total } = await listDistinctPairs(request.query);
    return toPage(rows, total, request.query);
  });

  server.post("/curation/distinct-pairs", {
    schema: {
      tags: ["curation"],
      summary: "Declara distintas dos fichas del mismo tipo. No cambia el catálogo: el hallazgo del par se resuelve como «declaradas distintas» en el siguiente análisis, que se pide enseguida.",
      security: OPERATOR_SECURITY,
      body: z.object({
        kind: z.enum(DISTINCT_PAIR_KINDS), aId: z.number().int().positive(), bId: z.number().int().positive(), note: noteSchema.min(1),
      }).strict(),
      response: { 200: z.object({ pair: distinctPairSchema, created: z.boolean() }), ...writeErrorResponses },
    },
  }, async (request) => {
    const result = await declareDistinctPair(request.body, request.operator, request.body.note).catch(curationError);
    // Nada del catálogo cambió, pero el par deja de ser un hallazgo. Lo ve el
    // detector de duplicados, que es global: se pide el análisis completo ya.
    if (result.created) notifyCatalogWrite(request.operator || null, "POST /curation/distinct-pairs", [], { fullScan: "soon" });
    return result;
  });

  server.delete("/curation/distinct-pairs/:id", {
    schema: {
      tags: ["curation"],
      summary: "Retira la declaración de un par: el detector puede volver a proponerlo.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      response: { 200: z.object({ pair: distinctPairSchema }), ...writeErrorResponses },
    },
  }, async (request) => {
    const pair = await removeDistinctPair(request.params.id).catch(curationError);
    notifyCatalogWrite(request.operator || null, "DELETE /curation/distinct-pairs/:id", [], { fullScan: "soon" });
    return { pair };
  });

  const fixOutcomeSchema = z.object({ id: z.number().int(), ok: z.boolean(), error: z.string().nullable() });
  const fixBatchResultSchema = z.object({ outcomes: z.array(fixOutcomeSchema), fixed: z.number().int(), failed: z.number().int(), more: z.boolean().optional() });

  // ALIAS OBSOLETOS (PLAN_CURADURIA E4.8): un lote de `limpiar_texto` con vista
  // previa y aplicación en la misma llamada, y la respuesta de E3. Cada
  // corrección queda en su lote, con su run y deshacible. No se retiran hasta
  // que la web use `/curation/fixes/*` (E8).
  server.post("/curation/findings/:id/fix", {
    schema: {
      tags: ["curation"],
      summary: "OBSOLETA (usar /curation/fixes/preview y /apply): corrige la ficha del hallazgo con su limpieza de texto (o un valor escrito a mano) como un lote individual.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: z.object({ note: noteSchema.min(1), value: z.string().trim().min(1).max(2000).optional() }).strict(),
      response: { 200: findingSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const { items } = await fixWithoutReview({
      mode: "individual", findingIds: [request.params.id], actionKey: "limpiar_texto",
      ...(request.body.value === undefined ? {} : { overrides: { params: { value: request.body.value } } }),
    }, request.operator, request.body.note).catch(curationError);
    const item = items[0];
    if (item?.status !== "applied") throw legacyFixError(item);
    const finding = await getFinding(request.params.id);
    if (!finding) throw notFound("hallazgo", request.params.id);
    return finding;
  });

  server.post("/curation/findings/fix-selected", {
    schema: {
      tags: ["curation"],
      summary: "OBSOLETA (usar /curation/fixes/preview con mode=selected): corrige varios hallazgos elegidos, cada uno con su limpieza de texto, como un lote de selección. Reporta cuáles no se corrigieron y por qué.",
      security: OPERATOR_SECURITY,
      body: z.object({ ids: z.array(z.number().int().positive()).min(1).max(500), note: noteSchema.min(1) }).strict(),
      response: { 200: fixBatchResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const { items } = await fixWithoutReview({ mode: "selected", findingIds: request.body.ids, actionKey: "limpiar_texto" }, request.operator, request.body.note)
      .catch(curationError);
    const byFinding = new Map(items.map((item) => [item.findingId, item]));
    const outcomes = request.body.ids.map((id) => legacyOutcome(id, byFinding.get(id)));
    return { outcomes, fixed: outcomes.filter((outcome) => outcome.ok).length, failed: outcomes.filter((outcome) => !outcome.ok).length };
  });

  server.post("/curation/findings/fix-group", {
    schema: {
      tags: ["curation"],
      summary: "OBSOLETA (usar /curation/fixes/preview con mode=group): corrige con su limpieza de texto exactamente los hallazgos abiertos que cumplen el filtro visible, como un lote de grupo. Hasta CRV_CURATION_FIX_BATCH_MAX por llamada.",
      security: OPERATOR_SECURITY,
      body: z.object({ ...groupFilterSchema, note: noteSchema.min(1) }).strict(),
      response: { 200: fixBatchResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const { note, ...filter } = request.body;
    const { batch, items } = await fixWithoutReview({ mode: "group", filter, actionKey: "limpiar_texto" }, request.operator, note).catch(curationError);
    const outcomes = items.map((item) => legacyOutcome(item.findingId ?? 0, item));
    const pending = typeof batch.counts["pending"] === "number" ? batch.counts["pending"] : 0;
    return {
      outcomes, fixed: outcomes.filter((outcome) => outcome.ok).length, failed: outcomes.filter((outcome) => !outcome.ok).length,
      more: batch.counts["truncated"] === true || pending > 0,
    };
  });

  server.get("/curation/findings/:id", {
    schema: {
      tags: ["curation"],
      summary: "Un hallazgo con su evidencia completa.",
      params: idParamSchema,
      response: { 200: findingSchema, 404: z.object({ error: z.object({ code: z.string(), message: z.string() }) }) },
    },
  }, async (request) => {
    const finding = await getFinding(request.params.id);
    if (!finding) throw notFound("hallazgo", request.params.id);
    return finding;
  });
}
