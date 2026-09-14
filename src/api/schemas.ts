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

