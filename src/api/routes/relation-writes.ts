// CRV · Escritura de las filas puente del core (PHASES §E7B): miembros,
// persona-organización, créditos de álbum y de pista, y formatos. Los extremos
// se eligen por id; el puente de relaciones los verifica y escribe la fila.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { RelationEndpoints } from "../../claims/persistence.js";
import { createRelation, deleteRelation, updateRelation, withOperatorRun } from "../../merge/operator.js";
import { CREDIT_TYPES, type RelationClaimKind } from "../../merge/relations.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { badRequest } from "../http-errors.js";
import { idParamSchema, writeErrorResponses } from "../schemas.js";
import { deleteQuerySchema, noteFrom, noteSchema, removalSchema, text, toSnake, year } from "./catalog-writes.js";

type Body = Record<string, unknown>;
type RelationValues = Record<string, string | number | boolean | null | undefined>;

const entityId = z.number().int().positive();
const notes = z.string().trim().min(1).max(2000).nullable();
const creditType = z.enum(CREDIT_TYPES);
const quality = z.enum(["HQ", "LQ", "unknown"]);
const archiveStatus = z.enum(["published", "unpublished", "unknown"]);

interface RelationRoute {
  kind: RelationClaimKind;
  path: string;
  label: string;
  create: z.ZodRawShape;
  update: z.ZodRawShape;
  endpoints(body: Body): RelationEndpoints;
  values(body: Body): RelationValues;
  /** Validación que Zod no expresa sin romper el esquema OpenAPI. */
  check?(body: Body): void;
  /** Igual que `check`, sobre el cuerpo parcial de un PATCH. */
  checkUpdate?(body: Body): void;
}

const pick = (body: Body, key: string): number | undefined => (typeof body[key] === "number" ? body[key] : undefined);
const endpointsOf = (body: Body, keys: ReadonlyArray<keyof RelationEndpoints>): RelationEndpoints =>
  Object.fromEntries(keys.flatMap((key) => (pick(body, key) === undefined ? [] : [[key, pick(body, key)]])));
const valueOf = (body: Body, key: string) => body[key] as string | number | boolean | null | undefined;

function exactlyOneCredited(body: Body): void {
  const given = ["personId", "artistId", "organizationId"].filter((key) => body[key] !== undefined);
  if (given.length !== 1) throw badRequest("un crédito acredita exactamente a uno de personId, artistId u organizationId");
}

/** En un PATCH, reapuntar el acreditado: si se da alguno, exactamente uno. */
function atMostOneCreditTarget(body: Body): void {
  const given = ["personId", "artistId", "organizationId"].filter((key) => body[key] !== undefined);
  if (given.length > 1) throw badRequest("un crédito acredita exactamente a uno de personId, artistId u organizationId");
}

const creditCreate = {
  personId: entityId.optional(), artistId: entityId.optional(), organizationId: entityId.optional(),
  role: text(200), creditType: creditType.optional()
    .describe("Si falta, se clasifica el rol con las reglas del puente (guitarra → musician, mezcla → mixing...)."),
  notes: notes.optional(),
};
/** Reapuntar el acreditado: como en el alta, exactamente uno de los tres extremos. */
const creditTargetUpdate = {
  personId: entityId.optional().describe("Nuevo acreditado (persona). Sustituye al anterior con auditoría."),
  artistId: entityId.optional().describe("Nuevo acreditado (artista). Sustituye al anterior con auditoría."),
  organizationId: entityId.optional().describe("Nuevo acreditado (organización). Sustituye al anterior con auditoría."),
};
const creditUpdate = { role: text(200), creditType, notes, ...creditTargetUpdate };
const creditValues = (body: Body): RelationValues => ({
  credit_role: valueOf(body, "role"), credit_type: valueOf(body, "creditType"), notes: valueOf(body, "notes"),
});

