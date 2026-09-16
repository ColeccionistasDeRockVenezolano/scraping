// CRV · API de fusión de fichas (PHASES E11.4; generalizada a organizaciones y
// artistas en E11.10; plan P2).
//
// Dos pasos, como el flujo que decidió el propietario:
//   GET  /<entidad>/:id/merge-preview?with=<dropId>   previsualización y hash
//   POST /<entidad>/:id/merge                         la fusión, con run del operador
//
// El POST no escribe el core por su cuenta: pasa por `withOperatorRun` y el
// servicio `mergeEntities` (claims humanos, auditoría y una sola transacción).
// La previsualización es una lectura —no escribe nada— y por eso sigue la regla
// del proyecto (lectura abierta, escritura con credenciales).
//
// Las tres entidades comparten las mismas rutas y esquemas; lo que cambia por
// kind (campos comparables, etiqueta y prefijo) sale de `MERGE_FIELDS`, que a su
// vez sale de los specs de entidad: una sola lista de campos por entidad.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { MERGE_FIELDS, mergeEntities, previewEntityMerge, type MergeableKind } from "../../merge/entity-merge.js";
import { createEntity, withOperatorRun } from "../../merge/operator.js";
import { convertPerson } from "../../review/person-corrections.js";
import { getPool } from "../../db/client.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { idParamSchema, writeErrorResponses } from "../schemas.js";
import { artistTypeSchema, noteSchema, organizationTypeSchema, text, toSnake } from "./catalog-writes.js";

/** Las fichas navegables con fusión con previsualización, con su ruta y su etiqueta. */
const KINDS = [
  { kind: "person", path: "persons", noun: "la persona", tag: "persons:merge" },
  { kind: "organization", path: "organizations", noun: "la organización", tag: "organizations:merge" },
  { kind: "artist", path: "artists", noun: "el artista", tag: "artists:merge" },
] as const satisfies ReadonlyArray<{ kind: MergeableKind; path: string; noun: string; tag: string }>;

/** `birth_date` → `birthDate`: el cuerpo de la API va en camelCase. */
const toCamel = (field: string): string => field.replace(/_([a-z])/gu, (_match, letter: string) => letter.toUpperCase());

const sideSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  fields: z.record(z.string(), z.unknown()),
  aliases: z.array(z.string()),
  counts: z.object({
    bands: z.number().int(), albumCredits: z.number().int(), trackCredits: z.number().int(),
    organizations: z.number().int(), claims: z.number().int(),
  }),
});

const previewQuerySchema = z.object({
  with: z.coerce.number().int().positive().describe("Id de la ficha que desaparecería (drop)."),
});

/** Alta implícita de la conversión: usa los mismos tipos que POST /organizations y /artists. */
const convertCreateSchema = z.object({
  name: text(200),
  organizationType: organizationTypeSchema.optional(),
  artistType: artistTypeSchema.optional(),
}).strict();

const convertBodySchema = z.object({
  to: z.enum(["organization", "artist"]),
  targetId: z.number().int().positive().optional().describe("Ficha existente que absorbe a la persona."),
  create: convertCreateSchema.optional().describe("O crea la ficha destino con este nombre y tipo."),
  keepNameAsAlias: z.boolean(),
  note: noteSchema.describe("Motivo obligatorio: queda en el run, en la auditoría y en el claim."),
}).strict().refine((body) => (body.targetId === undefined) !== (body.create === undefined), {
  message: "indica targetId o create, exactamente uno",
}).refine((body) => body.create === undefined
  || (body.to === "organization" ? body.create.artistType === undefined : body.create.organizationType === undefined), {
  message: "create.artistType solo con to=artist; create.organizationType solo con to=organization",
});

const personConversionSchema = z.object({
  op: z.string(),
  status: z.enum(["applied", "skipped"]),
  detail: z.string(),
  credits: z.number().int(),
  targetKind: z.enum(["organization", "artist"]),
  targetId: z.number().int(),
  runId: z.number().int(),
});

