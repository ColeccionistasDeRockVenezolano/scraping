import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, paginatedResponseSchema } from "../schemas.js";
import { getVideoDetail, listVideos } from "../repositories/youtube.js";
import { notFound } from "../http-errors.js";

const videoListItemSchema = z.object({
  id: z.number().int(),
  videoId: z.string(),
  title: z.string().nullable(),
  channelTitle: z.string().nullable(),
  publishedAt: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  publicationStatus: z.string(),
});

const videoDetailSchema = z.object({
  id: z.number().int(),
  videoId: z.string(),
  url: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  channelId: z.string().nullable(),
  channelTitle: z.string().nullable(),
  publishedAt: z.string().nullable(),
  durationSeconds: z.number().int().nullable(),
  thumbnailUrl: z.string().nullable(),
  publicationStatus: z.string(),
  artists: z.array(z.object({
    artistId: z.number().int(), artistName: z.string(), relationKind: z.string(), confidence: z.string(),
  })),
  albums: z.array(z.object({
    albumId: z.number().int(), title: z.string(), albumKind: z.string(),
    isPrimaryLink: z.boolean(), confidence: z.string(),
  })),
  tracks: z.array(z.object({
    trackId: z.number().int(), title: z.string(), albumId: z.number().int(), albumTitle: z.string(),
    startSeconds: z.number().int(), endSeconds: z.number().int().nullable(), confidence: z.string(),
  })),
});

const listQuerySchema = paginationQuerySchema.extend({ q: z.string().trim().min(1).optional() });

export async function registerYouTubeRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/youtube/videos", {
    schema: {
      tags: ["youtube"],
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(videoListItemSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listVideos(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/youtube/videos/:id", {
    schema: {
      tags: ["youtube"],
      summary: "Video con sus enlaces a artista/disco/pistas.",
      params: idParamSchema,
      response: { 200: videoDetailSchema },
    },
  }, async (request) => {
    const detail = await getVideoDetail(request.params.id);
    if (!detail) throw notFound("youtube_video", request.params.id);
    return detail;
  });
}