const RELATION_ROUTES: readonly RelationRoute[] = [
  {
    kind: "artist_membership", path: "/artist-members", label: "miembro de artista",
    create: {
      artistId: entityId, personId: entityId, role: text(200),
      fromYear: year.nullable().optional(), toYear: year.nullable().optional(), isCurrent: z.boolean().optional(), notes: notes.optional(),
    },
    update: {
      role: text(200), fromYear: year.nullable(), toYear: year.nullable(), isCurrent: z.boolean(), notes,
      personId: entityId.optional().describe("Nueva persona de la membresía. Sustituye a la anterior con auditoría."),
    },
    endpoints: (body) => endpointsOf(body, ["artistId", "personId"]),
    values: (body) => ({
      role: valueOf(body, "role"), from_year: valueOf(body, "fromYear"), to_year: valueOf(body, "toYear"),
      is_current: valueOf(body, "isCurrent"), notes: valueOf(body, "notes"),
    }),
  },
  {
    kind: "person_organization", path: "/person-organizations", label: "persona en organización",
    create: {
      personId: entityId, organizationId: entityId, role: text(200),
      fromYear: year.nullable().optional(), toYear: year.nullable().optional(), notes: notes.optional(),
    },
    update: {
      role: text(200), fromYear: year.nullable(), toYear: year.nullable(), notes,
      personId: entityId.optional().describe("Nueva persona del vínculo. Sustituye a la anterior con auditoría."),
      organizationId: entityId.optional().describe("Nueva organización del vínculo. Sustituye a la anterior con auditoría."),
    },
    endpoints: (body) => endpointsOf(body, ["personId", "organizationId"]),
    values: (body) => ({
      role: valueOf(body, "role"), from_year: valueOf(body, "fromYear"), to_year: valueOf(body, "toYear"), notes: valueOf(body, "notes"),
    }),
  },
  {
    kind: "album_credit", path: "/album-credits", label: "crédito de álbum",
    create: { albumId: entityId, ...creditCreate },
    update: creditUpdate,
    endpoints: (body) => endpointsOf(body, ["albumId", "personId", "artistId", "organizationId"]),
    values: creditValues,
    check: exactlyOneCredited,
    checkUpdate: atMostOneCreditTarget,
  },
  {
    kind: "track_credit", path: "/track-credits", label: "crédito de pista",
    create: { trackId: entityId, ...creditCreate },
    update: creditUpdate,
    endpoints: (body) => endpointsOf(body, ["trackId", "personId", "artistId", "organizationId"]),
    values: creditValues,
    check: exactlyOneCredited,
    checkUpdate: atMostOneCreditTarget,
  },
  {
    kind: "album_format", path: "/album-formats", label: "formato de álbum",
    create: {
      albumId: entityId, format: text(50), quality: quality.nullable().optional(), archiveStatus: archiveStatus.optional(),
      filePath: text(2000).nullable().optional(), notes: notes.optional(),
    },
    update: { format: text(50), quality: quality.nullable(), archiveStatus, filePath: text(2000).nullable(), notes },
    endpoints: (body) => endpointsOf(body, ["albumId"]),
    values: (body) => ({
      format: valueOf(body, "format"), quality: valueOf(body, "quality"), archive_status: valueOf(body, "archiveStatus"),
      file_path: valueOf(body, "filePath"), notes: valueOf(body, "notes"),
    }),
  },
];

const relationWriteSchema = z.object({
  kind: z.string(), id: z.number().int(), runId: z.number().int(),
  created: z.boolean().describe("false: la misma relación ya estaba registrada y se devuelve la existente"),
});

const relationUpdateSchema = z.object({
  kind: z.string(), id: z.number().int(), runId: z.number().int(),
  fields: z.array(z.object({ field: z.string(), action: z.enum(["corrected", "unchanged"]) })),
});

export async function registerRelationWriteRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  for (const route of RELATION_ROUTES) {
    const tag = `${route.path.slice(1)}:write`;

    server.post(route.path, {
      schema: {
        tags: [tag],
        summary: `Registra ${route.label} (extremos por id, a través del puente de relaciones)`,
        security: OPERATOR_SECURITY,
        body: z.object(route.create).extend({ note: noteSchema.optional() }).strict(),
        response: { 200: relationWriteSchema, 201: relationWriteSchema, ...writeErrorResponses },
      },
    }, async (request, reply) => {
      const body = request.body as Body;
      route.check?.(body);
      const endpoints = route.endpoints(body);
      const values = route.values(body);
      const { runId, result } = await withOperatorRun({
        name: `api:create:${route.kind}`, operator: request.operator, note: noteFrom(body, `alta de ${route.label} por la API`),
        params: { kind: route.kind, endpoints, values },
      }, (context) => createRelation(context, route.kind, endpoints, values));
      return reply.status(result.created ? 201 : 200).send({ ...result, runId });
    });

    server.patch(`${route.path}/:id`, {
      schema: {
        tags: [tag],
        summary: `Corrige ${route.label}; el valor anterior queda en merge_audit`,
        security: OPERATOR_SECURITY,
        params: idParamSchema,
        body: z.object(route.update).partial().extend({ note: noteSchema.optional() }).strict(),
        response: { 200: relationUpdateSchema, ...writeErrorResponses },
      },
    }, async (request) => {
      const body = request.body as Body;
      route.checkUpdate?.(body);
      const values = Object.fromEntries(Object.entries(body)
        .filter(([key, value]) => key !== "note" && value !== undefined)
        .map(([key, value]) => [toSnake(key), value]));
      const { runId, result } = await withOperatorRun({
        name: `api:update:${route.kind}`, operator: request.operator, note: noteFrom(body, `corrección de ${route.label} por la API`),
        params: { kind: route.kind, id: request.params.id, values },
      }, (context) => updateRelation(context, route.kind, request.params.id, values));
      return { ...result, runId };
    });

    server.delete(`${route.path}/:id`, {
      schema: {
        tags: [tag],
        summary: `Retira ${route.label}; su historia pasa a la ficha de la que colgaba`,
        security: OPERATOR_SECURITY,
        params: idParamSchema,
        querystring: deleteQuerySchema,
        response: { 200: removalSchema, ...writeErrorResponses },
      },
    }, async (request) => {
      const { runId, result } = await withOperatorRun({
        name: `api:delete:${route.kind}`, operator: request.operator, note: noteFrom(request.query, `retiro de ${route.label} por la API`),
        params: { kind: route.kind, id: request.params.id },
      }, (context) => deleteRelation(context, route.kind, request.params.id));
      return { kind: result.kind, id: result.id, runId, claimsRejected: result.claimsRejected, parentAuditId: result.parentAuditId ?? null };
    });
  }
}
