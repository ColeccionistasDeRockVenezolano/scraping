// CRV · API de deshacer una fusión (PHASES E11.8; plan P6).
//
//   POST /merge-runs/:runId/undo   body { note }
//
// Revierte un run de fusión completo (persona + créditos y membresías
// unificados) dentro de una transacción del operador. Si algo posterior lo
// impide —la ficha que quedó se fusionó después, una fila movida ya apunta a
// otra entidad, o la fusión es anterior a E11.1— responde 409 y no toca nada.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { withOperatorRun } from "../../merge/operator.js";
import { undoMergeRun } from "../../merge/unmerge.js";
import { OPERATOR_SECURITY } from "../auth.js";
import { writeErrorResponses } from "../schemas.js";
import { noteSchema } from "./catalog-writes.js";

const undoParamsSchema = z.object({ runId: z.coerce.number().int().positive() });
const undoBodySchema = z.object({ note: noteSchema.describe("Motivo de la reversión; queda en el run y en la auditoría.") }).strict();

const unmergeResultSchema = z.object({
  runId: z.number().int().describe("Run de la reversión."),
  mergeRunId: z.number().int(),
  restored: z.array(z.object({ kind: z.string(), id: z.number().int() })),
  fieldsNotReverted: z.array(z.string()).describe("Correcciones de campo del run de fusión: se informan, no se revierten."),
});

export async function registerMergeRunRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.post("/merge-runs/:runId/undo", {
    schema: {
      tags: ["persons:merge"],
      summary: "Deshace un run de fusión: reinserta lo borrado, repunta lo movido y anula la redirección. 409 si algo posterior lo impide.",
      security: OPERATOR_SECURITY,
      params: undoParamsSchema,
      body: undoBodySchema,
      response: { 200: unmergeResultSchema, ...writeErrorResponses },
    },
  }, async (request) => {
    const mergeRunId = request.params.runId;
    const { runId, result } = await withOperatorRun({
      name: "api:merge:undo", operator: request.operator, note: request.body.note, params: { mergeRunId },
    }, (context) => undoMergeRun(context, mergeRunId));
    return { ...result, runId };
  });
}
