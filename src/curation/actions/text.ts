// CRV · Acción `limpiar_texto` (PLAN_CURADURIA E4.8): la corrección que ya
// existía para los cinco detectores con valor sugerido, llevada al marco.
//
// Limpia el nombre o título detectado con la misma función con que el detector
// calculó su sugerencia —reparar mojibake, quitar invisibles, decodificar
// entidades HTML, colapsar espacios, recortar signos colgantes— sobre el valor
// VIVO de la ficha, no sobre el texto del análisis. Varias limpiezas sobre la
// misma ficha y campo se encadenan en el lote (reparar la codificación primero:
// quitar el guion blando de «ahÃ­» antes rompería la reparación), cada una con
// su antes → después, su run y su deshacer; la segunda parte de lo que deja la
// primera, así ninguna pisa a la otra (C4).
//
// Niveles (§2.3): invisibles, espacios y entidades son 0; reparar la
// codificación es 1; un signo colgante es 0 si lo que se recorta es « -», «,» o
// «/» aislado y 1 en el resto. Un valor escrito a mano es 1 y solo vale para una
// corrección individual.
//
// Renombrar un artista al nombre exacto de otro choca con `artists.name` UNIQUE:
// la vista previa bloquea el renombrado y propone `fusionar` (M6).
import type { PoolClient } from "pg";
import { z } from "zod";
import { canonicalFieldValue } from "../../merge/engine.js";
import { withFieldJournal } from "../../merge/field-undo.js";
import { OperatorError, updateEntity } from "../../merge/operator.js";
import { ENTITY_SPECS, type ResolvableClaimKind } from "../../merge/specs.js";
import {
  cleanInvisible, collapseSpaces, decodeHtmlEntitiesValue, repairMojibake, trimDanglingPunctuation,
} from "../detectors/text-hygiene.js";
import type { ActionFinding, ActionLevel, ActionPreview, FixActionDefinition, Precondition } from "./types.js";

/** En el orden en que se encadenan sobre la misma ficha y campo. */
export const TEXT_CLEANUPS = ["mojibake", "invisibles", "entidades", "espacios", "colgantes"] as const;
export type TextCleanup = (typeof TEXT_CLEANUPS)[number];

const CLEANUP_BY_DETECTOR: Readonly<Record<string, { cleanup: TextCleanup; signature?: string }>> = {
  codificacion_rota: { cleanup: "mojibake", signature: "mojibake" },
  caracteres_invisibles: { cleanup: "invisibles" },
  entidades_html: { cleanup: "entidades" },
  espacios_irregulares: { cleanup: "espacios" },
  signos_colgantes: { cleanup: "colgantes" },
};

/** `undefined` = no hay una limpieza segura (mojibake irreparable). */
const CLEAN: Readonly<Record<TextCleanup, (value: string) => string | undefined>> = {
  mojibake: repairMojibake,
  invisibles: cleanInvisible,
  entidades: decodeHtmlEntitiesValue,
  espacios: collapseSpaces,
  colgantes: trimDanglingPunctuation,
};

const ENTITY_KINDS = new Set<string>(["artist", "person", "organization", "album", "track"]);

const cleanTextParamsSchema = z.object({
  field: z.enum(["name", "title"]),
  cleanup: z.enum(TEXT_CLEANUPS),
  /** Valor escrito a mano: sustituye a la limpieza (solo en una corrección individual). */
  value: z.string().trim().min(1).max(2000).optional(),
}).strict();

export type CleanTextParams = z.infer<typeof cleanTextParamsSchema>;

interface Target { kind: ResolvableClaimKind; id: number; field: "name" | "title"; column: string }

function targetOf(finding: ActionFinding): Target | null {
  const kind = finding.entity.kind;
  if (!ENTITY_KINDS.has(kind) || finding.entity.id === null) return null;
  const spec = ENTITY_SPECS[kind as ResolvableClaimKind];
  // Solo el nombre o título de la propia ficha: la columna que el detector leyó.
  if (finding.field !== spec.identityColumn) return null;
  return { kind: kind as ResolvableClaimKind, id: finding.entity.id, field: spec.identityColumn, column: spec.identityColumn };
}

