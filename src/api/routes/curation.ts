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
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getEnv } from "../../config/env.js";
import { ApiError, notFound } from "../http-errors.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, writeErrorResponses } from "../schemas.js";
import {
  CurationError, fixFinding, fixFindingsGroup, fixFindingsSelected, getCurationSummary, getFinding, ignoreFinding, ignoreGroup,
  listFindings, listScans, reopenFinding,
} from "../../curation/repository.js";
import { isCurationScanRunning, runCurationScan } from "../../curation/scan.js";
import { flushCurationWork, notifyCatalogWrite } from "../../curation/watcher.js";

const severitySchema = z.enum(["high", "medium", "low"]);
const entityRefSchema = z.object({ kind: z.string(), id: z.number().int().nullable(), label: z.string() });

const scanSchema = z.object({
  id: z.number().int(), status: z.string(), trigger: z.string(), requestedBy: z.string().nullable(),
  startedAt: z.string(), finishedAt: z.string().nullable(), error: z.string().nullable(), counters: z.record(z.unknown()),
});

const summarySchema = z.object({
  lastScan: scanSchema.nullable(),
  lastCorrection: scanSchema.nullable(),
  running: z.boolean(),
  totals: z.object({ open: z.number(), ignored: z.number(), resolved: z.number(), newInLastScan: z.number(), chainedOpen: z.number() }),
  categories: z.array(z.object({
    key: z.string(), label: z.string(), description: z.string(),
    open: z.number(), ignored: z.number(), resolved: z.number(), newInLastScan: z.number(), chainedOpen: z.number(),
    severity: z.object({ high: z.number(), medium: z.number(), low: z.number() }),
    detectors: z.array(z.object({
      key: z.string(), label: z.string(), description: z.string(),
      open: z.number(), ignored: z.number(), resolved: z.number(), newInLastScan: z.number(),
      signatures: z.array(z.object({ key: z.string(), label: z.string(), open: z.number() })),
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
  resolution: z.enum(["fixed_by_curation", "changed_elsewhere", "entity_removed", "rules_changed"]).nullable(),
  resolvedByRunId: z.number().int().nullable(), resolvedBy: z.string().nullable(),
});

const scanResultSchema = z.object({
  scanId: z.number().int().nullable(), status: z.enum(["ok", "partial", "skipped", "failed"]), trigger: z.string(), dryRun: z.boolean(),
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

function curationError(error: unknown): never {
  if (error instanceof CurationError) {
    if (error.code === "not_found") throw new ApiError(404, "not_found", error.message);
    if (error.code === "not_fixable") throw new ApiError(422, "not_fixable", error.message);
    throw new ApiError(409, "not_open", error.message);
  }
  throw error;
}

export async function registerCurationRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  if (getEnv().CRV_CURATION_AUTOSCAN) {
    app.addHook("onResponse", async (request, reply) => {
      if (reply.statusCode >= 400 || !isCatalogWrite(request.method, request.url.split("?")[0] ?? "")) return;
      notifyCatalogWrite(request.operator || null, `${request.method} ${request.routeOptions.url ?? request.url.split("?")[0]}`);
    });
    app.addHook("onClose", async () => { await flushCurationWork(); });
  }

  server.get("/curation/summary", {
    schema: {
      tags: ["curation"],
      summary: "Categorías del detector de conflictos con sus conteos, el último análisis y la última verificación tras una corrección.",
      response: { 200: summarySchema },
    },
  }, async () => getCurationSummary(isCurationScanRunning()));

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
      summary: "Marca un hallazgo como «no es un problema»: el detector no lo vuelve a abrir mientras el valor no cambie.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: z.object({ note: noteSchema.optional() }).strict(),
      response: { 200: findingSchema, ...writeErrorResponses },
    },
  }, async (request) => ignoreFinding(request.params.id, request.operator, request.body.note || null).catch(curationError));

  server.post("/curation/findings/:id/reopen", {
    schema: {
      tags: ["curation"],
      summary: "Vuelve a abrir un hallazgo ignorado.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      response: { 200: findingSchema, ...writeErrorResponses },
    },
  }, async (request) => reopenFinding(request.params.id).catch(curationError));

  server.post("/curation/findings/ignore-group", {
    schema: {
      tags: ["curation"],
      summary: "Ignora todos los hallazgos abiertos de un detector (y, si se indica, de un subgrupo). La nota es obligatoria.",
      security: OPERATOR_SECURITY,
      body: z.object({
        category: z.string().min(1).max(60), detector: z.string().min(1).max(80), signature: z.string().max(300).optional(),
        note: noteSchema.min(1),
      }).strict(),
      response: { 200: z.object({ ignored: z.number().int() }), ...writeErrorResponses },
    },
  }, async (request) => ({ ignored: await ignoreGroup(request.body, request.operator, request.body.note) }));

  const fixOutcomeSchema = z.object({ id: z.number().int(), ok: z.boolean(), error: z.string().nullable() });
  const fixBatchResultSchema = z.object({ outcomes: z.array(fixOutcomeSchema), fixed: z.number().int(), failed: z.number().int(), more: z.boolean().optional() });

  server.post("/curation/findings/:id/fix", {
    schema: {
      tags: ["curation"],
      summary: "Corrige la ficha del hallazgo: aplica su valor sugerido (o uno indicado a mano) al campo detectado.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: z.object({ note: noteSchema.min(1), value: z.string().trim().min(1).max(2000).optional() }).strict(),
      response: { 200: findingSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const finding = await fixFinding(request.params.id, request.operator, request.body.note, request.body.value).catch(curationError);
    notifyCatalogWrite(request.operator || null, "POST /curation/findings/:id/fix");
    return finding;
  });

  server.post("/curation/findings/fix-selected", {
    schema: {
      tags: ["curation"],
      summary: "Corrige varios hallazgos elegidos a mano, cada uno con su propio valor sugerido. Reporta cuáles no tenían corrección disponible.",
      security: OPERATOR_SECURITY,
      body: z.object({ ids: z.array(z.number().int().positive()).min(1).max(500), note: noteSchema.min(1) }).strict(),
      response: { 200: fixBatchResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const outcomes = await fixFindingsSelected(request.body.ids, request.operator, request.body.note);
    if (outcomes.some((outcome) => outcome.ok)) notifyCatalogWrite(request.operator || null, "POST /curation/findings/fix-selected");
    return { outcomes, fixed: outcomes.filter((outcome) => outcome.ok).length, failed: outcomes.filter((outcome) => !outcome.ok).length };
  });

  server.post("/curation/findings/fix-group", {
    schema: {
      tags: ["curation"],
      summary: "Corrige de una vez todos los hallazgos abiertos y corregibles de un detector (y, si se indica, un subgrupo). Hasta 500 por llamada.",
      security: OPERATOR_SECURITY,
      body: z.object({
        category: z.string().min(1).max(60), detector: z.string().min(1).max(80), signature: z.string().max(300).optional(),
        note: noteSchema.min(1),
      }).strict(),
      response: { 200: fixBatchResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const { outcomes, more } = await fixFindingsGroup(request.body, request.operator, request.body.note);
    if (outcomes.some((outcome) => outcome.ok)) notifyCatalogWrite(request.operator || null, "POST /curation/findings/fix-group");
    return { outcomes, fixed: outcomes.filter((outcome) => outcome.ok).length, failed: outcomes.filter((outcome) => !outcome.ok).length, more };
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
