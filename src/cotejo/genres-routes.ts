// CRV · API de géneros de la Mesa de Cotejo (PLAN_GENEROS etapa 3).
//
// Lectura abierta (cola, ficha, vocabulario, métricas, lotes); escritura solo
// con sesión de administrador de herra (src/cotejo/auth.ts). Una escritura
// rechazada por la sesión no abre transacción: nada llega a la base.
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import { getPool } from "../db/client.js";
import {
  applyGenreBatch, BATCH_ACTIONS, batchMembers, decideGenre, GENRE_ACTIONS, genreEntityDetail, genreMetrics,
  GenreCurationError, genreVocabulary, listBatchGroups, listGenreQueue, QUEUE_CATEGORIES,
} from "../genres/curation.js";
import { CotejoAuthError, type CotejoAuth } from "./auth.js";

const kindSchema = z.enum(["album", "artist"]);
const reason = z.string().trim().min(3, "explica brevemente el motivo").max(1000);
const slug = z.string().trim().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/u).max(100);

const decisionBody = z.object({
  action: z.enum(GENRE_ACTIONS),
  kind: kindSchema,
  entityId: z.coerce.number().int().positive(),
  genreSlug: slug.optional(),
  reason,
  reviewIds: z.array(z.coerce.number().int().positive()).max(50).optional(),
  closeCases: z.boolean().optional(),
  proposedName: z.string().trim().min(2).max(100).optional(),
  familySlug: slug.optional(),
  rawValue: z.string().max(500).optional(),
  // Se acepta por compatibilidad y se IGNORA: el actor sale de la sesión.
  decidedBy: z.unknown().optional(),
}).strict();

const batchBody = z.object({
  action: z.enum(BATCH_ACTIONS),
  kind: kindSchema,
  rawValue: z.string().trim().min(1).max(500),
  genreSlug: slug.optional(),
  expectedReviewIds: z.array(z.coerce.number().int().positive()).min(1).max(200),
  reason,
  decidedBy: z.unknown().optional(),
}).strict();

const queueQuery = z.object({
  category: z.enum(QUEUE_CATEGORIES).optional(),
  kind: kindSchema.optional(),
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

async function withClient<T>(work: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();
  try {
    return await work(client);
  } finally {
    client.release();
  }
}

function send(reply: FastifyReply, error: unknown) {
  if (error instanceof CotejoAuthError) return reply.code(error.statusCode).send({ error: error.message, code: error.code });
  if (error instanceof z.ZodError) {
    return reply.code(400).send({ error: error.issues.map((issue) => `${issue.path.join(".") || "cuerpo"}: ${issue.message}`).join("; "), code: "bad_request" });
  }
  if (error instanceof GenreCurationError) {
    const status = error.code === "not_found" ? 404 : error.code === "conflict" ? 409 : 400;
    return reply.code(status).send({ error: error.message, code: error.code });
  }
  throw error;
}

export function registerGenreRoutes(app: FastifyInstance, auth: CotejoAuth): void {
  app.get("/api/genres/queue", async (request, reply) => {
    try {
      const query = queueQuery.parse(request.query ?? {});
      return await withClient((client) => listGenreQueue(client, {
        category: query.category, kind: query.kind, search: query.q, limit: query.limit ?? 50, offset: query.offset ?? 0,
      }));
    } catch (error) {
      return send(reply, error);
    }
  });

  app.get("/api/genres/entity/:kind/:id", async (request, reply) => {
    try {
      const params = z.object({ kind: kindSchema, id: z.coerce.number().int().positive() }).parse(request.params);
      const detail = await withClient((client) => genreEntityDetail(client, params.kind, params.id));
      if (!detail) return reply.code(404).send({ error: "ficha inexistente", code: "not_found" });
      return detail;
    } catch (error) {
      return send(reply, error);
    }
  });

  app.get("/api/genres/vocabulary", async () => ({ families: await withClient(genreVocabulary) }));
  app.get("/api/genres/metrics", async () => withClient(genreMetrics));
  app.get("/api/genres/batches", async () => ({ groups: await withClient(listBatchGroups) }));
  app.get("/api/genres/batches/members", async (request, reply) => {
    try {
      const query = z.object({ kind: kindSchema, rawValue: z.string().trim().min(1).max(500) }).parse(request.query ?? {});
      return { kind: query.kind, rawValue: query.rawValue, members: await withClient((client) => batchMembers(client, query.kind, query.rawValue)) };
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post("/api/genres/decisions", async (request, reply) => {
    try {
      // Primero la sesión: sin administrador no se valida ni se toca nada.
      const user = auth.requireAdmin(request);
      const body = decisionBody.parse(request.body ?? {});
      return await decideGenre({ ...body, actor: user.actor });
    } catch (error) {
      return send(reply, error);
    }
  });

  app.post("/api/genres/batch", async (request, reply) => {
    try {
      const user = auth.requireAdmin(request);
      const body = batchBody.parse(request.body ?? {});
      return await applyGenreBatch({ ...body, actor: user.actor });
    } catch (error) {
      return send(reply, error);
    }
  });
}
