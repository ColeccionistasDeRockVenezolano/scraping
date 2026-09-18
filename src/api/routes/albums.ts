import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { idParamSchema, aliasSchema, paginatedResponseSchema, writeErrorResponses } from "../schemas.js";
import { getAlbumDetail, listAlbums } from "../repositories/albums.js";
import { notFoundEntity } from "../repositories/redirects.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { noteSchema } from "./catalog-writes.js";
import { withOperatorRun } from "../../merge/operator.js";
import { MERGE_ALBUM_FIELDS, previewAlbumMerge, mergeAlbums } from "../../merge/album-merge.js";
import { getPool } from "../../db/client.js";

const albumListItemSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  releaseYear: z.number().int().nullable(),
  albumType: z.string(),
  artistId: z.number().int(),
  artistName: z.string(),
  coverUrl: z.string().nullable(),
});

const creditSchema = z.object({
  id: z.number().int(),
  creditType: z.string(),
  role: z.string(),
  personId: z.number().int().nullable(),
  personName: z.string().nullable(),
  artistId: z.number().int().nullable(),
  artistName: z.string().nullable(),
  organizationId: z.number().int().nullable(),
  organizationName: z.string().nullable(),
});

const trackSchema = z.object({
  id: z.number().int(),
  discNumber: z.number().int(),
  trackNumber: z.number().int(),
  title: z.string(),
  durationSeconds: z.number().int().nullable(),
  youtubeStartSeconds: z.number().int().nullable(),
  credits: z.array(creditSchema),
});

const albumDetailSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  releaseYear: z.number().int().nullable(),
  albumType: z.string(),
  genre: z.string().nullable(),
  coverUrl: z.string().nullable(),
  description: z.string().nullable(),
  notes: z.string().nullable(),
  youtubeUrl: z.string().nullable(),
  youtubeStatus: z.string(),
  instagramUrl: z.string().nullable(),
  instagramStatus: z.string(),
  wordpressUrl: z.string().nullable(),
  wordpressStatus: z.string(),
  artist: z.object({ id: z.number().int(), name: z.string() }),
  label: z.object({ id: z.number().int(), name: z.string() }).nullable(),
  tracklist: z.array(trackSchema),
  credits: z.array(creditSchema),
  creditsByType: z.record(z.string(), z.array(creditSchema)),
  formats: z.array(z.object({
    id: z.number().int(), format: z.string(), quality: z.string().nullable(), archiveStatus: z.string(),
    filePath: z.string().nullable(), notes: z.string().nullable(),
  })),
  aliases: z.array(aliasSchema),
  youtubeLinks: z.array(z.object({
    videoId: z.string(), title: z.string().nullable(), kind: z.string(), isPrimaryLink: z.boolean(),
  })),
});

const listQuerySchema = paginationQuerySchema.extend({
  q: z.string().trim().min(1).optional(),
  artistId: z.coerce.number().int().positive().optional(),
});


const previewQuerySchema = z.object({
  with: z.coerce.number().int().positive().describe("Id del disco que desaparecería (drop)."),
});

const trackSummarySchema = z.object({
  id: z.number().int(),
  discNumber: z.number().int(),
  trackNumber: z.number().int(),
  title: z.string(),
  durationSeconds: z.number().int().nullable(),
  creditCount: z.number().int(),
});

const albumSideSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  artistId: z.number().int(),
  artistName: z.string(),
  labelId: z.number().int().nullable(),
  labelName: z.string().nullable(),
  fields: z.record(z.string(), z.unknown()),
  aliases: z.array(z.string()),
  tracks: z.array(trackSummarySchema),
  counts: z.object({ tracks: z.number().int(), albumCredits: z.number().int(), formats: z.number().int(), mediaLinks: z.number().int(), claims: z.number().int() }),
});