function cleanupOf(finding: ActionFinding): TextCleanup | null {
  const mapping = CLEANUP_BY_DETECTOR[finding.detector];
  if (!mapping || (mapping.signature !== undefined && mapping.signature !== finding.signature)) return null;
  return mapping.cleanup;
}

/** « -», «,» o «/» sueltos en un extremo: recortarlos no pierde nada (nivel 0). */
const SAFE_DANGLING = new Set(["-", ",", "/"]);

function isSafeDangling(value: string): boolean {
  const cleaned = trimDanglingPunctuation(value);
  const at = cleaned ? value.indexOf(cleaned) : -1;
  if (at < 0) return false;
  const removed = [value.slice(0, at), value.slice(at + cleaned.length)].map((part) => part.trim()).filter(Boolean);
  return removed.length > 0 && removed.every((part) => SAFE_DANGLING.has(part));
}

async function readLive(client: PoolClient, target: Target, lock: boolean): Promise<string | null | undefined> {
  const spec = ENTITY_SPECS[target.kind];
  const { rows } = await client.query<{ value: string | null }>(
    `SELECT ${target.column}::text AS value FROM ${spec.table} WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [target.id]);
  return rows[0] ? rows[0].value : undefined;
}

const chainKey = (target: Target): string => `${target.kind}:${target.id}:${target.field}`;

function blockedPreview(target: Target | null, code: NonNullable<ActionPreview["blocked"]>["code"], message: string, before: Record<string, unknown> = {}): ActionPreview {
  return {
    touched: target ? [{ kind: target.kind, id: target.id }] : [], before, after: {},
    blocked: { code, message }, collisions: [], warnings: [], proposal: null,
  };
}

export const cleanTextAction: FixActionDefinition<CleanTextParams> = {
  key: "limpiar_texto",
  label: "Limpiar el texto",
  description: "Aplica al nombre o título la limpieza que calculó el detector (invisibles, espacios, entidades HTML, codificación, signos colgantes) sobre el valor actual de la ficha.",
  level: 0,
  inverse: "field_restore",
  paramsSchema: cleanTextParamsSchema,

  appliesTo(finding) {
    return cleanupOf(finding) !== null && targetOf(finding) !== null
      && finding.suggestedValue !== null && finding.suggestedValue.trim() !== "";
  },

  levelFor(finding, params) {
    if (params?.value !== undefined) return 1;
    const cleanup = params?.cleanup ?? cleanupOf(finding);
    if (cleanup === "mojibake") return 1;
    if (cleanup === "colgantes") return finding.value !== null && isSafeDangling(finding.value) ? 0 : 1;
    return 0 satisfies ActionLevel;
  },

  async defaultParams(finding) {
    const cleanup = cleanupOf(finding);
    const target = targetOf(finding);
    return cleanup && target ? { field: target.field, cleanup } : null;
  },

  chain(finding, params) {
    const target = targetOf(finding);
    if (!target) return null;
    return { key: chainKey(target), rank: params.value !== undefined ? TEXT_CLEANUPS.length : TEXT_CLEANUPS.indexOf(params.cleanup) };
  },

  async preconditions(finding, params, ctx) {
    const target = targetOf(finding);
    const checks: Precondition[] = [];
    checks.push(target && params.field === target.field
      ? { key: "campo", ok: true }
      : { key: "campo", ok: false, code: "invalid", message: "la limpieza solo se aplica al nombre o título de la ficha del hallazgo" });
    checks.push(params.value === undefined || ctx.batchMode === "individual"
      ? { key: "valor_a_mano", ok: true }
      : { key: "valor_a_mano", ok: false, code: "invalid", message: "un valor escrito a mano solo vale para una corrección individual" });
    if (!target) return checks;
    const live = await readLive(ctx.client, target, false);
    if (live === undefined) {
      checks.push({ key: "ficha", ok: false, code: "stale", message: `${target.kind} ${target.id} ya no existe` });
      return checks;
    }
    checks.push({ key: "ficha", ok: true });
    // CAS (C4): la ficha debe tener aún el valor que vio el análisis. Al aplicar
    // lo cubre el hash: el antes de cada ítem es el valor vivo.
    if (ctx.mode === "preview") {
      checks.push(live === finding.value
        ? { key: "valor_detectado", ok: true }
        : { key: "valor_detectado", ok: false, code: "stale", message: `la ficha ya cambió desde el análisis: ahora dice «${live ?? ""}»` });
    }
    return checks;
  },

  async preview(finding, params, ctx) {
    const target = targetOf(finding);
    if (!target) return blockedPreview(null, "invalid", "el hallazgo no apunta al nombre o título de una ficha");
    const live = await readLive(ctx.client, target, ctx.mode === "apply");
    if (live === undefined) return blockedPreview(target, "stale", `${target.kind} ${target.id} ya no existe`);
    const key = chainKey(target);
    const pending = ctx.mode === "preview" ? ctx.pending.get(key) : undefined;
    const before = pending?.value ?? live ?? "";
    const beforeView = { field: target.field, value: before };
    const raw = params.value ?? CLEAN[params.cleanup](before);
    if (raw === undefined) return blockedPreview(target, "not_applicable", "no hay una reparación segura de la codificación", beforeView);
    let after: string;
    try {
      // Lo que el motor guardará de verdad (NFC, espacios colapsados): la vista previa no promete otra cosa.
      after = String(canonicalFieldValue(raw, target.field, "human") ?? "");
    } catch (error) {
      return blockedPreview(target, "invalid", (error as Error).message, beforeView);
    }
    if (!after) return blockedPreview(target, "empty", "la limpieza dejaría el campo vacío", beforeView);
    // `VARCHAR(200)`/`VARCHAR(250)` en una base SQL_ASCII cuentan bytes: solo un valor escrito a mano puede pasarse.
    const limit = target.field === "name" ? 200 : 250;
    if (Buffer.byteLength(after, "utf8") > limit) {
      return blockedPreview(target, "invalid", `el valor no cabe: el catálogo admite ${limit} bytes`, beforeView);
    }
    const base: Omit<ActionPreview, "blocked" | "proposal"> = {
      touched: [{ kind: target.kind, id: target.id }],
      before: beforeView,
      after: { field: target.field, value: after },
      collisions: [], warnings: [],
      chain: { key, value: after },
    };
    if (after === before) {
      return { ...base, blocked: null, proposal: null, noop: { coveredBy: pending?.findingId ?? null } };
    }
    const collisions = await ctx.names.similar(target.kind, target.id, after);
    const exact = target.kind === "artist" ? collisions.find((collision) => collision.exact) : undefined;
    if (exact) {
      // Bloqueado: no deja valor para el siguiente ítem de la misma ficha (sin `chain`).
      const { chain: _chain, ...unchained } = base;
      return {
        ...unchained, collisions,
        blocked: { code: "collision", message: `ya existe el artista «${exact.label}» (id ${exact.id}): el nombre es único, renombrar fallaría` },
        proposal: {
          actionKey: "fusionar",
          params: { kind: "artist", keepId: exact.id, dropId: target.id },
          reason: `fusionar con «${exact.label}», que ya tiene el nombre limpio, en lugar de renombrar`,
        },
        hashMaterial: { collision: exact.id },
      };
    }
    if (ctx.mode === "preview") ctx.names.rename(target.kind, target.id, after);
    const warnings = collisions.length
      ? [`${collisions.length === 1 ? "Otra ficha" : `${collisions.length} fichas`} del mismo tipo se ${collisions.length === 1 ? "escribe" : "escriben"} igual sin tildes ni mayúsculas: puede quedar un duplicado.`]
      : [];
    return { ...base, collisions, warnings, blocked: null, proposal: null };
  },

  async apply(context, finding, _params, preview) {
    const target = targetOf(finding);
    const value = preview.after["value"];
    if (!target || typeof value !== "string") throw new OperatorError("invalid", "vista previa sin valor que aplicar");
    await withFieldJournal(context, { kind: target.kind, id: target.id, fields: [target.field] },
      () => updateEntity(context, target.kind, target.id, { [target.field]: value }));
    const stored = await readLive(context.client, target, false);
    if (stored !== value) {
      throw new OperatorError("invalid", `el motor dejó «${stored ?? ""}» en lugar de «${value}»`, { entity: target.kind, id: target.id });
    }
    return { after: { field: target.field, value: stored } };
  },
};
