import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, aliasSchema, paginatedResponseSchema } from "../schemas.js";
import { getOrganizationDetail, listOrganizations } from "../repositories/organizations.js";
import { notFoundEntity } from "../repositories/redirects.js";

const organizationListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  organizationType: z.string(),
  country: z.string().nullable(),
});

const organizationDetailSchema = organizationListItemSchema.extend({
  biography: z.string().nullable(),
  pictureUrl: z.string().nullable(),
  websiteUrl: z.string().nullable(),
  notes: z.string().nullable(),
  labelAlbums: z.array(z.object({
    albumId: z.number().int(), title: z.string(), releaseYear: z.number().int().nullable(),
    artistId: z.number().int(), artistName: z.string(),
  })),
  creditedArtists: z.array(z.object({ artistId: z.number().int(), artistName: z.string() })),
  associatedPersons: z.array(z.object({
    id: z.number().int(), personId: z.number().int(), personName: z.string(), role: z.string(),
    fromYear: z.number().int().nullable(), toYear: z.number().int().nullable(),
  })),
  aliases: z.array(aliasSchema),
});

const listQuerySchema = paginationQuerySchema.extend({ q: z.string().trim().min(1).optional() });

export async function registerOrganizationRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/organizations", {
    schema: {
      tags: ["organizations"],
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(organizationListItemSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listOrganizations(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/organizations/:id", {
    schema: {
      tags: ["organizations"],
      params: idParamSchema,
      response: { 200: organizationDetailSchema },
    },
  }, async (request) => {
    const detail = await getOrganizationDetail(request.params.id);
    if (!detail) throw await notFoundEntity("organization", request.params.id);
    return detail;
  });
}
