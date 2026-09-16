import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, aliasSchema, paginatedResponseSchema } from "../schemas.js";
import { getPersonDetail, listPersons } from "../repositories/persons.js";
import { notFoundEntity } from "../repositories/redirects.js";

const personListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  nationality: z.string().nullable(),
  isVenezuelan: z.boolean(),
  pictureUrl: z.string().nullable(),
});

const personDetailSchema = personListItemSchema.extend({
  biography: z.string().nullable(),
  birthDate: z.string().nullable(),
  deathDate: z.string().nullable(),
  notes: z.string().nullable(),
  bands: z.array(z.object({
    id: z.number().int(), artistId: z.number().int(), artistName: z.string(), role: z.string(),
    fromYear: z.number().int().nullable(), toYear: z.number().int().nullable(), isCurrent: z.boolean(),
  })),
  albumCredits: z.array(z.object({
    id: z.number().int(), albumId: z.number().int(), albumTitle: z.string(), artistId: z.number().int(), artistName: z.string(),
    creditType: z.string(), role: z.string(),
  })),
  trackCredits: z.array(z.object({
    id: z.number().int(), trackId: z.number().int(), trackTitle: z.string(), albumId: z.number().int(), albumTitle: z.string(),
    creditType: z.string(), role: z.string(),
  })),
  organizations: z.array(z.object({
    id: z.number().int(), organizationId: z.number().int(), organizationName: z.string(), role: z.string(),
    fromYear: z.number().int().nullable(), toYear: z.number().int().nullable(),
  })),
  aliases: z.array(aliasSchema),
});

const listQuerySchema = paginationQuerySchema.extend({ q: z.string().trim().min(1).optional() });

export async function registerPersonRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/persons", {
    schema: {
      tags: ["persons"],
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(personListItemSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listPersons(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/persons/:id", {
    schema: {
      tags: ["persons"],
      params: idParamSchema,
      response: { 200: personDetailSchema },
    },
  }, async (request) => {
    const detail = await getPersonDetail(request.params.id);
    if (!detail) throw await notFoundEntity("person", request.params.id);
    return detail;
  });
}
