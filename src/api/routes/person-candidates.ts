// CRV · Candidatos de duplicado de persona en la API (PHASES E11.5; plan P10).
//
// Lista de solo lectura de las revisiones vivas `person_duplicate`: el par,
// sus créditos, el score y las features con que el detector lo propuso. La
// decisión (fusionar o «son distintas») se toma en la ficha o en la cola.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { listPersonDuplicateCandidates } from "../repositories/persons.js";

export const personDuplicateCandidateSchema = z.object({
  reviewId: z.number().int(),
  a: z.object({ id: z.number().int(), name: z.string(), creditCount: z.number().int() }),
  b: z.object({ id: z.number().int(), name: z.string(), creditCount: z.number().int() }),
  priority: z.number().int(),
  score: z.number().nullable(),
  features: z.array(z.object({ key: z.string(), value: z.number(), evidence: z.string() })),
  notes: z.string().nullable(),
  createdAt: z.string(),
});

const listQuerySchema = paginationQuerySchema.extend({
  minScore: z.coerce.number().min(0).max(1).optional(),
});

export async function registerPersonCandidateRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/persons/duplicate-candidates", {
    schema: {
      tags: ["persons:merge"],
      summary: "Pares de personas que el detector propone revisar, con score y features. Solo lectura.",
      querystring: listQuerySchema,
      response: { 200: z.object({
        data: z.array(personDuplicateCandidateSchema),
        pagination: z.object({ limit: z.number().int(), offset: z.number().int(), total: z.number().int() }),
      }) },
    },
  }, async (request) => {
    const { rows, total } = await listPersonDuplicateCandidates(request.query);
    return toPage(rows, total, request.query);
  });
}
