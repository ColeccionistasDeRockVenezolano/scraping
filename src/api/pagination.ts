// CRV · Paginación común de la API de lectura (PHASES §E7A: "paginación").
// limit/offset simple: los catálogos actuales (miles, no millones, de filas
// por tabla — ver docs/PHASES.md "Cierre F2–F5") no requieren cursor.
import { z } from "zod";

export const MAX_PAGE_SIZE = 200;
export const DEFAULT_PAGE_SIZE = 50;

export const paginationQuerySchema = z.object({
  limit: z.coerce.number().int().positive().max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  offset: z.coerce.number().int().nonnegative().default(0),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export interface Page<T> {
  data: T[];
  pagination: { limit: number; offset: number; total: number };
}

export function toPage<T>(data: T[], total: number, query: PaginationQuery): Page<T> {
  return { data, pagination: { limit: query.limit, offset: query.offset, total } };
}
