// CRV · Escritura de entidades del core (PHASES §E7B): artistas, personas,
// organizaciones, álbumes y pistas. Los controllers solo validan y traducen;
// cada petición es una transacción de `merge/operator.ts` sobre el motor.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { createEntity, deleteEntity, updateEntity, withOperatorRun, type CreateEntityOptions } from "../../merge/operator.js";
import type { ResolvableClaimKind } from "../../merge/specs.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { idParamSchema, writeErrorResponses } from "../schemas.js";

export const text = (max: number) => z.string().trim().min(1).max(max);
export const longText = z.string().trim().min(1).max(20_000);
export const year = z.number().int().min(1000).max(9999);
export const noteSchema = z.string().trim().min(1).max(2000)
  .describe("Motivo de la edición; queda en el run, en la auditoría y en la evidencia del claim.");
const url = z.string().trim().url().max(2000);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u, "fecha AAAA-MM-DD");
const publication = z.enum(["published", "unlisted", "unpublished", "copyright_blocked", "unknown"]);

// Tipos de organización y artista: viven aquí para que la creación (esta ruta)
// y la conversión persona → organización/artista (E11.7) usen el mismo enum.
export const organizationTypeSchema = z.enum(["record_label", "production_company", "recording_studio", "distributor", "management", "other"]);
export const artistTypeSchema = z.enum(["band", "solo_artist", "duo", "project", "group", "other"]);

// Campos editables por entidad (camelCase de las columnas de ENTITY_SPECS).
// `.nullable()` solo donde la columna admite NULL: vaciar un NOT NULL no se ofrece.
const ENTITY_FIELDS = {
  artist: {
    name: text(200),
    artistType: artistTypeSchema,
    biography: longText.nullable(), pictureUrl: url.nullable(),
    originCity: text(120).nullable(), originCountry: text(120),
    formedYear: year.nullable(), disbandedYear: year.nullable(), notes: longText.nullable(),
  },
  person: {
    name: text(200), biography: longText.nullable(), pictureUrl: url.nullable(), nationality: text(120).nullable(),
    isVenezuelan: z.boolean(), birthDate: isoDate.nullable(), deathDate: isoDate.nullable(), notes: longText.nullable(),
  },
  organization: {
    name: text(200),
    organizationType: organizationTypeSchema,
    biography: longText.nullable(), pictureUrl: url.nullable(), websiteUrl: url.nullable(), country: text(120).nullable(),
    notes: longText.nullable(),
  },
  album: {
    title: text(250), releaseYear: year.nullable(),
    albumType: z.enum(["studio_album", "live_album", "ep", "single", "compilation", "demo", "soundtrack", "collaboration_album", "remix", "other"]),
    genre: text(200).nullable(), labelId: z.number().int().positive().nullable(), coverUrl: url.nullable(),
    description: longText.nullable(), youtubeUrl: url.nullable(), youtubeStatus: publication,
    instagramUrl: url.nullable(), instagramStatus: publication, wordpressUrl: url.nullable(), wordpressStatus: publication,
    notes: longText.nullable(),
  },
  track: {
    title: text(250), discNumber: z.number().int().positive().max(99), trackNumber: z.number().int().positive().max(999),
    durationSeconds: z.number().int().nonnegative().nullable(), youtubeStartSeconds: z.number().int().nonnegative().nullable(),
    notes: longText.nullable(),
  },
} satisfies Record<ResolvableClaimKind, z.ZodRawShape>;

interface EntityRoute {
  kind: ResolvableClaimKind;
  path: string;
  label: string;
  identity: "name" | "title";
  /** Clave del cuerpo que fija el parental al crear (y que el PATCH puede reatribuir). */
  parent?: "artistId" | "albumId";
}

const ENTITY_ROUTES: readonly EntityRoute[] = [
  { kind: "artist", path: "/artists", label: "artista", identity: "name" },
  { kind: "person", path: "/persons", label: "persona", identity: "name" },
  { kind: "organization", path: "/organizations", label: "organización", identity: "name" },
  { kind: "album", path: "/albums", label: "álbum", identity: "title", parent: "artistId" },
  { kind: "track", path: "/tracks", label: "pista", identity: "title", parent: "albumId" },
];

const CONTROL_KEYS = new Set(["note", "allowSimilar", "artistId", "albumId"]);

export function toSnake(key: string): string {
  return key.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
}

/** Cuerpo → campos del core en snake_case, sin las claves de control. */
function catalogFields(body: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(body)
    .filter(([key, value]) => !CONTROL_KEYS.has(key) && value !== undefined)
    .map(([key, value]) => [toSnake(key), value]));
}

export function noteFrom(body: { note?: unknown } | undefined, fallback: string): string {
  return typeof body?.note === "string" && body.note.trim() ? body.note : fallback;
}