export async function registerEntityMergeRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  for (const { kind, path, noun, tag } of KINDS) {
    const fields = MERGE_FIELDS[kind] as [string, ...string[]];
    // `fieldChoices` en camelCase, solo para los campos de esta entidad.
    const fieldChoicesSchema = z.object(Object.fromEntries(
      fields.map((field) => [toCamel(field), z.enum(["keep", "drop"]).optional()]),
    )).strict().describe("Solo para campos en conflicto; sin entrada, gana la ficha que queda.");

    const previewSchema = z.object({
      kind: z.enum(["person", "organization", "artist"]),
      keep: sideSchema,
      drop: sideSchema,
      recommendedKeepId: z.number().int(),
      fieldConflicts: z.array(z.object({ field: z.enum(fields), keepValue: z.unknown(), dropValue: z.unknown() })),
      fieldsFilledFromDrop: z.array(z.enum(fields)),
      sharedBands: z.array(z.object({ id: z.number().int(), name: z.string() })),
      sharedAlbums: z.array(z.object({ id: z.number().int(), title: z.string() })),
      aliasesToAdd: z.array(z.string()),
      reviewsBetween: z.array(z.number().int()),
      warnings: z.array(z.string()),
      previewHash: z.string().regex(/^[0-9a-f]{64}$/u),
    });

    const resultSchema = z.object({
      kind: z.enum(["person", "organization", "artist"]),
      keepId: z.number().int(),
      dropId: z.number().int(),
      auditId: z.number().int(),
      moved: z.number().int(),
      discarded: z.number().int(),
      filled: z.array(z.string()),
      fieldsCorrected: z.array(z.enum(fields)),
      creditsMerged: z.number().int(),
      membershipsMerged: z.number().int(),
      runId: z.number().int(),
    });

    const mergeBodySchema = z.object({
      dropId: z.number().int().positive(),
      previewHash: z.string().regex(/^[0-9a-f]{64}$/u)
        .describe(`Hash de GET /${path}/:id/merge-preview; si la ficha cambió, responde 409.`),
      fieldChoices: fieldChoicesSchema.optional(),
      keepDropNameAsAlias: z.boolean().describe("Guardar el nombre de la ficha que desaparece como alias."),
      note: noteSchema.describe("Motivo obligatorio: queda en el run, en la auditoría y en el claim."),
    }).strict();

    /** camelCase del cuerpo → campos canónicos en snake_case del servicio. */
    function chosenFields(choices: z.infer<typeof fieldChoicesSchema> | undefined): Record<string, "keep" | "drop"> | undefined {
      if (!choices) return undefined;
      const decision: Record<string, "keep" | "drop"> = {};
      for (const [key, value] of Object.entries(choices)) {
        const field = toSnake(key);
        if (value === undefined || !fields.includes(field)) return undefined;
        decision[field] = value;
      }
      return Object.keys(decision).length ? decision : undefined;
    }

    server.get(`/${path}/:id/merge-preview`, {
      schema: {
        tags: [tag],
        summary: `Previsualiza la fusión ${noun === "la persona" ? "de dos personas" : noun === "la organización" ? "de dos organizaciones" : "de dos artistas"}: conflictos, campos que se completan, discos compartidos y avisos. No escribe nada.`,
        params: idParamSchema,
        querystring: previewQuerySchema,
        response: { 200: previewSchema, ...writeErrorResponses },
      },
    }, async (request) => {
      return previewEntityMerge(getPool(), kind, request.params.id, request.query.with);
    });

    server.post(`/${path}/:id/merge`, {
      schema: {
        tags: [tag],
        summary: `Fusiona ${noun} indicada en \`:id\` (la ficha que queda); cierra revisiones, redirige el id perdido y unifica relaciones equivalentes.`,
        security: OPERATOR_SECURITY,
        params: idParamSchema,
        body: mergeBodySchema,
        response: { 200: resultSchema, ...writeErrorResponses },
      },
    }, async (request) => {
      const keepId = request.params.id;
      const body = request.body;
      const fieldChoices = chosenFields(body.fieldChoices);
      const { runId, result } = await withOperatorRun({
        name: `api:merge:${kind}`,
        operator: request.operator,
        note: body.note,
        params: { kind, keepId, dropId: body.dropId, ...(fieldChoices === undefined ? {} : { fieldChoices }) },
      }, (context) => mergeEntities(context, {
        kind, keepId, dropId: body.dropId, previewHash: body.previewHash,
        keepDropNameAsAlias: body.keepDropNameAsAlias,
        ...(fieldChoices === undefined ? {} : { fieldChoices }),
      }));
      return { ...result, runId };
    });
  }

  // Convertir una persona basura es solo de personas: las organizaciones y los
  // artistas ya son la ficha de destino de esa conversión.
  server.post("/persons/:id/convert", {
    schema: {
      tags: ["persons:merge"],
      summary: "Convierte la ficha en organización o artista (existente con targetId, o nueva con create); sus créditos pasan al destino y su enlace pasa a responder movedTo.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: convertBodySchema,
      response: { 200: personConversionSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const personId = request.params.id;
    const body = request.body;
    const { runId, result } = await withOperatorRun({
      name: "api:convert:person", operator: request.operator, note: body.note,
      params: {
        personId, to: body.to, targetId: body.targetId ?? null, create: body.create ?? null,
        keepNameAsAlias: body.keepNameAsAlias,
      },
    }, async (context) => {
      // El destino se crea con el mismo camino que POST /organizations y
      // /artists (claims humanos); si el ER duda, aborta con su 409.
      const targetId = body.targetId ?? (await createEntity(context, body.to, {
        name: body.create!.name,
        ...(body.create!.organizationType === undefined ? {} : { organization_type: body.create!.organizationType }),
        ...(body.create!.artistType === undefined ? {} : { artist_type: body.create!.artistType }),
      })).id;
      const outcome = await convertPerson(
        context.client, personId, { kind: body.to, id: targetId }, body.keepNameAsAlias, context.note, context.runId);
      return { ...outcome, targetKind: body.to, targetId };
    });
    return { ...result, runId };
  });
}
