// CRV · Errores HTTP consistentes (ARCHITECTURE.md §4.14, PHASES §E7A/E7B).
// Toda ruta que falla de forma esperada lanza uno de estos; el resto de
// excepciones las homogeneiza el error handler global de app.ts.
import { OperatorError } from "../merge/operator.js";

export class ApiError extends Error {
  readonly statusCode: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export function notFound(entity: string, id: number | string, details?: Record<string, unknown>): ApiError {
  return new ApiError(404, "not_found", `${entity} inexistente: ${id}`, details);
}

export function badRequest(message: string): ApiError {
  return new ApiError(400, "bad_request", message);
}

const OPERATOR_STATUS: Readonly<Record<OperatorError["code"], number>> = {
  not_found: 404,
  already_exists: 409,
  needs_review: 409,
  has_dependents: 409,
  not_open: 409,
  invalid: 422,
};

// Restricciones del DDL que una escritura puede tocar. La API no las esquiva:
// las devuelve como error del cliente, con el mensaje de PostgreSQL (no
// contiene datos sensibles, solo la restricción y los valores de la fila).
const PG_STATUS: Readonly<Record<string, { status: number; code: string }>> = {
  "23505": { status: 409, code: "unique_violation" },
  "23503": { status: 409, code: "foreign_key_violation" },
  "23514": { status: 422, code: "check_violation" },
  "23502": { status: 422, code: "not_null_violation" },
  "22P02": { status: 422, code: "invalid_value" },
  "22007": { status: 422, code: "invalid_value" },
  "22008": { status: 422, code: "invalid_value" },
  "22003": { status: 422, code: "invalid_value" },
  "22001": { status: 422, code: "value_too_long" },
};

/** Traduce un fallo esperado (ruta, edición del operador o restricción de la base) a su forma HTTP. */
export function toApiError(error: unknown): ApiError | undefined {
  if (error instanceof ApiError) return error;
  if (error instanceof OperatorError) return new ApiError(OPERATOR_STATUS[error.code], error.code, error.message, error.details);
  const pg = error as { code?: unknown; detail?: unknown; constraint?: unknown; message?: unknown };
  if (typeof pg.code === "string" && PG_STATUS[pg.code]) {
    const mapped = PG_STATUS[pg.code]!;
    const message = typeof pg.detail === "string" && pg.detail ? pg.detail : String(pg.message);
    return new ApiError(mapped.status, mapped.code, message,
      typeof pg.constraint === "string" ? { constraint: pg.constraint } : undefined);
  }
  return undefined;
}
