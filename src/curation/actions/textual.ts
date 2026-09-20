// CRV · Acciones de texto de Curaduría (PLAN_CURADURIA E5).
//
// Estas acciones parecen renombrados sencillos, pero no son un `UPDATE` libre:
// cada una declara de qué detector sale, qué texto propone, compara contra el
// valor que vio el análisis, enseña la colisión antes de escribir y deja un
// diario reversible. Las que convierten una parte del nombre en alias lo hacen
// dentro del mismo run para que el deshacer retire también ese alias.
import type { PoolClient } from "pg";
import { z } from "zod";
import { createAlias, type AliasKind } from "../../api/repositories/aliases.js";
import { canonicalFieldValue } from "../../merge/engine.js";
import { withFieldJournal } from "../../merge/field-undo.js";
import { OperatorError, updateEntity } from "../../merge/operator.js";
import { ENTITY_SPECS, type ResolvableClaimKind } from "../../merge/specs.js";
import {
  capitalizeSpanish, decodeHtmlEntitiesValue, domainAliasSuggestion, repairCp1251, repairMojibake,
  substituteCyrillicHomoglyphs, trimDanglingPunctuation,
} from "../detectors/text-hygiene.js";
import { nameKey } from "../lexicon.js";
import type {
  ActionContext, ActionFinding, ActionLevel, ActionPreview, FixActionDefinition, Precondition,
} from "./types.js";

const ENTITY_KINDS = new Set<string>(["artist", "person", "organization", "album", "track"]);
const ALIAS_TYPES = ["name_variant", "spelling_variant", "former_name", "stage_name", "acronym", "misspelling", "alternate_title", "other"] as const;

const fieldSchema = z.enum(["name", "title"]);
const valueSchema = z.string().trim().min(1).max(2_000);

const renameParamsSchema = z.object({
  field: fieldSchema,
  /** El valor se calcula al analizar; puede editarse en una corrección individual. */
  value: valueSchema,
  /** Algunas limpiezas separan un dato útil en un alias, no lo descartan. */
  alias: valueSchema.optional(),
  aliasType: z.enum(ALIAS_TYPES).optional(),
}).strict();

type RenameParams = z.infer<typeof renameParamsSchema>;

interface Target {
  kind: ResolvableClaimKind;
  id: number;
  field: "name" | "title";
  column: string;
}

function targetOf(finding: ActionFinding): Target | null {
  const kind = finding.entity.kind;
  if (!ENTITY_KINDS.has(kind) || finding.entity.id === null) return null;
  const spec = ENTITY_SPECS[kind as ResolvableClaimKind];
  if (finding.field !== spec.identityColumn) return null;
  return {
    kind: kind as ResolvableClaimKind,
    id: finding.entity.id,
    field: spec.identityColumn,
    column: spec.identityColumn,
  };
}

const chainKey = (target: Target): string => `${target.kind}:${target.id}:${target.field}`;

