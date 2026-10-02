// CRV · Esquemas Zod compartidos por las rutas de la API de lectura.
import { z } from "zod";

export const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.record(z.unknown()).optional(),
  }),
});

/** Respuestas de error de toda ruta de escritura (OpenAPI y serialización). */
export const writeErrorResponses = {
  400: errorResponseSchema,
  401: errorResponseSchema,
  403: errorResponseSchema,
  404: errorResponseSchema,
  409: errorResponseSchema,
  422: errorResponseSchema,
} as const;

export const searchEntityTypeSchema = z.enum(["artist", "person", "album", "track", "organization"]);
export type SearchEntityType = z.infer<typeof searchEntityTypeSchema>;

export const ALL_SEARCH_TYPES: readonly SearchEntityType[] = ["artist", "person", "album", "track", "organization"];

export const aliasSchema = z.object({
  id: z.number().int(),
  alias: z.string(),
  aliasType: z.string(),
  isPrimary: z.boolean(),
});

export function paginatedResponseSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    data: z.array(item),
    pagination: z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }),
  });
}


/** Género público (PLAN_GENEROS §5): solo asignaciones confirmadas. */
export const publicGenreSchema = z.object({
  id: z.number().int(),
  slug: z.string(),
  name: z.string(),
  family: z.string().describe("Slug de la familia; en una asignación directa a familia, el propio slug."),
});
export const genreStatusSchema = z.enum(["confirmed", "pending", "unclassified"]);
export const genreSlugQuerySchema = z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u)
  .describe("Slug de género o familia; una familia incluye sus géneros hijos.");
const queryFlagSchema = z.enum(["true", "false"]).transform((value) => value === "true");
/** Filtros por género compartidos por las listas de discos y artistas. */
export const genreListFilterSchema = {
  genre: genreSlugQuerySchema.optional(),
  withoutGenre: queryFlagSchema.optional().describe("Solo fichas sin ningún género confirmado."),
};
/** Solo discos: con `genre`, suma los discos sin género propio cuyo artista tiene ese género. */
export const relatedGenreQuerySchema = queryFlagSchema.optional()
  .describe("Con `genre`: suma los discos sin género propio cuyo artista tiene ese género (vista de búsqueda; no asigna nada).");
