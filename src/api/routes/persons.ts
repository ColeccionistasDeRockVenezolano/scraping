import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, aliasSchema, paginatedResponseSchema, writeErrorResponses } from "../schemas.js";
import { getPersonDetail, listPersons } from "../repositories/persons.js";
import { notFoundEntity } from "../repositories/redirects.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { noteSchema } from "./catalog-writes.js";
import { withOperatorRun } from "../../merge/operator.js";
import { previewPersonSplit, splitPerson } from "../../review/person-corrections.js";
import { getPool } from "../../db/client.js";

const personListItemSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  nationality: z.string().nullable(),
  isVenezuelan: z.boolean(),
  pictureUrl: z.string().nullable(),
  creditCount: z.number().int().describe("Créditos de disco y de pista."),
  bandCount: z.number().int().describe("Membresías de banda."),
  nameClass: z.enum(["ok", "organization_like", "duration", "fragment", "multiple_people"])
    .describe("Clasificación del nombre (E11.7): si no es `ok`, la web ofrece convertir o dividir."),
  nameClassReason: z.string().describe("Por qué el nombre no parece de una persona; vacío si es `ok`."),
});

const personDetailSchema = personListItemSchema.extend({
  biography: z.string().nullable(),
  birthDate: z.string().nullable(),
  deathDate: z.string().nullable(),
  notes: z.string().nullable(),
  bands: z.array(z.object({
    id: z.number().int(), artistId: z.number().int(), artistName: z.string(), role: z.string(),
    fromYear: z.number().int().nullable(), toYear: z.number().int().nullable(), isCurrent: z.boolean(),
  })),
  albumCredits: z.array(z.object({
    id: z.number().int(), albumId: z.number().int(), albumTitle: z.string(), artistId: z.number().int(), artistName: z.string(),
    creditType: z.string(), role: z.string(),
  })),
  trackCredits: z.array(z.object({
    id: z.number().int(), trackId: z.number().int(), trackTitle: z.string(), albumId: z.number().int(), albumTitle: z.string(),
    creditType: z.string(), role: z.string(),
  })),
  organizations: z.array(z.object({
    id: z.number().int(), organizationId: z.number().int(), organizationName: z.string(), role: z.string(),
    fromYear: z.number().int().nullable(), toYear: z.number().int().nullable(),
  })),
  aliases: z.array(aliasSchema),
});

const listQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).optional().describe("Busca también sin tildes ni mayúsculas (índice en memoria, E11.9)."),
  hasCredits: z.enum(["true", "false"]).transform((value) => value === "true").optional()
    .describe("false: solo fichas sin crédito ni membresía."),
  suspect: z.enum(["organization_like", "duration", "fragment", "multiple_people"]).optional()
    .describe("Filtra nombres sospechosos (E11.7)."),
  sort: z.enum(["name", "credits"]).default("name").describe("credits: créditos + membresías, descendente."),
});


const splitPreviewQuerySchema = z.object({
  into: z.string().describe("Lista de nombres separados por coma en los que se divide la persona."),
});

const splitPreviewResponseSchema = z.object({
  person: z.object({ id: z.number().int(), name: z.string() }),
  into: z.array(z.string()),
  targets: z.array(z.object({ name: z.string(), existingId: z.number().int().nullable() })),
  counts: z.object({ albumCredits: z.number().int(), trackCredits: z.number().int(), memberships: z.number().int(), organizations: z.number().int() }),
  warnings: z.array(z.string()),
});

const splitBodySchema = z.object({
  into: z.array(z.string().trim().min(1)).min(2).describe("Nombres en los que se divide la persona combinada."),
  note: noteSchema.describe("Motivo obligatorio: queda en el run, en la auditoría y en el claim."),
}).strict();

const splitResultSchema = z.object({
  op: z.literal("split"),
  status: z.enum(["applied", "skipped"]),
  detail: z.string(),
  credits: z.number().int(),
  targetIds: z.array(z.number().int()),
  runId: z.number().int(),
});

export async function registerPersonRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/persons", {
    schema: {
      tags: ["persons"],
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(personListItemSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listPersons(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/persons/:id", {
    schema: {
      tags: ["persons"],
      params: idParamSchema,
      response: { 200: personDetailSchema },
    },
  }, async (request) => {
    const detail = await getPersonDetail(request.params.id);
    if (!detail) throw await notFoundEntity("person", request.params.id);
    return detail;
  });

  server.get("/persons/:id/split-preview", {
    schema: {
      tags: ["persons:merge"],
      summary: "Previsualiza la división de una persona en varias: destinos y créditos a repartir.",
      params: idParamSchema,
      querystring: splitPreviewQuerySchema,
      response: { 200: splitPreviewResponseSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const into = request.query.into.split(",").map((item) => item.trim()).filter(Boolean);
    const client = await getPool().connect();
    try {
      return await previewPersonSplit(client, request.params.id, into);
    } finally {
      client.release();
    }
  });

  server.post("/persons/:id/split", {
    schema: {
      tags: ["persons:merge"],
      summary: "Divide una persona combinada en varias: reparte trayectoria y créditos y retira la fila original.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: splitBodySchema,
      response: { 200: splitResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const personId = request.params.id;
    const body = request.body;
    const { runId, result } = await withOperatorRun({
      name: "api:split:person",
      operator: request.operator,
      note: body.note,
      params: { personId, into: body.into },
    }, async (context) => {
      return splitPerson(context.client, personId, body.into, context.note, context.runId);
    });
    return { ...result, runId };
  });
}
