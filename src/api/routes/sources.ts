import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { idParamSchema } from "../schemas.js";
import { getSourceDetail, listSourcesRead } from "../repositories/sources.js";
import { listClaimsForEntity, type ClaimEntityFilter } from "../repositories/claims.js";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { notFound, badRequest } from "../http-errors.js";

const sourceSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  url: z.string().nullable(),
  siteType: z.string(),
  accessStrategy: z.string().nullable(),
  requiresJs: z.boolean(),
  trustLevel: z.string(),
  enabled: z.boolean(),
  publicDisplay: z.boolean(),
  notes: z.string().nullable(),
});

const sourceDetailSchema = sourceSchema.extend({
  lastRun: z.object({
    id: z.number().int(), kind: z.string(), status: z.string(),
    startedAt: z.string(), finishedAt: z.string().nullable(),
  }).nullable(),
});

const claimSchema = z.object({
  id: z.number().int(),
  entityKind: z.string(),
  field: z.string(),
  rawValue: z.unknown(),
  normalizedValue: z.unknown(),
  confidence: z.string(),
  status: z.string(),
  sourceId: z.number().int(),
  sourceName: z.string(),
  createdAt: z.string(),
});

const CLAIM_ENTITIES = ["artist", "person", "organization", "album", "track"] as const;

const claimsQuerySchema = paginationQuerySchema.extend({
  entity: z.enum(CLAIM_ENTITIES),
  id: z.coerce.number().int().positive(),
});

export async function registerSourceRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/sources", {
    schema: { tags: ["sources"], response: { 200: z.array(sourceSchema) } },
  }, async () => listSourcesRead());

  server.get("/sources/:id", {
    schema: { tags: ["sources"], params: idParamSchema, response: { 200: sourceDetailSchema } },
  }, async (request) => {
    const detail = await getSourceDetail(request.params.id);
    if (!detail) throw notFound("source", request.params.id);
    return detail;
  });

  server.get("/claims", {
    schema: {
      tags: ["claims"],
      summary: "Claims de una entidad (siempre filtrado: entity+id obligatorios).",
      querystring: claimsQuerySchema,
      response: { 200: z.object({
        data: z.array(claimSchema),
        pagination: z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }),
      }) },
    },
  }, async (request) => {
    const { entity, id, ...pagination } = request.query;
    if (!CLAIM_ENTITIES.includes(entity)) throw badRequest(`entidad de claim desconocida: ${entity}`);
    const { rows, total } = await listClaimsForEntity(entity as ClaimEntityFilter, id, pagination);
    return toPage(rows, total, pagination);
  });
}