const fieldWriteSchema = z.object({
  field: z.string(),
  action: z.enum(["applied", "unchanged", "corrected"]),
  conflictsClosed: z.array(z.number().int()),
});

const entityWriteSchema = z.object({
  kind: z.string(),
  id: z.number().int(),
  runId: z.number().int(),
  fields: z.array(fieldWriteSchema),
});

export const removalSchema = z.object({
  kind: z.string(),
  id: z.number().int(),
  runId: z.number().int(),
  claimsRejected: z.array(z.number().int()),
  parentAuditId: z.number().int().nullable(),
});

export const deleteQuerySchema = z.object({ note: noteSchema.optional() });

export async function registerCatalogWriteRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  for (const route of ENTITY_ROUTES) {
    const fields: z.ZodRawShape = ENTITY_FIELDS[route.kind];
    const required: z.ZodRawShape = {
      [route.identity]: fields[route.identity]!,
      ...(route.parent === undefined ? {} : { [route.parent]: z.number().int().positive() }),
      ...(route.kind === "track" ? { trackNumber: fields["trackNumber"]! } : {}),
    };
    const createBody = z.object(fields).partial().extend({
      ...required,
      note: noteSchema.optional(),
      allowSimilar: z.boolean().optional()
        .describe("Decisión humana: crear aunque el ER vea candidatos parecidos (homónimos a sabiendas)."),
    }).strict();
    const updateBody = z.object(fields).partial().extend({
      note: noteSchema.optional(),
      // El padre (artista del disco, disco de la pista) se fija al crear y se
      // reatribuye aquí: es una corrección con auditoría, no un campo más.
      ...(route.parent === undefined ? {} : { [route.parent]: z.number().int().positive().optional() }),
    }).strict();

    server.post(route.path, {
      schema: {
        tags: [`${route.path.slice(1)}:write`],
        summary: `Crea ${route.label} a través del merge engine (claims human/high)`,
        security: OPERATOR_SECURITY,
        body: createBody,
        response: { 201: entityWriteSchema, ...writeErrorResponses },
      },
    }, async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const options: CreateEntityOptions = {
        ...(body["allowSimilar"] === true ? { allowSimilar: true } : {}),
        ...(typeof body["artistId"] === "number" ? { artistId: body["artistId"] } : {}),
        ...(typeof body["albumId"] === "number" ? { albumId: body["albumId"] } : {}),
      };
      const values = catalogFields(body);
      const { runId, result } = await withOperatorRun({
        name: `api:create:${route.kind}`, operator: request.operator, note: noteFrom(body, `alta de ${route.label} por la API`),
        params: { kind: route.kind, values, options },
      }, (context) => createEntity(context, route.kind, values, options));
      return reply.status(201).send({ ...result, runId });
    });

    server.patch(`${route.path}/:id`, {
      schema: {
        tags: [`${route.path.slice(1)}:write`],
        summary: `Corrige campos de ${route.label}; un valor ya afirmado se sustituye con auditoría y cierra sus conflictos`,
        security: OPERATOR_SECURITY,
        params: idParamSchema,
        body: updateBody,
        response: { 200: entityWriteSchema, ...writeErrorResponses },
      },
    }, async (request) => {
      const body = request.body as Record<string, unknown>;
      const values = catalogFields(body);
      const parentKey = route.parent;
      const parentId = parentKey !== undefined && typeof body[parentKey] === "number" ? (body[parentKey] as number) : undefined;
      const { runId, result } = await withOperatorRun({
        name: `api:update:${route.kind}`, operator: request.operator, note: noteFrom(body, `corrección de ${route.label} por la API`),
        params: {
          kind: route.kind, id: request.params.id, values,
          ...(parentKey === undefined || parentId === undefined ? {} : { [parentKey]: parentId }),
        },
      }, (context) => updateEntity(context, route.kind, request.params.id, values,
        parentId === undefined ? {} : { parentId }));
      return { ...result, runId };
    });

    server.delete(`${route.path}/:id`, {
      schema: {
        tags: [`${route.path.slice(1)}:write`],
        summary: `Retira ${route.label} sin dependientes; su historia se conserva en el run y en la ficha padre`,
        security: OPERATOR_SECURITY,
        params: idParamSchema,
        querystring: deleteQuerySchema,
        response: { 200: removalSchema, ...writeErrorResponses },
      },
    }, async (request) => {
      const { runId, result } = await withOperatorRun({
        name: `api:delete:${route.kind}`, operator: request.operator, note: noteFrom(request.query, `retiro de ${route.label} por la API`),
        params: { kind: route.kind, id: request.params.id },
      }, (context) => deleteEntity(context, route.kind, request.params.id));
      return { kind: result.kind, id: result.id, runId, claimsRejected: result.claimsRejected, parentAuditId: result.parentAuditId ?? null };
    });
  }
}
