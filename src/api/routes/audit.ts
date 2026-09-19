import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, paginatedResponseSchema } from "../schemas.js";
import { AUDIT_COLUMN, getRun, listAudit, type AuditEntity } from "../repositories/audit.js";
import { notFound } from "../http-errors.js";

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

export async function registerAuditRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

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
