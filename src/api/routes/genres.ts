// CRV · Géneros públicos para los filtros de las listas de discos y artistas:
// familias y subgéneros con cuántas fichas tienen cada uno (solo asignaciones
// confirmadas, PLAN_GENEROS §5) y cuántas no tienen género.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { genreFacets, type GenreFacets } from "../../genres/public.js";

const facetSchema = z.object({
  slug: z.string(),
  name: z.string(),
  count: z.number().int().describe("Fichas con este género confirmado; en una familia, también sus subgéneros."),
  relatedCount: z.number().int()
    .describe("Fichas sin género propio que entran por la relación (disco → su artista; artista → sus discos)."),
});

const facetsSchema = z.object({
  total: z.number().int(),
  withoutGenre: z.number().int().describe("Fichas sin ningún género confirmado."),
  families: z.array(facetSchema.extend({ genres: z.array(facetSchema) })),
});

/** Los conteos recorren todas las asignaciones: se recalculan como mucho cada minuto. */
const FACETS_TTL_MS = 60_000;

export async function registerGenreRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const cache = new Map<"album" | "artist", { at: number; value: Promise<GenreFacets> }>();

  function cachedFacets(kind: "album" | "artist"): Promise<GenreFacets> {
    const hit = cache.get(kind);
    if (hit && Date.now() - hit.at < FACETS_TTL_MS) return hit.value;
    const value = genreFacets(kind);
    cache.set(kind, { at: Date.now(), value });
    // Un fallo no se queda en caché: la siguiente petición lo reintenta.
    value.catch(() => { if (cache.get(kind)?.value === value) cache.delete(kind); });
    return value;
  }

  server.get("/genres/facets", {
    schema: {
      tags: ["genres"],
      querystring: z.object({ kind: z.enum(["album", "artist"]) }),
      response: { 200: facetsSchema },
    },
  }, async (request, reply) => {
    // Iguales para todos los visitantes y cambian poco: una caché corta basta.
    reply.header("cache-control", "public, max-age=120");
    return cachedFacets(request.query.kind);
  });
}