async function readLive(client: PoolClient, target: Target, lock: boolean): Promise<string | null | undefined> {
  const spec = ENTITY_SPECS[target.kind];
  const { rows } = await client.query<{ value: string | null }>(
    `SELECT ${target.column}::text AS value FROM ${spec.table} WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [target.id],
  );
  return rows[0] ? rows[0].value : undefined;
}

function blocked(target: Target | null, code: NonNullable<ActionPreview["blocked"]>["code"], message: string, before: Record<string, unknown> = {}): ActionPreview {
  return {
    touched: target ? [{ kind: target.kind, id: target.id }] : [],
    before,
    after: {},
    blocked: { code, message },
    collisions: [],
    warnings: [],
    proposal: null,
  };
}

function byteLimit(field: Target["field"]): number {
  return field === "name" ? 200 : 250;
}

function canonical(value: string, target: Target): string | null {
  try {
    const normalized = String(canonicalFieldValue(value, target.field, "human") ?? "");
    if (!normalized || Buffer.byteLength(normalized, "utf8") > byteLimit(target.field)) return null;
    return normalized;
  } catch {
    return null;
  }
}

/**
 * Aplica al valor que dejó un ítem anterior la diferencia determinista que el
 * detector vio entre `finding.value` y su sugerencia. Sin esto, una acción de
 * E5 calculada sobre «juan + U+200B + -» podría volver a introducir el
 * invisible o el guion que una acción anterior del mismo lote acababa de
 * quitar. Los valores editados a mano siguen siendo absolutos: la persona
 * eligió exactamente ese resultado para una corrección individual.
 */
function composeSuggestedValue(config: RenameConfig, finding: ActionFinding, params: RenameParams, before: string): string {
  const original = finding.value;
  const suggested = config.value?.(finding) ?? null;
  if (original === null || suggested === null || params.value !== suggested || before === original) return params.value;
  // Las acciones semánticas conocen su transformación mejor que un diff de
  // caracteres. Por ejemplo, recortar signos debe mirar los extremos del valor
  // actual, no reutilizar la cadena que vio antes de quitar un U+200B.
  const transformed = config.transform?.(before, finding, params);
  if (transformed !== undefined) return transformed;
  let prefix = 0;
  while (prefix < original.length && prefix < suggested.length && original[prefix] === suggested[prefix]) prefix += 1;
  let suffix = 0;
  while (suffix < original.length - prefix && suffix < suggested.length - prefix
    && original[original.length - 1 - suffix] === suggested[suggested.length - 1 - suffix]) suffix += 1;
  const removed = original.slice(prefix, original.length - suffix);
  const inserted = suggested.slice(prefix, suggested.length - suffix);
  if (removed) {
    const at = before.indexOf(removed);
    if (at >= 0) return `${before.slice(0, at)}${inserted}${before.slice(at + removed.length)}`;
    // No se pudo reconocer el fragmento porque otra acción ya lo modificó.
    // Conservar el valor intermedio es seguro; reponer la sugerencia antigua
    // desharía silenciosamente la corrección anterior.
    return before;
  }
  // Inserción pura («Poster» → «Poster» + comilla, «BambaBonus» →
  // «Bamba Bonus»). El prefijo anterior al punto de inserción es una ancla
  // más estable que una posición cuando otro ítem quitó invisibles.
  const anchor = original.slice(0, prefix);
  if (anchor && before.startsWith(anchor)) return `${before.slice(0, anchor.length)}${inserted}${before.slice(anchor.length)}`;
  if (!anchor && prefix === 0) return `${inserted}${before}`;
  return before;
}

function evidenceString(finding: ActionFinding, key: string): string | null {
  const value = finding.evidence[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

interface AliasInput { alias: string; aliasType: (typeof ALIAS_TYPES)[number] }

interface RenameConfig {
  key: string;
  label: string;
  description: string;
  level: ActionLevel;
  levelFor?(finding: ActionFinding, params: RenameParams | null): ActionLevel;
  /** Orden estable cuando dos hallazgos cambian el mismo nombre en un lote. */
  rank: number;
  matches(finding: ActionFinding): boolean;
  /** Por defecto sale de `suggestedValue`; las acciones ambiguas lo pueden omitir. */
  value?(finding: ActionFinding): string | null;
  alias?(finding: ActionFinding): AliasInput | null;
  /** Aplica la regla semántica al valor que dejó un ítem anterior del lote. */
  transform?(before: string, finding: ActionFinding, params: RenameParams): string | undefined;
  /** Una opción manual debe seguir siendo una salida que el detector mostró. */
  acceptsValue?(finding: ActionFinding, value: string): boolean;
}

function suggestedValue(finding: ActionFinding): string | null {
  return finding.suggestedValue?.trim() || null;
}

function validFor(config: RenameConfig, finding: ActionFinding): boolean {
  const target = targetOf(finding);
  if (!target || !config.matches(finding)) return false;
  const value = config.value?.(finding);
  return value !== null && value !== undefined && (!config.alias || config.alias(finding) !== null);
}

/** Solo las acciones que declaran un alias pueden crear uno. */
function aliasFor(config: RenameConfig, finding: ActionFinding, params: RenameParams): AliasInput | null {
  if (!config.alias || !params.alias || !params.aliasType) return null;
  return { alias: params.alias, aliasType: params.aliasType };
}

function preconditionsFor(config: RenameConfig, finding: ActionFinding, params: RenameParams, ctx: ActionContext): Promise<Precondition[]> {
  return (async () => {
    const target = targetOf(finding);
    const checks: Precondition[] = [];
    checks.push(target && params.field === target.field
      ? { key: "campo", ok: true }
      : { key: "campo", ok: false, code: "invalid", message: "la acción solo se aplica al nombre o título de la ficha del hallazgo" });
    const expectedAlias = config.alias?.(finding) ?? null;
    const providedAlias = params.alias !== undefined || params.aliasType !== undefined;
    if (!expectedAlias) {
      checks.push(!providedAlias
        ? { key: "alias", ok: true }
        : { key: "alias", ok: false, code: "invalid", message: "esta acción no crea aliases" });
    } else {
      checks.push(params.alias && params.aliasType
        ? { key: "alias", ok: true }
        : { key: "alias", ok: false, code: "invalid", message: "la acción necesita conservar el dato separado como alias" });
      const customAlias = params.alias !== expectedAlias.alias || params.aliasType !== expectedAlias.aliasType;
      checks.push(!customAlias || ctx.batchMode === "individual"
        ? { key: "alias_determinista", ok: true }
        : { key: "alias_determinista", ok: false, code: "invalid", message: "un alias distinto del detectado solo vale para una corrección individual" });
    }
    // La recomendación es determinista. Un texto distinto equivale a una
    // decisión humana —útil para corregir una propuesta con una letra— y no
    // puede convertirse en una escritura masiva por selección o por grupo.
    const suggested = config.value?.(finding) ?? null;
    const custom = suggested !== null && params.value !== suggested;
    const declaredOption = config.acceptsValue?.(finding, params.value) === true;
    checks.push(!custom || ctx.batchMode === "individual" || declaredOption
      ? { key: "valor_determinista", ok: true }
      : { key: "valor_determinista", ok: false, code: "invalid", message: "un valor distinto de la sugerencia solo vale para una corrección individual" });
    if (!target) return checks;
    const live = await readLive(ctx.client, target, false);
    if (live === undefined) {
      checks.push({ key: "ficha", ok: false, code: "stale", message: `${target.kind} ${target.id} ya no existe` });
      return checks;
    }
    checks.push({ key: "ficha", ok: true });
    // El valor original solo se compara mientras se planifica. Al aplicar, el
    // hash y el candado permiten que una cadena continúe desde el ítem previo.
    if (ctx.mode === "preview") {
      checks.push(live === finding.value
        ? { key: "valor_detectado", ok: true }
        : { key: "valor_detectado", ok: false, code: "stale", message: `la ficha ya cambió desde el análisis: ahora dice «${live ?? ""}»` });
    }
    return checks;
  })();
}

async function renamePreview(config: RenameConfig, finding: ActionFinding, params: RenameParams, ctx: ActionContext): Promise<ActionPreview> {
  const target = targetOf(finding);
  if (!target) return blocked(null, "invalid", "el hallazgo no apunta al nombre o título de una ficha");
  const live = await readLive(ctx.client, target, ctx.mode === "apply");
  if (live === undefined) return blocked(target, "stale", `${target.kind} ${target.id} ya no existe`);
  const key = chainKey(target);
  const pending = ctx.mode === "preview" ? ctx.pending.get(key) : undefined;
  const before = pending?.value ?? live ?? "";
  const beforeView = { field: target.field, value: before };
  const after = canonical(composeSuggestedValue(config, finding, params, before), target);
  if (after === null) {
    const limit = byteLimit(target.field);
    return blocked(target, "invalid", `el valor debe ser visible y caber en los ${limit} bytes del catálogo`, beforeView);
  }
  const alias = aliasFor(config, finding, params);
  const base: Omit<ActionPreview, "blocked" | "proposal"> = {
    touched: [{ kind: target.kind, id: target.id }],
    before: beforeView,
    after: { field: target.field, value: after, ...(alias ? { aliases: [alias] } : {}) },
    collisions: [],
    warnings: [],
    chain: { key, value: after },
  };
  if (after === before && !alias) return { ...base, blocked: null, proposal: null, noop: { coveredBy: pending?.findingId ?? null } };

  const collisions = await ctx.names.similar(target.kind, target.id, after);
  const exact = target.kind === "artist" ? collisions.find((collision) => collision.exact) : undefined;
  if (exact) {
    const { chain: _chain, ...unchained } = base;
    return {
      ...unchained,
      collisions,
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
  if (alias && alias.alias === after) warnings.push("El alias coincide con el nombre final y no se añadirá dos veces.");
  return { ...base, collisions, warnings, blocked: null, proposal: null };
}

async function addAliasIfMissing(context: Parameters<FixActionDefinition["apply"]>[0], target: Target, alias: AliasInput, finalName: string): Promise<void> {
  if (alias.alias === finalName) return;
  const spec = ENTITY_SPECS[target.kind];
  const existing = await context.client.query(
    `SELECT 1 FROM ${spec.aliasTable} WHERE ${spec.aliasTargetColumn}=$1 AND alias=$2`,
    [target.id, alias.alias],
  );
  if (!existing.rowCount) {
    await createAlias(context, target.kind as AliasKind, target.id, {
      alias: alias.alias,
      aliasType: alias.aliasType,
      isPrimary: false,
    });
  }
}

function makeRenameAction(config: RenameConfig): FixActionDefinition<RenameParams> {
  return {
    key: config.key,
    label: config.label,
    description: config.description,
    level: config.level,
    inverse: "field_restore",
    paramsSchema: renameParamsSchema,

    appliesTo(finding) {
      return validFor(config, finding);
    },

    acceptsExplicit(finding, params) {
      const target = targetOf(finding);
      return target !== null && config.matches(finding)
        && (!config.alias || config.alias(finding) !== null)
        && (config.acceptsValue?.(finding, params.value) ?? true);
    },

    levelFor(finding, params) {
      return config.levelFor?.(finding, params) ?? config.level;
    },

    async defaultParams(finding) {
      const target = targetOf(finding);
      const value = config.value?.(finding) ?? null;
      if (!target || !value) return null;
      const alias = config.alias?.(finding) ?? null;
      return { field: target.field, value, ...(alias ? { alias: alias.alias, aliasType: alias.aliasType } : {}) };
    },

    chain(finding) {
      const target = targetOf(finding);
      return target ? { key: chainKey(target), rank: config.rank } : null;
    },

    preconditions(finding, params, ctx) {
      return preconditionsFor(config, finding, params, ctx);
    },

    preview(finding, params, ctx) {
      return renamePreview(config, finding, params, ctx);
    },

    async apply(context, finding, params, preview) {
      const target = targetOf(finding);
      const value = preview.after["value"];
      if (!target || typeof value !== "string") throw new OperatorError("invalid", "vista previa sin nombre o título que aplicar");
      const alias = aliasFor(config, finding, params);
      await withFieldJournal(context, { kind: target.kind, id: target.id, fields: [target.field] }, async () => {
        await updateEntity(context, target.kind, target.id, { [target.field]: value });
        if (alias) await addAliasIfMissing(context, target, alias, value);
      });
      const stored = await readLive(context.client, target, false);
      if (stored !== value) throw new OperatorError("invalid", `el motor dejó «${stored ?? ""}» en lugar de «${value}»`, { entity: target.kind, id: target.id });
      return { after: { field: target.field, value: stored, ...(alias ? { aliases: [alias] } : {}) } };
    },
  };
}

const is = (detector: string, signature?: string) => (finding: ActionFinding): boolean =>
  finding.detector === detector && (signature === undefined || finding.signature === signature);

const repairedAs = (kind: string) => (finding: ActionFinding): boolean => {
  const repair = finding.evidence["repair"];
  return typeof repair === "object" && repair !== null && (repair as Record<string, unknown>)["kind"] === kind;
};

/** Valor de una reparación de letra perdida: las otras opciones se piden explícitamente desde la UI. */
function letterValue(finding: ActionFinding): string | null {
  const suggested = suggestedValue(finding);
  if (suggested) return suggested;
  const candidates = finding.evidence["candidates"];
  return Array.isArray(candidates) && typeof candidates[0] === "string" ? candidates[0] : null;
}

function letterCandidate(finding: ActionFinding, value: string): boolean {
  const candidates = finding.evidence["candidates"];
  return Array.isArray(candidates) && candidates.includes(value);
}

function restoreQuestionMark(before: string, finding: ActionFinding, params: RenameParams): string | undefined {
  const original = finding.value;
  if (!original) return undefined;
  const mark = original.indexOf("?");
  const liveMark = before.indexOf("?");
  if (mark < 0 || liveMark < 0) return before;
  const prefix = original.slice(0, mark);
  const suffix = original.slice(mark + 1);
  if (!params.value.startsWith(prefix) || !params.value.endsWith(suffix)) return undefined;
  const replacement = params.value.slice(prefix.length, params.value.length - suffix.length);
  return replacement ? `${before.slice(0, liveMark)}${replacement}${before.slice(liveMark + 1)}` : undefined;
}

function removeEdgeMark(before: string, finding: ActionFinding): string | undefined {
  const mark = evidenceString(finding, "mark");
  if (!mark) return undefined;
  const first = before.search(/\S/u);
  const last = before.search(/\S\s*$/u);
  if (first >= 0 && before.startsWith(mark, first)) return `${before.slice(0, first)}${before.slice(first + mark.length)}`.trim();
  if (last >= 0 && before.startsWith(mark, last)) return `${before.slice(0, last)}${before.slice(last + mark.length)}`.trim();
  return undefined;
}

const CLOSE_SIGN: Readonly<Record<string, string>> = { "(": ")", "[": "]", "{": "}", "«": "»", "“": "”", "\"": "\"" };

function closeUnbalancedMark(before: string, finding: ActionFinding): string | undefined {
  const mark = evidenceString(finding, "mark");
  const close = mark ? CLOSE_SIGN[mark] : undefined;
  if (!close) return undefined;
  const trimmed = before.trimEnd();
  return trimmed.endsWith(close) ? before : `${trimmed}${close}`;
}

function removeArtistPrefix(before: string, _finding: ActionFinding, params: RenameParams): string | undefined {
  const match = /^(.+?)\s*(?:\s[-–—]|:)\s+(.+)$/u.exec(before);
  if (!match) return undefined;
  const candidates = [match[1]!.trim(), match[2]!.trim()];
  return candidates.find((candidate) => nameKey(candidate) === nameKey(params.value));
}

function removeLabel(before: string, _finding: ActionFinding, params: RenameParams): string | undefined {
  let index = before.indexOf(":");
  while (index >= 0) {
    const candidate = before.slice(index + 1).trim();
    if (candidate && nameKey(candidate) === nameKey(params.value)) return candidate;
    index = before.indexOf(":", index + 1);
  }
  return undefined;
}

function separateKnownWords(before: string, finding: ActionFinding): string | undefined {
  const words = finding.evidence["words"];
  if (!Array.isArray(words)) return undefined;
  let output = before;
  let changed = false;
  for (const word of words) {
    if (typeof word !== "object" || word === null) continue;
    const left = (word as Record<string, unknown>)["left"];
    const right = (word as Record<string, unknown>)["right"];
    if (typeof left !== "string" || typeof right !== "string" || !left || !right) continue;
    const glued = `${left}${right}`;
    const index = output.indexOf(glued);
    if (index < 0) continue;
    output = `${output.slice(0, index)}${left} ${right}${output.slice(index + glued.length)}`;
    changed = true;
  }
  return changed ? output : undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function removeTrailingRegion(before: string, finding: ActionFinding): string | undefined {
  const region = evidenceString(finding, "region");
  if (!region) return undefined;
  const trailing = new RegExp(`\\s*\\(${escapeRegExp(region)}\\)\\s*$`, "iu");
  return trailing.test(before) ? before.replace(trailing, "").trim() : undefined;
}

function removeAliasFromName(before: string, finding: ActionFinding, params: RenameParams): string | undefined {
  const expectedAlias = evidenceString(finding, "alias");
  if (!expectedAlias) return undefined;
  const match = /^(.+?)\s*(?:[([]\s*)?\b(?:aka|a\.k\.a\.?|alias)\s+(.+?)\s*[)\]]?\s*$|^(.+?)\s+as\s+["“«](.+?)["”»]\s*$/iu.exec(before);
  if (!match) return undefined;
  const base = (match[1] ?? match[3])?.trim();
  const alias = (match[2] ?? match[4])?.replace(/^["“«]|["”»]$/gu, "").trim();
  return base && alias && nameKey(base) === nameKey(params.value) && nameKey(alias) === nameKey(expectedAlias) ? base : undefined;
}

export const decodeHtmlAction = makeRenameAction({
  key: "decodificar_html",
  label: "Decodificar HTML",
  description: "Decodifica la entidad HTML visible con la misma tabla HTML5 que usó el detector.",
  level: 0,
  rank: 10,
  matches: is("entidades_html"),
  value: suggestedValue,
  transform: (before) => decodeHtmlEntitiesValue(before),
});

export const repairEncodingAction = makeRenameAction({
  key: "reparar_codificacion",
  label: "Reparar la codificación",
  description: "Recupera texto UTF-8 leído como Latin-1 o Windows-1252, incluido el mojibake de comillas y euros.",
  level: 1,
  rank: 0,
  matches: is("codificacion_rota", "mojibake"),
  value: suggestedValue,
  transform: (before) => repairMojibake(before) ?? before,
});

export const repairCp1251Action = makeRenameAction({
  key: "reparar_cp1251",
  label: "Reparar UTF-8 leído como CP1251",
  description: "Recupera una palabra latina cuyos bytes UTF-8 aparecieron como caracteres cirílicos.",
  level: 1,
  rank: 0,
  matches: (finding) => is("codificacion_rota", "mezcla_de_alfabetos")(finding) && repairedAs("cp1251")(finding),
  value: suggestedValue,
  transform: (before) => repairCp1251(before) ?? before,
});

export const substituteHomoglyphsAction = makeRenameAction({
  key: "sustituir_homoglifos",
  label: "Sustituir letras suplantadas",
  description: "Cambia letras cirílicas visualmente iguales por sus letras latinas cuando el vocabulario confirma la palabra.",
  level: 1,
  rank: 0,
  matches: (finding) => is("codificacion_rota", "mezcla_de_alfabetos")(finding) && repairedAs("homoglifos")(finding),
  value: suggestedValue,
  transform: (before) => substituteCyrillicHomoglyphs(before) ?? before,
});

export const restoreLetterAction = makeRenameAction({
  key: "restaurar_letra",
  label: "Restaurar la letra perdida",
  description: "Restaura una letra sustituida por «?» cuando el vocabulario del catálogo deja una única opción.",
  level: 1,
  rank: 8,
  matches: (finding) => is("codificacion_rota", "letra_perdida")(finding) && repairedAs("letra")(finding),
  value: letterValue,
  levelFor(finding) {
    const candidates = finding.evidence["candidates"];
    return Array.isArray(candidates) && candidates.length > 1 ? 2 : 1;
  },
  acceptsValue: letterCandidate,
  transform: restoreQuestionMark,
});

export const removeOrphanSignAction = makeRenameAction({
  key: "quitar_signo_huerfano",
  label: "Quitar el signo huérfano",
  description: "Quita un paréntesis, corchete o comilla sin pareja que está en el borde del texto.",
  level: 1,
  rank: 20,
  matches: (finding) => is("signos_sin_cerrar")(finding) && repairedAs("quitar_signo")(finding),
  value: suggestedValue,
  transform: removeEdgeMark,
});

export const closeSignAction = makeRenameAction({
  key: "cerrar_signo",
  label: "Cerrar el signo",
  description: "Añade el signo de cierre que falta cuando el texto conserva una aclaración abierta.",
  level: 1,
  rank: 20,
  matches: (finding) => is("signos_sin_cerrar")(finding) && repairedAs("cerrar_signo")(finding),
  value: suggestedValue,
  transform: closeUnbalancedMark,
});

export const trimEdgesAction = makeRenameAction({
  key: "recortar_extremos",
  label: "Recortar los extremos",
  description: "Quita el guion, coma, barra u otro signo que quedó suelto al inicio o al final.",
  level: 0,
  rank: 20,
  matches: is("signos_colgantes"),
  value: suggestedValue,
  transform: (before) => trimDanglingPunctuation(before),
  levelFor(finding) {
    const value = finding.value ?? "";
    const after = suggestedValue(finding) ?? "";
    const at = after ? value.indexOf(after) : -1;
    if (at < 0) return 1;
    const removed = [value.slice(0, at), value.slice(at + after.length)]
      .map((part) => part.trim())
      .filter(Boolean);
    return removed.length > 0 && removed.every((part) => ["-", ",", "/"].includes(part)) ? 0 : 1;
  },
});

export const capitalizeAction = makeRenameAction({
  key: "capitalizar",
  label: "Capitalizar el nombre",
  description: "Aplica mayúsculas de título en español y conserva partículas como de, del, la e y en minúscula.",
  level: 1,
  rank: 25,
  matches: is("minusculas", "mayusculas_sostenidas"),
  value: suggestedValue,
  transform: (before) => capitalizeSpanish(before),
});

export const domainToAliasAction = makeRenameAction({
  key: "dominio_a_alias",
  label: "Separar dominio como alias",
  description: "Deja el nombre sin el TLD y conserva el dominio original como alias consultable.",
  level: 2,
  rank: 30,
  matches: is("url_en_nombre"),
  value: suggestedValue,
  transform: (before) => domainAliasSuggestion(before)?.name ?? before,
  alias: (finding) => {
    const domain = evidenceString(finding, "domain");
    return domain ? { alias: domain, aliasType: "other" } : null;
  },
});

export const removeArtistPrefixAction = makeRenameAction({
  key: "quitar_prefijo_artista",
  label: "Quitar el prefijo del artista",
  description: "Deja en el título únicamente la obra cuando el propio artista del disco ya estaba repetido delante.",
  level: 1,
  rank: 30,
  matches: (finding) => (is("artista_en_titulo_de_pista", "repite_artista_del_disco")(finding)
    || is("artista_en_titulo_de_disco")(finding)),
  value: suggestedValue,
  transform: removeArtistPrefix,
});

export const removeLabelAction = makeRenameAction({
  key: "quitar_rotulo",
  label: "Quitar el rótulo",
  description: "Quita una etiqueta editorial como «Banda:» cuando el resto ya es el nombre de la ficha.",
  level: 1,
  rank: 30,
  matches: is("etiqueta_en_nombre", "etiqueta"),
  value: suggestedValue,
  transform: removeLabel,
});

export const separateWordsAction = makeRenameAction({
  key: "separar_palabras",
  label: "Separar las palabras",
  description: "Inserta el espacio que el extractor perdió entre dos palabras que el catálogo conoce por separado.",
  level: 2,
  rank: 30,
  matches: is("palabras_pegadas", "palabras_pegadas"),
  value: suggestedValue,
  transform: separateKnownWords,
});

export const renameWithAliasAction = makeRenameAction({
  key: "renombrar_con_alias",
  label: "Renombrar y conservar el alias",
  description: "Separa un «aka», «alias» o «as» del nombre de una persona y lo conserva como alias.",
  level: 1,
  rank: 30,
  matches: is("varias_personas_en_una", "alias_en_nombre"),
  value: suggestedValue,
  transform: removeAliasFromName,
  alias: (finding) => {
    const alias = evidenceString(finding, "alias");
    return alias ? { alias, aliasType: "stage_name" } : null;
  },
});

const moveRegionParamsSchema = z.object({
  field: fieldSchema,
  value: valueSchema,
  region: z.string().trim().min(1).max(200),
}).strict();

type MoveRegionParams = z.infer<typeof moveRegionParamsSchema>;

async function readOriginCity(client: PoolClient, id: number, lock: boolean): Promise<string | null | undefined> {
  const { rows } = await client.query<{ value: string | null }>(
    `SELECT origin_city::text AS value FROM public.artists WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
    [id],
  );
  return rows[0] ? rows[0].value : undefined;
}

