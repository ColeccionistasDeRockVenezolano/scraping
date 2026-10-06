import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import {
  idParamSchema, aliasSchema, genreListFilterSchema, genreStatusSchema, paginatedResponseSchema, publicGenreSchema,
} from "../schemas.js";
import { getArtistDetail, listArtists } from "../repositories/artists.js";
import { RELATED_RULES, SIMILAR_RULES } from "../repositories/artist-neighbors.js";
import { notFoundEntity } from "../repositories/redirects.js";
import { layaDecidedIds } from "../../genres/public.js";
import { varyOnCookie } from "./albums.js";

const artistBaseSchema = z.object({
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

const artistListItemSchema = artistBaseSchema.extend({
  /** Solo con sesión iniciada: el género principal lo eligió Laya (o vino de discos cuyo único origen fue Laya). */
  genreByLaya: z.boolean().optional(),
});

const artistDetailSchema = artistBaseSchema.extend({
  biography: z.string().nullable(),
  logoUrl: z.string().nullable(),
  notes: z.string().nullable(),
  members: z.array(z.object({
    id: z.number().int(), personId: z.number().int(), personName: z.string(), personIsDeceased: z.boolean(), role: z.string(),
    // Fechas de la persona: la ficha de un proyecto solista las muestra como suyas.
    personBirthDate: z.string().nullable(), personDeathDate: z.string().nullable(),
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
  platforms: z.array(z.object({ platform: z.string(), url: z.string() }))
    .describe("Perfiles del artista en plataformas de escucha (Spotify, Apple Music, Deezer…); solo los de identidad verificada."),
  socials: z.array(z.object({ platform: z.string(), url: z.string(), handle: z.string().nullable() }))
    .describe("Redes sociales del artista (Instagram, Facebook, X, TikTok…); solo las de identidad verificada."),
  related: z.array(z.object({
    id: z.number().int(), name: z.string(), pictureUrl: z.string().nullable(), originCountry: z.string(),
    rule: z.enum(RELATED_RULES).describe("La regla más alta que cumple; las fichas llegan ordenadas por regla."),
    sharedMembers: z.number().int(), sharedMemberNames: z.array(z.string()),
    relations: z.array(z.object({
      type: z.enum(["successor", "ex_member_project", "temporary_name"]),
      direction: z.enum(["earlier", "later"]).describe("earlier: la otra banda es la de origen; later: la posterior."),
      bridgeMembers: z.string().nullable(), startYear: z.number().int().nullable(), endYear: z.number().int().nullable(),
      note: z.string().nullable(), sources: z.array(z.string()), confidence: z.string(),
    })).describe("Linaje documentado (ingest.artist_relations); vacío si no lo hay."),
    bridges: z.array(z.object({ person: z.string().nullable(), album: z.string().nullable() }))
      .describe("Persona puente y disco donde se ve (colaboración, invitado, composición); hasta tres."),
  })).describe("Por reglas en orden: linaje documentado, 2+ integrantes en común, proyecto solista de un integrante, un integrante en común, colaboración, integrante invitado, composición cruzada."),
  similarDecade: z.number().int().nullable().describe("Década de arranque (formación o primer disco)."),
  similar: z.array(z.object({
    id: z.number().int(), name: z.string(), pictureUrl: z.string().nullable(), originCountry: z.string(),
    startYear: z.number().int().nullable(),
    rule: z.enum(SIMILAR_RULES).describe("La regla que lo trajo; las fichas llegan ordenadas por regla."),
    evidence: z.array(z.string()).describe("Recopilaciones, productores, ciudad o sellos en común; vacío en las reglas de género."),
  })).describe("Por reglas en orden: mismo estilo y década, mismo género y década, misma recopilación, mismo productor, misma escena, década vecina, mismo sello, mismo género. Sin repetir los relacionados."),
});

const listQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).optional(),
  ...genreListFilterSchema,
  genre: genreListFilterSchema.genre.describe("Género del artista: el propio y los que recibe de sus discos (0036)."),
});

export async function registerArtistRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/artists", {
    schema: {
      tags: ["artists"],
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(artistListItemSchema) },
    },
  }, async (request, reply) => {
    const { rows, total } = await listArtists(request.query);
    varyOnCookie(reply);
    if (!request.viewer) return toPage(rows, total, request.query);
    // Con sesión la respuesta lleva datos de trabajo: nunca a una caché compartida.
    reply.header("cache-control", "private, no-store");
    const laya = await layaDecidedIds("artist", rows.map((row) => row.id));
    return toPage(rows.map((row) => ({ ...row, genreByLaya: laya.has(row.id) })), total, request.query);
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
