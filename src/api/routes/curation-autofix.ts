// CRV · Curaduría: autocorrección segura en la API (PLAN_CURADURIA E10).
//
// La lista blanca de lo que el sistema puede corregir solo. Leerla es de
// administradores (ADMIN_READS cubre `/curation`); cambiarla es una escritura y
// pasa la misma guarda de sesión admin + CSRF que el resto: una cuenta de solo
// lectura no puede encender nada.
//
// Estas rutas no escriben en el catálogo: encienden o apagan reglas. La única
// que corrige es `POST /curation/autofix/run`, y aplica exactamente lo mismo
// que aplicaría sola tras un análisis: acciones de nivel 0 de reglas
// encendidas, con sus topes, su verificación y su interruptor de emergencia.
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { OPERATOR_SECURITY } from "../auth.js";
import { idParamSchema, writeErrorResponses } from "../schemas.js";
import {
  autofixCatalog, autofixReport, createAutofixRule, deleteAutofixRule, listAutofixEvents, listAutofixRules, runAutofix,
  updateAutofixRule,
} from "../../curation/autofix.js";
import { curationError } from "./curation.js";

export const autofixRuleSchema = z.object({
  id: z.number().int(),
  detector: z.string(),
  detectorLabel: z.string(),
  signature: z.string().nullable(),
  actionKey: z.string(),
  actionLabel: z.string(),
  enabled: z.boolean(),
  maxPerScan: z.number().int().nullable(),
  note: z.string().nullable(),
  createdBy: z.string(),
  createdAt: z.string(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
  disabledAt: z.string().nullable(),
  disabledReason: z.string().nullable(),
  disabledByBatchId: z.number().int().nullable(),
});

const autofixAlertSchema = z.object({
  ruleId: z.number().int().nullable(), detector: z.string(), signature: z.string().nullable(), actionKey: z.string(),
  reason: z.string(), batchId: z.number().int().nullable(), at: z.string(),
});

export const autofixReportSchema = z.object({
  enabled: z.boolean(),
  rules: z.object({ total: z.number().int(), active: z.number().int() }),
  today: z.object({ batches: z.number().int(), applied: z.number().int(), undone: z.number().int() }),
  batches: z.array(z.object({
    batchId: z.number().int(), detector: z.string(), signature: z.string().nullable(), actionKey: z.string(),
    status: z.string(), applied: z.number().int(), undone: z.number().int(), triggered: z.number().int(),
    at: z.string(), undoneByBatchId: z.number().int().nullable(),
  })),
  alerts: z.array(autofixAlertSchema),
});

const autofixEventSchema = z.object({
  id: z.number().int(), ruleId: z.number().int().nullable(), detector: z.string(), signature: z.string().nullable(),
  actionKey: z.string(), event: z.string(), operator: z.string(), note: z.string().nullable(),
  batchId: z.number().int().nullable(), detail: z.record(z.unknown()), at: z.string(),
});

const autofixOptionSchema = z.object({
  detector: z.string(), detectorLabel: z.string(), signature: z.string().nullable(),
  actionKey: z.string(), actionLabel: z.string(), actionDescription: z.string(),
});

const autofixStateSchema = z.object({
  report: autofixReportSchema,
  rules: z.array(autofixRuleSchema),
  events: z.array(autofixEventSchema),
  /** Lo que se puede autorizar: la pantalla no adivina claves ni niveles. */
  catalog: z.array(autofixOptionSchema),
});

const runResultSchema = z.object({
  status: z.enum(["apagada", "sin_reglas", "sin_candidatos", "tope_diario", "ocupada", "hecha"]),
  applied: z.number().int(),
  rules: z.array(z.object({
    ruleId: z.number().int(), detector: z.string(), signature: z.string().nullable(), actionKey: z.string(),
    batchId: z.number().int().nullable(), applied: z.number().int(), failed: z.number().int(),
    triggered: z.number().int(), reverted: z.boolean(),
  })),
});

const noteSchema = z.string().trim().max(2000);

export async function registerCurationAutofixRoutes(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();

  server.get("/curation/autofix", {
    schema: {
      tags: ["curation"],
      summary: "Estado de la autocorrección: si el entorno la permite, la lista blanca de reglas, lo corregido hoy con su deshacer, las reglas que el interruptor de emergencia apagó y la auditoría de cambios.",
      response: { 200: autofixStateSchema },
    },
  }, async () => ({
    report: await autofixReport(), rules: await listAutofixRules(), events: await listAutofixEvents(50), catalog: autofixCatalog(),
  }));

  server.post("/curation/autofix/rules", {
    schema: {
      tags: ["curation"],
      summary: "Autoriza una corrección automática: detector, subgrupo (vacío = todos) y acción, que debe ser de nivel 0 y estar entre las que ese detector propone. Nace apagada salvo que se pida lo contrario.",
      security: OPERATOR_SECURITY,
      body: z.object({
        detector: z.string().min(1).max(80),
        signature: z.string().min(1).max(300).nullable().optional(),
        actionKey: z.string().min(1).max(60),
        enabled: z.boolean().optional(),
        maxPerScan: z.number().int().positive().max(5000).nullable().optional(),
        note: noteSchema.optional(),
      }).strict(),
      response: { 200: autofixRuleSchema, ...writeErrorResponses },
    },
  }, async (request) => createAutofixRule(request.body, request.operator).catch(curationError));

  server.patch("/curation/autofix/rules/:id", {
    schema: {
      tags: ["curation"],
      summary: "Enciende, apaga o ajusta una regla. Encenderla borra el motivo por el que estuvo apagada: es una decisión nueva y queda auditada.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      body: z.object({
        enabled: z.boolean().optional(),
        maxPerScan: z.number().int().positive().max(5000).nullable().optional(),
        note: noteSchema.optional(),
      }).strict(),
      response: { 200: autofixRuleSchema, ...writeErrorResponses },
    },
  }, async (request) => updateAutofixRule(request.params.id, request.body, request.operator).catch(curationError));

  server.delete("/curation/autofix/rules/:id", {
    schema: {
      tags: ["curation"],
      summary: "Quita una regla de la lista blanca. Lo ya corregido sigue en el historial de lotes con su deshacer.",
      security: OPERATOR_SECURITY,
      params: idParamSchema,
      response: { 200: autofixRuleSchema, ...writeErrorResponses },
    },
  }, async (request) => deleteAutofixRule(request.params.id, request.operator).catch(curationError));

  server.post("/curation/autofix/run", {
    schema: {
      tags: ["curation"],
      summary: "Corre ahora la autocorrección con las reglas encendidas, sin esperar al próximo análisis. Aplica lo mismo y con las mismas salvaguardas: nivel 0, topes por análisis y por día, verificación dirigida y deshacer automático si la corrección desencadena hallazgos nuevos.",
      security: OPERATOR_SECURITY,
      response: { 200: runResultSchema, ...writeErrorResponses },
    },
  }, async () => runAutofix({ scanId: null }).catch(curationError));
}