const albumMergePreviewSchema = z.object({
  keep: albumSideSchema,
  drop: albumSideSchema,
  recommendedKeepId: z.number().int(),
  matchedTracks: z.array(z.object({
    keepTrackId: z.number().int(),
    dropTrackId: z.number().int(),
    keepTitle: z.string(),
    dropTitle: z.string(),
    discNumber: z.number().int(),
    keepTrackNumber: z.number().int(),
    dropTrackNumber: z.number().int(),
    matchType: z.enum(["position_and_title", "title", "position"]),
  })),
  unmatchedDropTracks: z.array(trackSummarySchema),
  fieldConflicts: z.array(z.object({
    field: z.enum(MERGE_ALBUM_FIELDS),
    keepValue: z.unknown(),
    dropValue: z.unknown(),
  })),
  fieldsFilledFromDrop: z.array(z.enum(MERGE_ALBUM_FIELDS)),
  sharedCredits: z.array(z.object({ id: z.number().int(), role: z.string(), creditType: z.string(), targetName: z.string() })),
  formatsToAdd: z.array(z.object({ id: z.number().int(), format: z.string() })),
  warnings: z.array(z.string()),
  previewHash: z.string().regex(/^[0-9a-f]{64}$/u),
});

const mergeAlbumBodySchema = z.object({
  dropId: z.number().int().positive(),
  previewHash: z.string().regex(/^[0-9a-f]{64}$/u),
  fieldChoices: z.record(z.enum(MERGE_ALBUM_FIELDS), z.enum(["keep", "drop"])).optional(),
  keepDropNameAsAlias: z.boolean().default(false),
  note: noteSchema,
}).strict();

const albumMergeResultSchema = z.object({
  keepId: z.number().int(),
  dropId: z.number().int(),
  auditId: z.number().int(),
  tracksMerged: z.number().int(),
  tracksMoved: z.number().int(),
  creditsMerged: z.number().int(),
  formatsMerged: z.number().int(),
  fieldsCorrected: z.array(z.enum(MERGE_ALBUM_FIELDS)),
  runId: z.number().int(),
});

export async function registerAlbumRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/albums", {
    schema: {
      tags: ["albums"],
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(albumListItemSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listAlbums(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/albums/:id", {
    schema: {
      tags: ["albums"],
      summary: "Ficha agregada del disco: tracklist, créditos y enlaces de YouTube.",
      params: idParamSchema,
      response: { 200: albumDetailSchema },
    },
  }, async (request) => {
    const detail = await getAlbumDetail(request.params.id);
    if (!detail) throw await notFoundEntity("album", request.params.id);
    return detail;
  });

  server.get("/albums/:id/merge-preview", {
    schema: {
      tags: ["albums:merge"],
      summary: "Previsualiza la fusión de dos discos: pistas emparejadas, formatos, créditos y conflictos.",
      params: idParamSchema,
      querystring: previewQuerySchema,
      response: { 200: albumMergePreviewSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const client = await getPool().connect();
    try {
      return await previewAlbumMerge(client, request.params.id, request.query.with);
    } finally {
      client.release();
    }
  });

  server.post("/albums/:id/merge", {
    schema: {
      tags: ["albums:merge"],
      summary: "Fusiona el disco indicado en :id (keep) con el duplicado (drop); unifica pistas, formatos y créditos.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: mergeAlbumBodySchema,
      response: { 200: albumMergeResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const keepId = request.params.id;
    const body = request.body;
    const { runId, result } = await withOperatorRun({
      name: "api:merge:album",
      operator: request.operator,
      note: body.note,
      params: { keepId, dropId: body.dropId, ...(body.fieldChoices ? { fieldChoices: body.fieldChoices } : {}) },
    }, async (context) => {
      return mergeAlbums(context, {
        keepId,
        dropId: body.dropId,
        previewHash: body.previewHash,
        fieldChoices: body.fieldChoices,
        keepDropNameAsAlias: body.keepDropNameAsAlias,
      });
    });
    return { ...result, runId };
  });
}
