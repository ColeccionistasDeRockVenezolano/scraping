// CRV · Curaduría: marco de acciones de corrección en la API (PLAN_CURADURIA E4.3).
//
// Toda corrección es un lote con vista previa: se previsualiza (nada se
// escribe), se aplica con el hash de esa vista previa y una nota, se consulta
// su progreso y su verificación, y se deshace. Las lecturas son solo para
// administradores (ADMIN_READS cubre `/curation`); las escrituras pasan la
// guarda de sesión admin + CSRF o el token de operador.
//
// Estas rutas NO disparan el análisis completo por escritura: cada lote
// aplicado verifica sus propias fichas con un análisis dirigido y el vigilante
// recoge lo demás en su siguiente vuelta.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { OPERATOR_SECURITY } from "../auth.js";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, writeErrorResponses } from "../schemas.js";
import {
  BATCH_STATUSES, ITEM_STATUSES, applyFixBatch, describeFindingActions, getFixBatch, listFixBatches, previewFixBatch, undoFixBatch,
} from "../../curation/actions/batches.js";
import { waitForCurationScans } from "../../curation/scan.js";
import { curationError, groupFilterSchema } from "./curation.js";

const entityRefSchema = z.object({ kind: z.string(), id: z.number().int().nullable(), label: z.string() });
const entityKeySchema = z.object({ kind: z.string(), id: z.number().int() });
const blockedSchema = z.object({ code: z.string(), message: z.string() });
const preconditionSchema = z.object({ key: z.string(), ok: z.boolean(), code: z.string().optional(), message: z.string().optional() });
const collisionSchema = z.object({ kind: z.string(), id: z.number().int(), label: z.string(), exact: z.boolean() });
const proposalSchema = z.object({ actionKey: z.string(), params: z.record(z.unknown()), reason: z.string() });

export const fixItemSchema = z.object({
  id: z.number().int(),
  position: z.number().int(),
  findingId: z.number().int().nullable(),
  finding: z.object({
    id: z.number().int(), detector: z.string(), signature: z.string(), title: z.string(), entity: entityRefSchema,
    field: z.string().nullable(), value: z.string().nullable(), status: z.string(),
  }).nullable(),
  actionKey: z.string().nullable(),
  actionLabel: z.string().nullable(),
  level: z.number().int().nullable(),
  params: z.record(z.unknown()),
  status: z.enum(ITEM_STATUSES),
  before: z.record(z.unknown()).nullable(),
  after: z.record(z.unknown()).nullable(),
  touched: z.array(entityKeySchema),
  blocked: blockedSchema.nullable(),
  noop: z.object({ coveredBy: z.number().int().nullable() }).nullable(),
  collisions: z.array(collisionSchema),
  warnings: z.array(z.string()),
  proposal: proposalSchema.nullable(),
  preconditions: z.array(preconditionSchema),
  runId: z.number().int().nullable(),
  undoOfItemId: z.number().int().nullable(),
  errorCode: z.string().nullable(),
  error: z.string().nullable(),
  appliedAt: z.string().nullable(),
});

export const fixBatchSchema = z.object({
  id: z.number().int(),
  mode: z.enum(["individual", "selected", "group", "auto", "undo"]),
  filter: z.record(z.unknown()),
  actionKey: z.string().nullable(),
  requestedBy: z.string(),
  appliedBy: z.string().nullable(),
  note: z.string().nullable(),
  previewHash: z.string(),
  status: z.enum(BATCH_STATUSES),
  counts: z.record(z.unknown()),
  verification: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  undoOfBatchId: z.number().int().nullable(),
  undoneByBatchId: z.number().int().nullable(),
  items: z.array(fixItemSchema),
  pagination: z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }),
});

const fixBatchSummarySchema = z.object({
  id: z.number().int(),
  mode: z.enum(["individual", "selected", "group", "auto", "undo"]),
  filter: z.record(z.unknown()),
  actionKey: z.string().nullable(),
  requestedBy: z.string(),
  appliedBy: z.string().nullable(),
  note: z.string().nullable(),
  status: z.enum(BATCH_STATUSES),
  counts: z.record(z.unknown()),
  verification: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  undoOfBatchId: z.number().int().nullable(),
  undoneByBatchId: z.number().int().nullable(),
});

const findingActionsSchema = z.object({
  findingId: z.number().int(),
  status: z.string(),
  actions: z.array(z.object({
    key: z.string(), label: z.string(), description: z.string(), level: z.number().int(), inverse: z.string().nullable(),
    recommended: z.boolean(), params: z.record(z.unknown()).nullable(), preconditions: z.array(preconditionSchema), available: z.boolean(),
  })),
});

const noteSchema = z.string().trim().min(1).max(2000);
const batchParamsSchema = z.object({ batchId: z.coerce.number().int().positive() });
const itemPageQuerySchema = paginationQuerySchema.extend({ status: z.enum(ITEM_STATUSES).optional() });
const actionKeySchema = z.string().min(1).max(60);
const paramsOverrideSchema = z.record(z.unknown());

