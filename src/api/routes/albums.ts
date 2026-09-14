import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, aliasSchema, paginatedResponseSchema } from "../schemas.js";
import { getAlbumDetail, listAlbums } from "../repositories/albums.js";
import { notFound } from "../http-errors.js";

const albumListItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  releaseYear: z.number().int().nullable(),
  albumType: z.string(),
  artistId: z.number().int(),
  artistName: z.string(),
  coverUrl: z.string().nullable(),
});

const creditSchema = z.object({
  id: z.number().int(),
  creditType: z.string(),
  role: z.string(),
  personId: z.number().int().nullable(),
  personName: z.string().nullable(),
  artistId: z.number().int().nullable(),
  artistName: z.string().nullable(),
  organizationId: z.number().int().nullable(),
  organizationName: z.string().nullable(),
});

const trackSchema = z.object({
  id: z.number().int(),
  discNumber: z.number().int(),
  trackNumber: z.number().int(),
  title: z.string(),
  durationSeconds: z.number().int().nullable(),
  youtubeStartSeconds: z.number().int().nullable(),
  credits: z.array(creditSchema),
});

const albumDetailSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  releaseYear: z.number().int().nullable(),
  albumType: z.string(),
  genre: z.string().nullable(),
  coverUrl: z.string().nullable(),
  description: z.string().nullable(),
  notes: z.string().nullable(),
  youtubeUrl: z.string().nullable(),
  youtubeStatus: z.string(),
  instagramUrl: z.string().nullable(),
  instagramStatus: z.string(),
  wordpressUrl: z.string().nullable(),
  wordpressStatus: z.string(),
  artist: z.object({ id: z.number().int(), name: z.string() }),
  label: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  tracklist: z.array(trackSchema),
  credits: z.array(creditSchema),
  creditsByType: z.record(z.string(), z.array(creditSchema)),
  formats: z.array(z.object({ id: z.number().int(), format: z.string(), quality: z.string().nullable(), archiveStatus: z.string() })),
  aliases: z.array(aliasSchema),
  youtubeLinks: z.array(z.object({
    videoId: z.string(), title: z.string().nullable(), kind: z.string(), isPrimaryLink: z.boolean(),
  })),
});

const listQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).optional(),
  artistId: z.coerce.number().int().positive().optional(),
});

export async function registerAlbumRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/albums", {
    schema: {
      tags: ["albums"],
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(albumListItemSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listAlbums(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/albums/:id", {
    schema: {
      tags: ["albums"],
      summary: "Ficha agregada del disco: tracklist, créditos y enlaces de YouTube.",
      params: idParamSchema,
      response: { 200: albumDetailSchema },
    },
  }, async (request) => {
    const detail = await getAlbumDetail(request.params.id);
    if (!detail) throw notFound("album", request.params.id);
    return detail;
  });
}
