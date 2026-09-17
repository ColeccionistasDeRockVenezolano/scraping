// CRV · Acción `fusionar` (PLAN_CURADURIA E4.7, matriz §2.3 «Fichas repetidas»).
//
// Lleva al marco la fusión con vista previa que ya existía para personas,
// organizaciones y artistas (`src/merge/entity-merge.ts`): la ficha que queda
// es la que tiene más referencias, el nombre de la que desaparece queda como
// alias y la vista previa lleva el hash de `previewEntityMerge`, así que al
// aplicar `mergeEntities` se niega si alguna de las dos fichas cambió. Se
// deshace con `undoMergeRun`.
//
// Niveles: el mismo nombre sin tildes ni mayúsculas (`misma_clave`, personas
// equivalentes) es 1; sin artículo, con aclaración o sin palabras de sello es 2
// (la persona compara campo a campo). La propone también `limpiar_texto` cuando
// el nombre limpio de un artista ya existe: `artists.name` es UNIQUE (M6).
//
// Sin elección de campos: en un conflicto se conserva el valor de la ficha que
// queda y la vista previa lo avisa. Quien quiera otro valor fusiona desde la
// ficha (`POST /persons/:id/merge` y equivalentes).
import { z } from "zod";
import { mergeEntities, previewEntityMerge, type EntityMergePreview, type MergeableKind, type MergeSide } from "../../merge/entity-merge.js";
import { OperatorError } from "../../merge/operator.js";
import { ENTITY_SPECS } from "../../merge/specs.js";
import { nameKey } from "../lexicon.js";
import type { ActionContext, ActionFinding, ActionPreview, FixActionDefinition, Precondition } from "./types.js";

const MERGE_DETECTORS: Readonly<Record<string, { kind: MergeableKind; sameKey: readonly string[] }>> = {
  artistas_equivalentes: { kind: "artist", sameKey: ["misma_clave"] },
  organizaciones_equivalentes: { kind: "organization", sameKey: [] },
  personas_equivalentes: { kind: "person", sameKey: ["personas_equivalentes"] },
};

const mergeParamsSchema = z.object({
  kind: z.enum(["person", "organization", "artist"]),
  keepId: z.number().int().positive(),
  dropId: z.number().int().positive(),
}).strict();

export type MergeParams = z.infer<typeof mergeParamsSchema>;

/** El par del hallazgo (`evidence.pair`, ordenado). */
function pairOf(finding: ActionFinding): [number, number] | null {
  const pair = finding.evidence["pair"];
  if (!Array.isArray(pair) || pair.length !== 2) return null;
  const [a, b] = pair.map(Number);
  return Number.isInteger(a) && Number.isInteger(b) && a! > 0 && b! > 0 && a !== b ? [a!, b!] : null;
}

function detectorKind(finding: ActionFinding): MergeableKind | null {
  const mapping = MERGE_DETECTORS[finding.detector];
  return mapping && finding.entity.kind === mapping.kind && pairOf(finding) ? mapping.kind : null;
}

const samePair = (pair: [number, number], params: MergeParams): boolean =>
  (pair[0] === params.keepId && pair[1] === params.dropId) || (pair[0] === params.dropId && pair[1] === params.keepId);

/** Pedida a mano sobre otro hallazgo: el de un par con esas mismas fichas, o el de una de ellas (p. ej. su nombre sucio). */
function acceptsExplicitMerge(finding: ActionFinding, params: MergeParams): boolean {
  if (finding.entity.kind !== params.kind || finding.entity.id === null) return false;
  const pair = pairOf(finding);
  return pair ? samePair(pair, params) : finding.entity.id === params.keepId || finding.entity.id === params.dropId;
}

/** Clave de la cadena del lote: la ficha que desaparece y en cuál queda. */
const mergeKey = (kind: MergeableKind, id: number): string => `merge:${kind}:${id}`;

/** Vistas previas de fusión ya calculadas en esta vista previa del lote (las pide `defaultParams` y otra vez `preview`). */
const previews = new WeakMap<ActionContext, Map<string, Promise<EntityMergePreview>>>();