export async function registerCurationActionRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();
  // Las verificaciones de lotes corren detrás de la respuesta, también con el autoanálisis apagado: el cierre las espera.
  app.addHook("onClose", async () => { await waitForCurationScans(); });

  server.get("/curation/fixes", {
    schema: {
      tags: ["curation"],
      summary: "Historial paginado de lotes de corrección, con filtro por estado.",
      querystring: paginationQuerySchema.extend({ status: z.enum(BATCH_STATUSES).optional() }),
      response: {
        200: z.object({
          data: z.array(fixBatchSummarySchema),
          pagination: z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }),
        }),
      },
    },
  }, async (request) => {
    const { rows, total } = await listFixBatches(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/curation/findings/:id/actions", {
    schema: {
      tags: ["curation"],
      summary: "Acciones de corrección que se ofrecen para un hallazgo, con sus parámetros por defecto, nivel (0 seguro … 3 manual), cómo se deshacen y si sus precondiciones se cumplen ahora. La primera es la recomendada.",
      params: idParamSchema,
      response: { 200: findingActionsSchema, 404: writeErrorResponses[404] },
    },
  }, async (request) => describeFindingActions(request.params.id).catch(curationError));

  server.post("/curation/fixes/preview", {
    schema: {
      tags: ["curation"],
      summary: "Previsualiza un lote de correcciones sin escribir nada: por hallazgo, la acción, sus parámetros, el antes → después, las fichas que toca, colisiones y bloqueos. individual/selected se piden con `findingIds`; group, con el filtro exacto del listado. Devuelve el lote `previewed` con su `previewHash` y la primera página de ítems.",
      security: OPERATOR_SECURITY,
      querystring: itemPageQuerySchema,
      body: z.object({
        mode: z.enum(["individual", "selected", "group"]),
        findingIds: z.array(z.number().int().positive()).min(1).max(50_000).optional(),
        filter: z.object(groupFilterSchema).strict().optional(),
        actionKey: actionKeySchema.optional(),
        overrides: z.object({
          params: paramsOverrideSchema.optional(),
          byFinding: z.record(z.string().regex(/^\d+$/u), z.object({ actionKey: actionKeySchema.optional(), params: paramsOverrideSchema.optional() }).strict()).optional(),
        }).strict().optional(),
      }).strict(),
      response: { 200: fixBatchSchema, ...writeErrorResponses },
    },
  }, async (request) => previewFixBatch(request.body, request.operator, { page: request.query }).catch(curationError));

  server.post("/curation/fixes/:batchId/apply", {
    schema: {
      tags: ["curation"],
      summary: "Aplica un lote previsualizado. 409 `stale_preview` sin escribir nada si `previewHash` no es el de su vista previa o si, recalculada ahora, la vista previa de lo pendiente ya no da lo mismo (`details.changedItemIds`: volver a previsualizar o excluirlos). Un run por ítem; un ítem cuya ficha cambia en medio del lote queda `skipped_stale` y el resto sigue. Hasta CRV_CURATION_FIX_BATCH_MAX ítems por llamada: si quedan pendientes, el lote sigue `running` y otra llamada igual continúa. Después verifica las fichas tocadas en segundo plano (`verification`).",
      security: OPERATOR_SECURITY,
      params: batchParamsSchema,
      querystring: itemPageQuerySchema,
      body: z.object({
        previewHash: z.string().min(1).max(128),
        excludeItemIds: z.array(z.number().int().positive()).max(50_000).optional(),
        note: noteSchema,
      }).strict(),
      response: { 200: fixBatchSchema, ...writeErrorResponses },
    },
  }, async (request) => applyFixBatch(request.params.batchId, request.body, request.operator, request.query).catch(curationError));

  server.get("/curation/fixes/:batchId", {
    schema: {
      tags: ["curation"],
      summary: "Progreso y resultado de un lote de correcciones (o de su deshacer): recuentos, verificación dirigida y los ítems paginados, filtrables por estado.",
      params: batchParamsSchema,
      querystring: itemPageQuerySchema,
      response: { 200: fixBatchSchema, 404: writeErrorResponses[404] },
    },
  }, async (request) => getFixBatch(request.params.batchId, request.query).catch(curationError));

  server.post("/curation/fixes/:batchId/undo", {
    schema: {
      tags: ["curation"],
      summary: "Deshace lo aplicado de un lote en orden inverso, como un lote nuevo (`mode: undo`). Solo se restaura lo que sigue como lo dejó la corrección (CAS inverso); lo demás queda `not_undoable` con el motivo. Devuelve el lote de deshacer.",
      security: OPERATOR_SECURITY,
      params: batchParamsSchema,
      querystring: itemPageQuerySchema,
      body: z.object({ note: noteSchema }).strict(),
      response: { 200: fixBatchSchema, ...writeErrorResponses },
    },
  }, async (request) => undoFixBatch(request.params.batchId, request.body, request.operator, request.query).catch(curationError));
}
