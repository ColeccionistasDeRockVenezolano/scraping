import { describe, expect, it } from "vitest";
import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, paginationQuerySchema, toPage } from "../../src/api/pagination.js";

// Auditoría de pruebas #8: la paginación común de la API (defecto, tope y
// rechazo de límites absurdos) no tenía pruebas propias; cada ruta la hereda.
describe("paginación de la API", () => {
  it("aplica el tamaño por defecto y acepta valores explícitos", () => {
    expect(paginationQuerySchema.parse({})).toEqual({ limit: DEFAULT_PAGE_SIZE, offset: 0 });
    expect(paginationQuerySchema.parse({ limit: String(MAX_PAGE_SIZE), offset: "20" })).toEqual({ limit: MAX_PAGE_SIZE, offset: 20 });
  });

  it("rechaza limit fuera de rango, offset negativo y valores no numéricos", () => {
    expect(paginationQuerySchema.safeParse({ limit: MAX_PAGE_SIZE + 1 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: -5 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ offset: -1 }).success).toBe(false);
    expect(paginationQuerySchema.safeParse({ limit: "no-numero" }).success).toBe(false);
  });

  it("toPage arma la respuesta con el limit/offset que se pidió", () => {
    expect(toPage([1, 2], 7, { limit: 2, offset: 2 })).toEqual({
      data: [1, 2],
      pagination: { limit: 2, offset: 2, total: 7 },
    });
  });
});
