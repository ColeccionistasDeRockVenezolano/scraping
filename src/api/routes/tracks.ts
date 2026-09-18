// CRV · Rutas de lectura de pistas (auditoría del sistema, hallazgo #7).
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, aliasSchema, paginatedResponseSchema } from "../schemas.js";
import { notFoundEntity } from "../repositories/redirects.js";
import { getTrackDetail, listTracks } from "../repositories/tracks.js";

const trackListItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  albumId: z.number().int(),
  albumTitle: z.string(),
  artistId: z.number().int(),
  artistName: z.string(),
  discNumber: z.number().int(),
  trackNumber: z.number().int(),
  durationSeconds: z.number().int().nullable(),
  creditCount: z.number().int(),
});

const trackCreditSchema = z.object({
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

const trackDetailSchema = trackListItemSchema.extend({
  youtubeStartSeconds: z.number().int().nullable(),
  notes: z.string().nullable(),
  aliases: z.array(aliasSchema),
  credits: z.array(trackCreditSchema),
});

const listQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).optional(),
  albumId: z.coerce.number().int().positive().optional(),
});

export async function registerTrackRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/tracks", {
    schema: {
      tags: ["tracks"],
      summary: "Listado paginado de pistas: filtro por disco o por texto (título y alias).",
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(trackListItemSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listTracks(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/tracks/:id", {
    schema: {
      tags: ["tracks"],
      summary: "Ficha de una pista: contexto de disco y artista, alias propios y créditos.",
      params: idParamSchema,
      response: { 200: trackDetailSchema },
    },
  }, async (request) => {
    const track = await getTrackDetail(request.params.id);
    if (!track) throw await notFoundEntity("track", request.params.id);
    return track;
  });
}
