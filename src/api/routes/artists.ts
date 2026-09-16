import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, aliasSchema, paginatedResponseSchema } from "../schemas.js";
import { getArtistDetail, listArtists } from "../repositories/artists.js";
import { notFoundEntity } from "../repositories/redirects.js";

const artistListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  artistType: z.string(),
  originCity: z.string().nullable(),
  originCountry: z.string(),
  formedYear: z.number().int().nullable(),
  disbandedYear: z.number().int().nullable(),
  pictureUrl: z.string().nullable(),
});

const artistDetailSchema = artistListItemSchema.extend({
  biography: z.string().nullable(),
  notes: z.string().nullable(),
  members: z.array(z.object({
    id: z.number().int(), personId: z.number().int(), personName: z.string(), role: z.string(),
    fromYear: z.number().int().nullable(), toYear: z.number().int().nullable(), isCurrent: z.boolean(),
  })),
  discography: z.array(z.object({
    albumId: z.number().int(), title: z.string(), releaseYear: z.number().int().nullable(),
    albumType: z.string(), coverUrl: z.string().nullable(),
  })),
  aliases: z.array(aliasSchema),
});

const listQuerySchema = paginationQuerySchema.extend({ q: z.string().trim().min(1).optional() });

export async function registerArtistRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/artists", {
    schema: {
      tags: ["artists"],
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(artistListItemSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listArtists(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/artists/:id", {
    schema: {
      tags: ["artists"],
      params: idParamSchema,
      response: { 200: artistDetailSchema },
    },
  }, async (request) => {
    const detail = await getArtistDetail(request.params.id);
    if (!detail) throw await notFoundEntity("artist", request.params.id);
    return detail;
  });
}
