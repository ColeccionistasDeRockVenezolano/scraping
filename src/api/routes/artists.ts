import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import {
  idParamSchema, aliasSchema, genreSlugQuerySchema, genreStatusSchema, paginatedResponseSchema, publicGenreSchema,
} from "../schemas.js";
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
  isDeceased: z.boolean().describe("Su proyecto es de una persona fallecida (titular o único integrante)."),
  primaryGenre: publicGenreSchema.nullable(),
  genreStatus: genreStatusSchema,
});

const artistDetailSchema = artistListItemSchema.extend({
  biography: z.string().nullable(),
  notes: z.string().nullable(),
  members: z.array(z.object({
    id: z.number().int(), personId: z.number().int(), personName: z.string(), personIsDeceased: z.boolean(), role: z.string(),
    fromYear: z.number().int().nullable(), toYear: z.number().int().nullable(), isCurrent: z.boolean(),
  })),
  discography: z.array(z.object({
    albumId: z.number().int(), title: z.string(), releaseYear: z.number().int().nullable(),
    albumType: z.string(), coverUrl: z.string().nullable(),
  })),
  aliases: z.array(aliasSchema),
  genres: z.array(publicGenreSchema),
  lastLabel: z.object({ id: z.number().int(), name: z.string() }).nullable()
    .describe("Sello del disco más reciente que lo declara (derivado)."),
  links: z.array(z.object({
    platform: z.enum(["youtube", "instagram", "wordpress"]), url: z.string(), albumId: z.number().int(), albumTitle: z.string(),
  })).describe("Enlaces públicos de sus discos."),
  related: z.array(z.object({
    id: z.number().int(), name: z.string(), pictureUrl: z.string().nullable(), originCountry: z.string(),
    sharedMembers: z.number().int(), sharedMemberNames: z.array(z.string()),
  })).describe("Bandas con dos o más integrantes en común (membresías)."),
  similarDecade: z.number().int().nullable().describe("Década de arranque (formación o primer disco)."),
  similar: z.array(z.object({
    id: z.number().int(), name: z.string(), pictureUrl: z.string().nullable(), originCountry: z.string(),
    startYear: z.number().int().nullable(),
  })).describe("Mismo género principal y misma década de arranque; sin año, solo el género."),
});

const listQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).optional(),
  genre: genreSlugQuerySchema.optional().describe("Género propio del artista (no el de sus discos)."),
});

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