function cachedPreview(ctx: ActionContext, kind: MergeableKind, keepId: number, dropId: number): Promise<EntityMergePreview> {
  if (ctx.mode === "apply") return previewEntityMerge(ctx.client, kind, keepId, dropId, { lock: true });
  let cache = previews.get(ctx);
  if (!cache) previews.set(ctx, cache = new Map());
  const key = `${kind}:${keepId}:${dropId}`;
  let preview = cache.get(key);
  if (!preview) {
    preview = previewEntityMerge(ctx.client, kind, keepId, dropId);
    // Un fallo no se guarda: el siguiente intento lo vuelve a mirar.
    void preview.catch(() => cache.delete(key));
    cache.set(key, preview);
  }
  return preview;
}

const sideView = (side: MergeSide) => ({ id: side.id, name: side.name, aliases: side.aliases, counts: side.counts });

function blocked(params: MergeParams, code: NonNullable<ActionPreview["blocked"]>["code"], message: string): ActionPreview {
  return {
    touched: [{ kind: params.kind, id: params.keepId }, { kind: params.kind, id: params.dropId }],
    before: {}, after: {}, blocked: { code, message }, collisions: [], warnings: [], proposal: null,
  };
}

export const mergeAction: FixActionDefinition<MergeParams> = {
  key: "fusionar",
  label: "Fusionar las fichas",
  description: "Fusiona la ficha repetida en la que tiene más referencias: créditos, membresías y alias pasan a la que queda y el nombre perdido queda como alias.",
  level: 1,
  inverse: "merge_undo",
  paramsSchema: mergeParamsSchema,

  appliesTo(finding) {
    return detectorKind(finding) !== null && finding.entity.id !== null;
  },

  acceptsExplicit: acceptsExplicitMerge,

  levelFor(finding) {
    const mapping = MERGE_DETECTORS[finding.detector];
    if (!mapping) return 1; // propuesta explícita: el nombre limpio ya es idéntico al de la otra ficha
    if (mapping.sameKey.includes(finding.signature)) return 1;
    const values = Array.isArray(finding.evidence["values"]) ? finding.evidence["values"] as Array<{ value?: unknown }> : [];
    const keys = values.map((item) => (typeof item.value === "string" ? nameKey(item.value) : ""));
    if (keys.length === 2 && keys[0] && keys[0] === keys[1]) return 1;
    return 2;
  },

  async defaultParams(finding, ctx) {
    const kind = detectorKind(finding);
    const pair = pairOf(finding);
    if (!kind || !pair) return null;
    try {
      const preview = await cachedPreview(ctx, kind, pair[0], pair[1]);
      const keepId = preview.recommendedKeepId;
      return { kind, keepId, dropId: keepId === pair[0] ? pair[1] : pair[0] };
    } catch (error) {
      // Sin vista previa (una de las fichas ya no está) la precondición lo dirá.
      if (error instanceof OperatorError) return { kind, keepId: pair[0], dropId: pair[1] };
      throw error;
    }
  },

  async preconditions(finding, params, ctx) {
    const checks: Precondition[] = [];
    checks.push(finding.entity.kind === params.kind
      ? { key: "tipo", ok: true }
      : { key: "tipo", ok: false, code: "invalid", message: `el hallazgo es de ${finding.entity.kind}, no de ${params.kind}` });
    if (params.keepId === params.dropId) {
      checks.push({ key: "par", ok: false, code: "invalid", message: "no se puede fusionar una ficha consigo misma" });
      return checks;
    }
    const pair = pairOf(finding);
    const matches = MERGE_DETECTORS[finding.detector] ? pair !== null && samePair(pair, params) : acceptsExplicitMerge(finding, params);
    checks.push(matches
      ? { key: "par", ok: true }
      : { key: "par", ok: false, code: "invalid", message: "las fichas no son las del hallazgo" });
    const spec = ENTITY_SPECS[params.kind];
    const { rows } = await ctx.client.query<{ id: string }>(
      `SELECT id::text FROM ${spec.table} WHERE id = ANY($1::bigint[])`, [[params.keepId, params.dropId]]);
    const present = new Set(rows.map((row) => Number(row.id)));
    const missing = [params.keepId, params.dropId].filter((id) => !present.has(id));
    checks.push(missing.length === 0
      ? { key: "fichas", ok: true }
      : { key: "fichas", ok: false, code: "stale", message: `${params.kind} ${missing.join(" y ")} ya no existe (¿se fusionó o retiró?)` });
    const [a, b] = params.keepId < params.dropId ? [params.keepId, params.dropId] : [params.dropId, params.keepId];
    const distinct = await ctx.client.query(
      "SELECT 1 FROM ingest.curation_distinct_pairs WHERE kind = $1 AND a_id = $2 AND b_id = $3", [params.kind, a, b]);
    checks.push(distinct.rowCount
      ? { key: "no_declaradas_distintas", ok: false, code: "not_applicable", message: "alguien declaró que estas dos fichas son distintas" }
      : { key: "no_declaradas_distintas", ok: true });
    return checks;
  },

  async preview(finding, params, ctx) {
    const { kind } = params;
    if (ctx.mode === "preview") {
      // Un ítem anterior del lote ya hace desaparecer alguna de las dos fichas.
      const follow = (id: number): { id: number; by: number | null } => {
        let current = id;
        let by: number | null = null;
        for (let hops = 0; hops < 50; hops += 1) {
          const moved = ctx.pending.get(mergeKey(kind, current));
          if (!moved) break;
          current = Number(moved.value);
          by = moved.findingId;
        }
        return { id: current, by };
      };
      const keep = follow(params.keepId);
      const drop = follow(params.dropId);
      if (keep.by !== null || drop.by !== null) {
        if (keep.id === drop.id) {
          return { ...blocked(params, "noop", "otro ítem del lote ya fusiona estas fichas"), blocked: null, noop: { coveredBy: drop.by ?? keep.by } };
        }
        return blocked(params, "stale",
          `${kind} ${keep.by !== null ? params.keepId : params.dropId} ya desaparece por otra fusión de este lote: se volverá a proponer tras verificar`);
      }
    } else {
      // El mismo orden de candados que `mergeEntities`: primero el global de fusiones, luego las filas.
      await ctx.client.query("SELECT pg_advisory_xact_lock(hashtext('merge:duplicates'))");
    }
    let merge: EntityMergePreview;
    try {
      merge = await cachedPreview(ctx, kind, params.keepId, params.dropId);
    } catch (error) {
      if (error instanceof OperatorError && error.code === "not_found") return blocked(params, "stale", error.message);
      if (error instanceof OperatorError && error.code === "invalid") return blocked(params, "invalid", error.message);
      throw error;
    }
    const warnings = [...merge.warnings];
    if (merge.fieldConflicts.length) {
      warnings.push(`Valores distintos en ${merge.fieldConflicts.map((conflict) => conflict.field).join(", ")}: se conserva el de «${merge.keep.name}».`);
    }
    if (merge.reviewsBetween.length) warnings.push(`Hay ${merge.reviewsBetween.length} revisión(es) abiertas entre estas dos fichas.`);
    return {
      touched: [{ kind, id: merge.keep.id }, { kind, id: merge.drop.id }],
      before: { keep: sideView(merge.keep), drop: sideView(merge.drop) },
      after: {
        keep: { id: merge.keep.id, name: merge.keep.name },
        removed: { id: merge.drop.id, name: merge.drop.name },
        nameAsAlias: merge.drop.name,
        aliasesMoved: merge.aliasesToAdd,
        fieldsFilled: merge.fieldsFilledFromDrop.map((field) => ({ field, value: merge.drop.fields[field] ?? null })),
        fieldConflicts: merge.fieldConflicts.map((conflict) => ({ field: conflict.field, kept: conflict.keepValue, discarded: conflict.dropValue })),
        recommendedKeepId: merge.recommendedKeepId,
      },
      blocked: null,
      collisions: [],
      warnings,
      proposal: null,
      hashMaterial: merge.previewHash,
      chain: { key: mergeKey(kind, merge.drop.id), value: String(merge.keep.id) },
    };
  },

  async apply(context, _finding, params, preview) {
    if (typeof preview.hashMaterial !== "string") throw new OperatorError("invalid", "vista previa de fusión sin hash");
    const result = await mergeEntities(context, {
      kind: params.kind, keepId: params.keepId, dropId: params.dropId, previewHash: preview.hashMaterial, keepDropNameAsAlias: true,
    });
    return {
      after: {
        keep: { id: result.keepId }, removed: { id: result.dropId }, auditId: result.auditId,
        moved: result.moved, discarded: result.discarded, filled: result.filled,
        creditsMerged: result.creditsMerged, membershipsMerged: result.membershipsMerged,
      },
    };
  },
};
