// CRV · Historial de cambios y deshacer (migración 0028).
//
//   GET  /changes                  runs, del más reciente al más antiguo (filtro por ficha)
//   GET  /changes/:runId           un run, con lo que haría deshacerlo
//   POST /changes/:runId/undo      body { note } — lo deshace como un run nuevo
//
// Todo cambio del catálogo es un run: una edición, una fusión, una división,
// un retiro, un lote de Curaduría o un proceso de la CLI. Deshacer uno es otro
// run, que también se puede deshacer (rehacer).
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getPool } from "../../db/client.js";
import { withOperatorRun } from "../../merge/operator.js";
import { previewRunUndo, undoRun } from "../../merge/run-undo.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { notFound } from "../http-errors.js";
import { paginationQuerySchema, toPage } from "../pagination.js";
import { CHANGE_ENTITY_TABLES, getChange, listChanges, type ChangeEntityKind } from "../repositories/changes.js";
import { paginatedResponseSchema, writeErrorResponses } from "../schemas.js";
import { noteSchema } from "./catalog-writes.js";

const entityKinds = Object.keys(CHANGE_ENTITY_TABLES) as [ChangeEntityKind, ...ChangeEntityKind[]];
const runParamsSchema = z.object({ runId: z.coerce.number().int().positive() });

const listQuerySchema = paginationQuerySchema.extend({
  entity: z.enum(entityKinds).optional(),
  id: z.coerce.number().int().positive().optional(),
  journaled: z.enum(["true", "false"]).transform((value) => value === "true").optional()
    .describe("true: solo los cambios registrados en el diario (los que se deshacen con él)."),
}).refine((query) => (query.entity === undefined) === (query.id === undefined), { message: "entity e id van juntos" });

const stepCountsSchema = z.object({ restore: z.number().int(), revert: z.number().int(), remove: z.number().int() });

const changeSchema = z.object({
  runId: z.number().int(),
  kind: z.string(),
  status: z.string(),
  action: z.string().nullable(),
  operator: z.string().nullable(),
  note: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  journaled: z.boolean(),
  counts: z.record(z.object({ created: z.number().int(), changed: z.number().int(), removed: z.number().int() })),
  total: z.number().int(),
  entities: z.array(z.object({ kind: z.enum(entityKinds), id: z.number().int(), label: z.string().nullable(), op: z.enum(["created", "removed", "changed"]) })),
  entityTotal: z.number().int(),
  undoneBy: z.number().int().nullable(),
  undoOf: z.number().int().nullable(),
  redoOf: z.number().int().nullable(),
});

const conflictSchema = z.object({
  table: z.string(),
  pk: z.record(z.unknown()),
  reason: z.enum(["changed", "missing", "exists"]),
  columns: z.array(z.string()),
  laterRunId: z.number().int().nullable(),
  label: z.string().nullable(),
});

const planSchema = z.object({
  runId: z.number().int(),
  changes: z.number().int(),
  steps: stepCountsSchema,
  byTable: z.record(stepCountsSchema),
  entities: z.array(z.object({ kind: z.string(), id: z.number().int(), label: z.string().nullable(), step: z.enum(["restore", "revert", "remove"]) })),
  conflicts: z.array(conflictSchema),
  skipped: z.array(conflictSchema),
  claimsToSupersede: z.number().int(),
});

const changeDetailSchema = changeSchema.extend({
  undo: z.object({
    method: z.enum(["journal", "legacy"]).nullable(),
    undoable: z.boolean(),
    reason: z.string().nullable(),
    plan: planSchema.nullable(),
  }),
});

const undoResultSchema = z.object({
  runId: z.number().int().describe("Run del deshacer: deshacerlo es rehacer."),
  undoneRunId: z.number().int(),
  method: z.enum(["journal", "legacy"]),
  result: z.unknown(),
});

export async function registerChangeRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/changes", {
    schema: {
      tags: ["changes"],
      summary: "Historial de cambios del catálogo: cada run con lo que tocó, quién, por qué y si está deshecho. Solo cuentas administradoras.",
      querystring: listQuerySchema,
      response: { 200: paginatedResponseSchema(changeSchema) },
    },
  }, async (request) => {
    const { rows, total } = await listChanges(request.query);
    return toPage(rows, total, request.query);
  });

  server.get("/changes/:runId", {
    schema: {
      tags: ["changes"],
      summary: "Un cambio y lo que haría deshacerlo (qué vuelve, qué se retira, qué lo impide). No escribe nada.",
      params: runParamsSchema,
      response: { 200: changeDetailSchema },
    },
  }, async (request) => {
    const change = await getChange(request.params.runId);
    if (!change) throw notFound("cambio", request.params.runId);
    const client = await getPool().connect();
    try {
      // Solo lectura y en una sola foto: la vista previa no ve medio cambio ajeno.
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const preview = await previewRunUndo(client, request.params.runId);
      await client.query("COMMIT");
      return { ...change, undo: { method: preview.method, undoable: preview.undoable, reason: preview.reason, plan: preview.plan } };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });

  server.post("/changes/:runId/undo", {
    schema: {
      tags: ["changes"],
      summary: "Deshace un cambio: devuelve cada fila que tocó a como estaba. 409 si algo del catálogo cambió después (dice qué y qué cambio lo hizo).",
      security: OPERATOR_SECURITY,
      params: runParamsSchema,
      body: z.object({ note: noteSchema.describe("Motivo del deshacer; queda en el run.") }).strict(),
      response: { 200: undoResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const undoneRunId = request.params.runId;
    const { runId, result } = await withOperatorRun({
      name: "api:undo:run", operator: request.operator, note: request.body.note, params: { undoesRunId: undoneRunId },
    }, (context) => undoRun(context, undoneRunId));
    return { runId, undoneRunId: result.undoneRunId, method: result.method, result: result.result };
  });
}