const moveRegionConfig: RenameConfig = {
  key: "mover_region",
  label: "Mover la región al origen",
  description: "Quita la ciudad del nombre del artista y la guarda en el campo de origen si todavía está vacío.",
  level: 1,
  rank: 30,
  matches: is("aclaracion_en_nombre_de_artista", "region"),
  value: suggestedValue,
  transform: removeTrailingRegion,
};

export const moveRegionAction: FixActionDefinition<MoveRegionParams> = {
  key: moveRegionConfig.key,
  label: moveRegionConfig.label,
  description: moveRegionConfig.description,
  level: 1,
  inverse: "field_restore",
  paramsSchema: moveRegionParamsSchema,

  appliesTo(finding) {
    return validFor(moveRegionConfig, finding) && evidenceString(finding, "region") !== null;
  },

  acceptsExplicit(finding) {
    return targetOf(finding)?.kind === "artist" && moveRegionConfig.matches(finding);
  },

  levelFor() {
    return 1;
  },

  async defaultParams(finding) {
    const target = targetOf(finding);
    const value = suggestedValue(finding);
    const region = evidenceString(finding, "region");
    return target?.kind === "artist" && value && region ? { field: "name", value, region } : null;
  },

  chain(finding) {
    const target = targetOf(finding);
    return target ? { key: chainKey(target), rank: moveRegionConfig.rank } : null;
  },

  async preconditions(finding, params, ctx) {
    const checks = await preconditionsFor(moveRegionConfig, finding, params, ctx);
    const detectedRegion = evidenceString(finding, "region");
    checks.push(detectedRegion !== null && (params.region === detectedRegion || ctx.batchMode === "individual")
      ? { key: "region_determinista", ok: true }
      : { key: "region_determinista", ok: false, code: "invalid", message: "una región distinta de la detectada solo vale para una corrección individual" });
    return checks;
  },

  async preview(finding, params, ctx) {
    const target = targetOf(finding);
    if (!target || target.kind !== "artist") return blocked(target, "invalid", "la región solo se mueve desde el nombre de un artista");
    const rename = await renamePreview(moveRegionConfig, finding, params, ctx);
    if (rename.blocked) return rename;
    const originCity = await readOriginCity(ctx.client, target.id, ctx.mode === "apply");
    if (originCity === undefined) return blocked(target, "stale", `artist ${target.id} ya no existe`, rename.before);
    const setOriginCity = !originCity?.trim();
    const warnings = [...rename.warnings];
    if (!setOriginCity && originCity !== params.region) {
      warnings.push(`El origen ya dice «${originCity}»; se conserva y solo se limpia el nombre.`);
    }
    return {
      ...rename,
      before: { ...rename.before, originCity },
      after: { ...rename.after, originCity: setOriginCity ? params.region : originCity, setOriginCity },
      warnings,
    };
  },

  async apply(context, finding, _params, preview) {
    const target = targetOf(finding);
    const value = preview.after["value"];
    const setOriginCity = preview.after["setOriginCity"] === true;
    const originCity = preview.after["originCity"];
    if (!target || target.kind !== "artist" || typeof value !== "string") {
      throw new OperatorError("invalid", "vista previa sin artista y nombre que aplicar");
    }
    await withFieldJournal(context, {
      kind: "artist", id: target.id, fields: ["name", ...(setOriginCity ? ["origin_city"] : [])],
    }, () => updateEntity(context, "artist", target.id, {
      name: value,
      ...(setOriginCity && typeof originCity === "string" ? { origin_city: originCity } : {}),
    }));
    const [storedName, storedCity] = await Promise.all([
      readLive(context.client, target, false), readOriginCity(context.client, target.id, false),
    ]);
    if (storedName !== value || (setOriginCity && storedCity !== originCity)) {
      throw new OperatorError("invalid", "el motor no dejó los valores que prometía la vista previa", { entity: "artist", id: target.id });
    }
    return { after: { field: "name", value: storedName, originCity: storedCity, setOriginCity } };
  },
};

/** Las acciones que E5 incorpora al registro, en el orden de recomendación de cada detector. */
export const TEXTUAL_ACTIONS = [
  decodeHtmlAction,
  repairEncodingAction,
  repairCp1251Action,
  substituteHomoglyphsAction,
  restoreLetterAction,
  removeOrphanSignAction,
  closeSignAction,
  trimEdgesAction,
  capitalizeAction,
  domainToAliasAction,
  removeArtistPrefixAction,
  removeLabelAction,
  separateWordsAction,
  moveRegionAction,
  renameWithAliasAction,
] as const;
