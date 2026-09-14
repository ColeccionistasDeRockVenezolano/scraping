// CRV · Autenticación local del operador (ARCHITECTURE §4.14, PHASES §E7B).
//
// Lectura abierta, escritura con token. No hay usuarios públicos: el token es
// uno solo, del operador del catálogo, y viaja como `Authorization: Bearer`.
// Sin CRV_OPERATOR_TOKEN la API queda en solo lectura. La cabecera opcional
// `X-CRV-Operator` firma las decisiones con un nombre (como en la Mesa, donde
// cada persona se identifica al entrar); el token nunca se registra.
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { getEnv } from "../config/env.js";
import { ApiError } from "./http-errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Nombre con que se firman las escrituras de esta petición. */
    operator: string;
  }
}

export const OPERATOR_SECURITY = [{ operatorToken: [] }];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const OPERATOR_NAME = /^[\p{L}\p{N} ._'-]{1,80}$/u;

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  const match = /^Bearer\s+(.+)$/iu.exec(header.trim());
  return match?.[1];
}

export async function registerOperatorAuth(app: FastifyInstance): Promise<void> {
  app.decorateRequest("operator", "");
  app.addHook("onRequest", async (request) => {
    if (READ_METHODS.has(request.method)) return;
    const env = getEnv();
    const expected = env.CRV_OPERATOR_TOKEN;
    if (!expected) {
      throw new ApiError(403, "writes_disabled", "escritura deshabilitada: el servidor no tiene CRV_OPERATOR_TOKEN");
    }
    const given = bearer(request);
    // Se comparan digests de igual longitud: timingSafeEqual no filtra por tiempo cuánto del token acertó.
    if (given === undefined || !timingSafeEqual(digest(given), digest(expected))) {
      throw new ApiError(401, "unauthorized", "token de operador ausente o inválido");
    }
    const declared = request.headers["x-crv-operator"];
    const name = typeof declared === "string" ? declared.trim() : "";
    if (name && !OPERATOR_NAME.test(name)) {
      throw new ApiError(400, "bad_request", "X-CRV-Operator admite letras, números, espacios y . _ ' - (máx. 80)");
    }
    request.operator = name || env.CRV_OPERATOR_NAME;
  });
}
