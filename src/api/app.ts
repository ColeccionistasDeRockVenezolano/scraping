// CRV · API Fastify (ARCHITECTURE.md §4.14, PHASES §E7A lectura + §E7B escritura).
// Browser -> API -> PostgreSQL (CONTRACT #20): esta app es el único punto
// por el que el navegador puede llegar a los datos. La lectura es abierta; la
// escritura exige el token del operador y pasa por el merge engine como
// claims human/high (src/merge/operator.ts), nunca por SQL en los controllers.
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import {
  serializerCompiler,
  validatorCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { moduleLogger } from "../logger/index.js";
import { getEnv } from "../config/env.js";
import { toApiError } from "./http-errors.js";
import { registerOperatorAuth } from "./auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerArtistRoutes } from "./routes/artists.js";
import { registerAlbumRoutes } from "./routes/albums.js";
import { registerPersonRoutes } from "./routes/persons.js";
import { registerOrganizationRoutes } from "./routes/organizations.js";
import { registerSourceRoutes } from "./routes/sources.js";
import { registerReviewRoutes } from "./routes/review-queue.js";
import { registerYouTubeRoutes } from "./routes/youtube.js";
import { registerCatalogWriteRoutes } from "./routes/catalog-writes.js";
import { registerRelationWriteRoutes } from "./routes/relation-writes.js";
import { registerAliasRoutes } from "./routes/aliases.js";
import { registerAuditRoutes } from "./routes/audit.js";

const log = moduleLogger("api");

export async function buildApp(): Promise<FastifyInstance> {
  // Fastify trae Pino integrado (ARCHITECTURE.md §6: "JSON a stdout"); no se
  // inyecta la instancia propia de src/logger para evitar el desajuste de
  // tipos entre FastifyBaseLogger y pino.Logger bajo exactOptionalPropertyTypes.
  // El serializador por defecto de `req` no incluye cabeceras: el token no llega a los logs.
  const app = Fastify({
    logger: {
      level: getEnv().LOG_LEVEL,
      redact: {
        paths: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
        censor: "[REDACTED]",
      },
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(cors, { origin: true });

  await app.register(swagger, {
    openapi: {
      info: {
        title: "Coleccionistas de Rock Venezolano — API",
        description: "Catálogo: lectura abierta (PHASES §E7A) y escritura del operador a través del merge engine (§E7B). "
          + "El navegador nunca conecta a PostgreSQL directamente.",
        version: "0.2.0",
      },
      components: {
        securitySchemes: {
          operatorToken: {
            type: "http",
            scheme: "bearer",
            description: "CRV_OPERATOR_TOKEN. Cabecera opcional X-CRV-Operator para firmar con un nombre.",
          },
        },
      },
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: "/docs" });

  app.setErrorHandler((error: Error, _request, reply) => {
    const expected = toApiError(error);
    if (expected) {
      reply.status(expected.statusCode).send({
        error: { code: expected.code, message: expected.message, ...(expected.details === undefined ? {} : { details: expected.details }) },
      });
      return;
    }
    // Errores de validación Zod ya vienen serializados por fastify-type-provider-zod
    // con statusCode; el resto es un fallo real que se registra y no se disfraza.
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode !== undefined && statusCode < 500) {
      reply.status(statusCode).send({ error: { code: "bad_request", message: error.message } });
      return;
    }
    log.error({ err: error }, "error no controlado en la API");
    reply.status(500).send({ error: { code: "internal_error", message: "error interno" } });
  });

  app.setNotFoundHandler((request, reply) => {
    reply.status(404).send({ error: { code: "not_found", message: `ruta inexistente: ${request.method} ${request.url}` } });
  });

  await registerOperatorAuth(app);
  await registerHealthRoutes(app);
  await registerSearchRoutes(app);
  await registerArtistRoutes(app);
  await registerAlbumRoutes(app);
  await registerPersonRoutes(app);
  await registerOrganizationRoutes(app);
  await registerSourceRoutes(app);
  await registerReviewRoutes(app);
  await registerYouTubeRoutes(app);
  await registerCatalogWriteRoutes(app);
  await registerRelationWriteRoutes(app);
  await registerAliasRoutes(app);
  await registerAuditRoutes(app);

  return app;
}
