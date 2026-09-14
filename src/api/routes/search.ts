import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { ALL_SEARCH_TYPES, searchEntityTypeSchema } from "../schemas.js";
import { globalSearch } from "../repositories/search.js";
import { badRequest } from "../http-errors.js";

const searchHitSchema = z.object({
  type: searchEntityTypeSchema,
  id: z.number().int(),
  label: z.string(),
  context: z.string().nullable(),
  albumId: z.number().int().nullable(),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(1, "q es obligatorio"),
  types: z.string().optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
});

export async function registerSearchRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/search", {
    schema: {
      tags: ["search"],
      summary: "Búsqueda global (artista, persona, disco, pista, organización); los alias participan.",
      querystring: searchQuerySchema,
      response: {
        200: z.object({
          artist: z.array(searchHitSchema),
          person: z.array(searchHitSchema),
          album: z.array(searchHitSchema),
          track: z.array(searchHitSchema),
          organization: z.array(searchHitSchema),
        }),
      },
    },
  }, async (request) => {
    const { q, types, limit } = request.query;
    const requestedTypes = types
      ? types.split(",").map((value) => value.trim()).filter(Boolean)
      : undefined;
    if (requestedTypes) {
      for (const value of requestedTypes) {
        if (!searchEntityTypeSchema.safeParse(value).success) {
          throw badRequest(`tipo de búsqueda desconocido: ${value} (válidos: ${ALL_SEARCH_TYPES.join(", ")})`);
        }
      }
    }
    return globalSearch(q, limit, (requestedTypes as typeof ALL_SEARCH_TYPES | undefined) ?? ALL_SEARCH_TYPES);
  });
}
