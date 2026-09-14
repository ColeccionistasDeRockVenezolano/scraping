// CRV · Escritura de alias por entidad (PHASES §E8): la interfaz necesita
// poder añadir, corregir y retirar variantes de nombre sin pasar por SQL.
// Ver justificación de no usar el merge/claims aquí en repositories/aliases.ts.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withOperatorRun } from "../../merge/operator.js";
import { ALIAS_SPECS, createAlias, deleteAlias, updateAlias, type AliasKind } from "../repositories/aliases.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { idParamSchema, writeErrorResponses } from "../schemas.js";
import { noteFrom, noteSchema, deleteQuerySchema } from "./catalog-writes.js";

const ALIAS_TYPES = ["name_variant", "spelling_variant", "former_name", "stage_name", "acronym", "misspelling", "alternate_title", "other"] as const;

const aliasSchema = z.object({
  id: z.number().int(),
  entityId: z.number().int(),
  alias: z.string(),
  aliasType: z.string(),
  isPrimary: z.boolean(),
});

const aliasWriteSchema = aliasSchema.extend({ runId: z.number().int() });

const createAliasBody = z.object({
  alias: z.string().trim().min(1),
  aliasType: z.enum(ALIAS_TYPES).default("name_variant"),
  isPrimary: z.boolean().default(false),
  note: noteSchema.optional(),
}).strict();

const updateAliasBody = z.object({
  alias: z.string().trim().min(1).optional(),
  aliasType: z.enum(ALIAS_TYPES).optional(),
  isPrimary: z.boolean().optional(),
  note: noteSchema.optional(),
}).strict();

const aliasParamsSchema = z.object({
  id: idParamSchema.shape.id,
  aliasId: idParamSchema.shape.id,
});

const ALIAS_ROUTES: ReadonlyArray<{ kind: AliasKind; path: string; label: string }> = [
  { kind: "artist", path: "/artists", label: "artista" },
  { kind: "person", path: "/persons", label: "persona" },
  { kind: "organization", path: "/organizations", label: "organización" },
  { kind: "album", path: "/albums", label: "álbum" },
  { kind: "track", path: "/tracks", label: "pista" },
];

export async function registerAliasRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  for (const route of ALIAS_ROUTES) {
    void ALIAS_SPECS[route.kind]; // valida en tiempo de compilación que el kind existe
    const tag = `${route.path.slice(1)}:write`;

    server.post(`${route.path}/:id/aliases`, {
      schema: {
        tags: [tag],
        summary: `Añade un alias a ${route.label}`,
        security: OPERATOR_SECURITY,
        params: idParamSchema,
        body: createAliasBody,
        response: { 201: aliasWriteSchema, ...writeErrorResponses },
      },
    }, async (request, reply) => {
      const body = request.body;
      const { runId, result } = await withOperatorRun({
        name: `api:create:${route.kind}_alias`, operator: request.operator, note: noteFrom(body, `alias nuevo de ${route.label} por la API`),
        params: { kind: route.kind, entityId: request.params.id, alias: body.alias, aliasType: body.aliasType, isPrimary: body.isPrimary },
      }, (context) => createAlias(context, route.kind, request.params.id, body));
      return reply.status(201).send({ ...result, runId });
    });

    server.patch(`${route.path}/:id/aliases/:aliasId`, {
      schema: {
        tags: [tag],
        summary: `Corrige un alias de ${route.label}`,
        security: OPERATOR_SECURITY,
        params: aliasParamsSchema,
        body: updateAliasBody,
        response: { 200: aliasWriteSchema, ...writeErrorResponses },
      },
    }, async (request) => {
      const body = request.body;
      const fields = {
        ...(body.alias === undefined ? {} : { alias: body.alias }),
        ...(body.aliasType === undefined ? {} : { aliasType: body.aliasType }),
        ...(body.isPrimary === undefined ? {} : { isPrimary: body.isPrimary }),
      };
      const { runId, result } = await withOperatorRun({
        name: `api:update:${route.kind}_alias`, operator: request.operator, note: noteFrom(body, `corrección de alias de ${route.label} por la API`),
        params: { kind: route.kind, entityId: request.params.id, aliasId: request.params.aliasId, ...fields },
      }, (context) => updateAlias(context, route.kind, request.params.id, request.params.aliasId, fields));
      return { ...result, runId };
    });

    server.delete(`${route.path}/:id/aliases/:aliasId`, {
      schema: {
        tags: [tag],
        summary: `Retira un alias de ${route.label}`,
        security: OPERATOR_SECURITY,
        params: aliasParamsSchema,
        querystring: deleteQuerySchema,
        response: { 200: z.object({ id: z.number().int(), entityId: z.number().int(), runId: z.number().int() }), ...writeErrorResponses },
      },
    }, async (request) => {
      const { runId } = await withOperatorRun({
        name: `api:delete:${route.kind}_alias`, operator: request.operator, note: noteFrom(request.query, `retiro de alias de ${route.label} por la API`),
        params: { kind: route.kind, entityId: request.params.id, aliasId: request.params.aliasId },
      }, (context) => deleteAlias(context, route.kind, request.params.id, request.params.aliasId));
      return { id: request.params.aliasId, entityId: request.params.id, runId };
    });
  }
}
