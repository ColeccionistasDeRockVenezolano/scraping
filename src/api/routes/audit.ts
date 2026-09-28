import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, paginatedResponseSchema } from "../schemas.js";
import { AUDIT_COLUMN, getRun, listAudit, type AuditEntity } from "../repositories/audit.js";
import { notFound } from "../http-errors.js";
import { withOperatorRun } from "../../merge/operator.js";
import { previewAuditUndo, undoAuditEntry } from "../../merge/audit-undo.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { writeErrorResponses } from "../schemas.js";
import { noteSchema } from "./catalog-writes.js";

const auditQuerySchema = paginationQuerySchema.extend({
  entity: z.enum(Object.keys(AUDIT_COLUMN) as [AuditEntity, ...AuditEntity[]]),
  id: z.coerce.number().int().positive(),
});

const auditRowSchema = z.object({
  id: z.number().int(),
  runId: z.number().int().nullable(),
  field: z.string(),
  oldValue: z.unknown(),
  newValue: z.unknown(),
  reason: z.string(),
  confidence: z.string(),
  performedBy: z.string(),
  at: z.string(),
  claimIds: z.array(z.number().int()),
});

const runSchema = z.object({
  id: z.number().int(),
  kind: z.string(),
  status: z.string(),
  sourceId: z.number().int().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  params: z.unknown(),
  counters: z.unknown(),
  errorLog: z.string().nullable(),
});

const auditIdParamSchema = z.object({ auditId: z.coerce.number().int().positive() });

const undoableEntrySchema = z.object({
  auditId: z.number().int(),
  runId: z.number().int().nullable(),
  kind: z.enum(["merge", "absorption"]),
  entityKind: z.string(),
  field: z.string(),
  reason: z.string(),
  at: z.string(),
  restores: z.object({ kind: z.string(), id: z.number().int(), label: z.string().nullable() }),
  undoneByAuditId: z.number().int().nullable(),
  undoneByRunId: z.number().int().nullable(),
});

const auditUndoPreviewSchema = undoableEntrySchema.extend({
  undoable: z.boolean(),
  reasonNot: z.string().nullable(),
  result: z.unknown(),
});

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/audit/:auditId/undo", {
    schema: {
      tags: ["audit"],
      summary: "Qué pasaría al deshacer esa fusión o conversión del historial (no escribe nada). Solo cuentas administradoras.",
      params: auditIdParamSchema,
      response: { 200: auditUndoPreviewSchema },
    },
  }, async (request) => {
    const preview = await previewAuditUndo(request.params.auditId);
    if (!preview) throw notFound("cambio del historial", request.params.auditId);
    const { reason_not: reasonNot, ...rest } = preview;
    return { ...rest, reasonNot };
  });

  server.post("/audit/:auditId/undo", {
    schema: {
      tags: ["audit"],
      summary: "Deshace una fusión o una conversión del historial: la ficha vuelve con sus relaciones. 409 si algo cambió después.",
      security: OPERATOR_SECURITY,
      params: auditIdParamSchema,
      body: z.object({ note: noteSchema.describe("Motivo del deshacer; queda en el run.") }).strict(),
      response: {
        200: z.object({ runId: z.number().int(), auditId: z.number().int(), kind: z.enum(["merge", "absorption"]), result: z.unknown() }),
        ...writeErrorResponses,
      },
    },
  }, async (request) => {
    const auditId = request.params.auditId;
    const { runId, result } = await withOperatorRun({
      name: "api:undo:audit", operator: request.operator, note: request.body.note, params: { undoesAuditId: auditId },
    }, (context) => undoAuditEntry(context, auditId));
    return { runId, auditId, kind: result.kind, result };
  });

  server.get("/audit", {
    schema: {
      tags: ["audit"],
      summary: "Historial de cambios (merge_audit) de una entidad o fila puente, del más reciente al más antiguo. Solo cuentas administradoras.",
      querystring: auditQuerySchema,
      response: { 200: paginatedResponseSchema(auditRowSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listAudit(request.query.entity, request.query.id, request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/runs/:id", {
    schema: {
      tags: ["audit"],
      summary: "Run de ingesta, merge o edición del operador (quién, qué, por qué; el retiro guarda la fila borrada). Solo cuentas administradoras.",
      params: idParamSchema,
      response: { 200: runSchema },
    },
  }, async (request) => {
    const run = await getRun(request.params.id);
    if (!run) throw notFound("run", request.params.id);
    return run;
  });
}
