import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, paginatedResponseSchema, writeErrorResponses } from "../schemas.js";
import { getReviewQueueDetail, listReviewQueue } from "../repositories/review-queue.js";
import { notFound } from "../http-errors.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { acceptReview, rejectReview, resolveReviewConflict, setReviewPriority } from "../../review/operator-review.js";

const reviewListItemSchema = z.object({
  id: z.number().int(),
  kind: z.string(),
  status: z.string(),
  priority: z.number().int(),
  notes: z.string().nullable(),
  createdAt: z.string(),
});

const reviewDetailSchema = reviewListItemSchema.extend({
  claimAId: z.number().int().nullable(),
  claimBId: z.number().int().nullable(),
  conflictId: z.number().int().nullable(),
  artistAId: z.number().int().nullable(),
  artistBId: z.number().int().nullable(),
  personAId: z.number().int().nullable(),
  personBId: z.number().int().nullable(),
  organizationAId: z.number().int().nullable(),
  organizationBId: z.number().int().nullable(),
  albumId: z.number().int().nullable(),
  trackId: z.number().int().nullable(),
  videoId: z.number().int().nullable(),
  payload: z.unknown(),
  resolvedAt: z.string().nullable(),
  resolvedBy: z.string().nullable(),
  resolutionNote: z.string().nullable(),
  claims: z.array(z.object({
    id: z.number().int(), field: z.string(), rawValue: z.unknown(), normalizedValue: z.unknown(),
    confidence: z.string(), status: z.string(), sourceName: z.string(), sourceTrustLevel: z.string(),
    sourceUrl: z.string().nullable(), evidenceUrl: z.string().nullable(),
  })),
});

const listQuerySchema = paginationQuerySchema.extend({
  status: z.string().optional(),
  kind: z.string().optional(),
});

const reviewNote = z.string().trim().min(1).max(2000).describe("Obligatoria: queda firmada en la revisión y en el run.");

const acceptBodySchema = z.object({
  note: reviewNote,
  targetId: z.number().int().positive().optional()
    .describe("Candidato con el que se confirma la identidad; por defecto, el que propuso el ER."),
}).strict();

const rejectBodySchema = z.object({ note: reviewNote }).strict();

const resolveBodySchema = z.object({
  note: reviewNote,
  choice: z.enum(["canonical", "proposed", "a", "b", "both", "dismiss"]).optional()
    .describe("Elegir un lado del conflicto: el valor actual, el propuesto, A, B, conservar ambos o descartarlo."),
  value: z.union([z.string().max(20_000), z.number(), z.boolean(), z.null()]).optional()
    .describe("Corrección manual: el valor correcto, sea uno de los rivales o ninguno. Excluye choice."),
}).strict();

const reviewActionSchema = z.object({
  reviewId: z.number().int(),
  kind: z.string(),
  action: z.enum(["accepted", "rejected", "resolved"]),
  runId: z.number().int(),
  status: z.string(),
  detail: z.string(),
});

const priorityBodySchema = z.object({
  priority: z.number().int().min(1).max(10).describe("1-10; mayor número, más urgente."),
  note: reviewNote,
}).strict();

const priorityResultSchema = z.object({
  reviewId: z.number().int(),
  priority: z.number().int(),
  runId: z.number().int(),
});

export async function registerReviewRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/review-queue", {
    schema: {
      tags: ["review-queue"],
      summary: "Cola de revisión, paginada y filtrable por estado y tipo.",
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(reviewListItemSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listReviewQueue(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/review-queue/:id", {
    schema: {
      tags: ["review-queue"],
      params: idParamSchema,
      response: { 200: reviewDetailSchema },
    },
  }, async (request) => {
    const detail = await getReviewQueueDetail(request.params.id);
    if (!detail) throw notFound("review_queue", request.params.id);
    return detail;
  });

  server.post("/review-queue/:id/accept", {
    schema: {
      tags: ["review-queue:write"],
      summary: "Acepta el candidato: confirma la identidad propuesta o promueve los claims candidatos.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: acceptBodySchema,
      response: { 200: reviewActionSchema, ...writeErrorResponses },
    },
  }, async (request) => acceptReview(request.params.id, {
    operator: request.operator, note: request.body.note,
    ...(request.body.targetId === undefined ? {} : { targetId: request.body.targetId }),
  }));

  server.post("/review-queue/:id/reject", {
    schema: {
      tags: ["review-queue:write"],
      summary: "Rechaza el candidato: separa la identidad o descarta los claims candidatos sin tocar el core.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: rejectBodySchema,
      response: { 200: reviewActionSchema, ...writeErrorResponses },
    },
  }, async (request) => rejectReview(request.params.id, { operator: request.operator, note: request.body.note }));

  server.post("/review-queue/:id/resolve-conflict", {
    schema: {
      tags: ["review-queue:write"],
      summary: "Resuelve un field_conflict eligiendo un lado o afirmando el valor correcto; conserva el historial.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: resolveBodySchema,
      response: { 200: reviewActionSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const body = request.body;
    return resolveReviewConflict(request.params.id, {
      operator: request.operator, note: body.note,
      ...(body.choice === undefined ? {} : { choice: body.choice }),
      ...(Object.hasOwn(body, "value") && body.value !== undefined ? { value: body.value } : {}),
    });
  });

  server.patch("/review-queue/:id/priority", {
    schema: {
      tags: ["review-queue:write"],
      summary: "Cambia el orden de una revisión en la cola (1-10, mayor = más urgente).",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: priorityBodySchema,
      response: { 200: priorityResultSchema, ...writeErrorResponses },
    },
  }, async (request) => setReviewPriority(request.params.id, request.body.priority, {
    operator: request.operator, note: request.body.note,
  }));
}
