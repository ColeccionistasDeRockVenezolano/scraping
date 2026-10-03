// CRV · De la etiqueta externa a una propuesta de género (PLAN_GENEROS
// etapa 4, puntos 5 a 9).
//
// Funciones puras. La fuente externa no decide nada: cada valor se mira contra
// la taxonomía aprobada de CRV y sale como propuesta, como caso de revisión o
// descartado, con el motivo escrito.
//
//  * LAS CLASES NO SE MEZCLAN. Un género editorial, una etiqueta comunitaria y
//    una categoría técnica de la plataforma llegan marcadas y la ficha de la
//    fuente decide cuáles se aceptan y con cuántos votos.
//  * NADA SE INVENTA. Un término sin alias aprobado no crea género: va a
//    revisión como «sin equivalencia», igual que en la etapa 2.
//  * LO DEMASIADO GENERAL NO BORRA PRECISIÓN. Una etiqueta que solo dice la
//    familia cuando CRV ya tiene un hijo de esa familia no se propone.
//  * NUNCA SE TOCA LO CONFIRMADO. Lo que CRV ya confirmó o rechazó no se
//    vuelve a proponer; si la fuente lo contradice, se anota como desacuerdo.
import { normalizeGenreText } from "../normalize.js";
import { familyOf, isAncestorOf, resolveGenreValue, type Taxonomy } from "../taxonomy.js";

/** Clase de etiqueta tal como la publica la fuente. */
export type ExternalTagKind = "editorial_genre" | "community_tag" | "technical";

export interface ExternalGenreValue {
  value: string;
  kind: ExternalTagKind;
  /** Votos de la comunidad, cuando la fuente los publica. */
  count?: number | null;
}

export interface TagPolicy {
  /** Clases que esta fuente tiene permitido aportar. */
  acceptKinds: ExternalTagKind[];
  /** Votos mínimos de una etiqueta comunitaria para tenerse en cuenta. */
  minTagCount: number;
  /** Cuántos valores como mucho se proponen por ficha. */
  maxValues: number;
  /**
   * Cajones de la fuente: un término suyo que abarca varias familias de CRV.
   * Discogs usa «Rock» como cajón que *contiene* al metal y al punk, mientras
   * que en CRV esas tres son familias hermanas. Sin declararlo, un nu-metal
   * etiquetado «Rock» sale como desacuerdo sin serlo y la precisión medida
   * baja por un artefacto de taxonomía, no por un error de la fuente.
   *
   * Clave: el término de la fuente, normalizado. Valor: los slugs de las
   * familias de CRV que ese cajón abarca. Un cajón NUNCA propone géneros de
   * más: solo evita contar como desacuerdo lo que ya está cubierto.
   */
  buckets: Record<string, string[]>;
  /**
   * Términos que ESTA fuente usa como etiqueta de catálogo y no como género:
   * «Latin» en Discogs marca cualquier disco cantado en español, no el género
   * `fusion-latina` de CRV. Traducirlos clasificaba bandas de rock de los 60
   * como fusión latina.
   *
   * Se ignoran solo aquí, en la lectura de la fuente: el alias sigue vivo en
   * la taxonomía para las fuentes propias del catálogo, que sí lo usan con su
   * sentido. Un término ignorado no propone ni abre caso: la decisión de no
   * traducirlo ya está tomada en la ficha.
   */
  ignore: string[];
}

export const DEFAULT_TAG_POLICY: TagPolicy = {
  acceptKinds: ["editorial_genre"],
  minTagCount: 2,
  maxValues: 3,
  buckets: {},
  ignore: [],
};

function parseBuckets(value: unknown): Record<string, string[]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const buckets: Record<string, string[]> = {};
  for (const [raw, families] of Object.entries(value as Record<string, unknown>)) {
    const key = normalizeGenreText(raw);
    if (!key || !Array.isArray(families)) continue;
    const slugs = families.filter((slug): slug is string => typeof slug === "string" && !!slug.trim())
      .map((slug) => slug.trim());
    if (slugs.length) buckets[key] = slugs;
  }
  return buckets;
}

export function parseTagPolicy(value: unknown): TagPolicy {
  const raw = (value ?? {}) as Partial<TagPolicy>;
  const kinds = Array.isArray(raw.acceptKinds)
    ? raw.acceptKinds.filter((kind): kind is ExternalTagKind =>
      kind === "editorial_genre" || kind === "community_tag" || kind === "technical")
    : DEFAULT_TAG_POLICY.acceptKinds;
  return {
    acceptKinds: kinds.length ? kinds : DEFAULT_TAG_POLICY.acceptKinds,
    minTagCount: typeof raw.minTagCount === "number" && raw.minTagCount >= 0 ? raw.minTagCount : DEFAULT_TAG_POLICY.minTagCount,
    maxValues: typeof raw.maxValues === "number" && raw.maxValues > 0 ? Math.min(10, raw.maxValues) : DEFAULT_TAG_POLICY.maxValues,
    buckets: parseBuckets(raw.buckets),
    ignore: Array.isArray(raw.ignore)
      ? raw.ignore.filter((value): value is string => typeof value === "string" && !!value.trim())
        .map((value) => normalizeGenreText(value)).filter((value) => !!value)
      : [],
  };
}

/**
 * Familias de CRV que abarca un término de la fuente, si está declarado como
 * cajón. Un slug que no existe o que no es familia se ignora: la ficha de la
 * fuente no puede inventar ramas de la taxonomía.
 */
export function bucketFamilyIds(taxonomy: Taxonomy, policy: TagPolicy, raw: string): Set<number> {
  const slugs = policy.buckets[normalizeGenreText(raw)];
  const ids = new Set<number>();
  if (!slugs) return ids;
  for (const slug of slugs) {
    const node = taxonomy.bySlug.get(slug);
    if (node?.level === "family" && node.active) ids.add(node.id);
  }
  return ids;
}

/** La familia a la que pertenece un género (o él mismo, si ya es familia). */
function familyIdOf(taxonomy: Taxonomy, genreId: number): number | null {
  return familyOf(taxonomy, genreId)?.id ?? null;
}

export type MappedStatus =
  | "proposed"        // resuelve a un género activo y CRV no lo tiene
  | "already_known"   // CRV ya lo tiene (confirmado, sugerido o propuesto antes)
  | "contradicts"     // CRV lo rechazó, o contradice el principal confirmado
  | "too_generic"     // solo dice la familia de algo que CRV ya precisó
  | "not_a_genre"     // formato, sello, lugar… (alias `not_a_genre`)
  | "unmapped"        // sin equivalencia en la taxonomía: a revisión
  | "ignored_kind"    // clase de etiqueta que esta fuente no tiene permitida
  | "ignored_value"   // término que esta fuente usa como cajón de catálogo, no como género
  | "below_min_count"; // etiqueta comunitaria sin votos suficientes

export interface MappedValue {
  raw: string;
  kind: ExternalTagKind;
  count: number | null;
  status: MappedStatus;
  genreId: number | null;
  genreSlug: string | null;
  reason: string;
}

/** Lo que CRV ya sabe de la ficha (solo lectura para el mapeo). */
export interface CrvGenreState {
  primaryGenreId: number | null;
  confirmedGenreIds: number[];
  suggestedGenreIds: number[];
  rejectedGenreIds: number[];
}

export type Agreement = "agree" | "family_agree" | "disagree" | "no_reference";

export interface MappingResult {
  values: MappedValue[];
  /** Géneros que se propondrán como sugerencia, en orden de la fuente. */
  proposals: Array<{ genreId: number; raw: string; kind: ExternalTagKind; count: number | null }>;
  /** Términos sin equivalencia: van a revisión, no crean género. */
  unmapped: string[];
  /**
   * Comparación con lo que CRV tiene confirmado: la base del informe de
   * precisión y de los avisos de desacuerdo.
   */
  agreement: Agreement;
  agreementDetail: string;
}

function related(taxonomy: Taxonomy, left: number, right: number): boolean {
  return left === right || isAncestorOf(taxonomy, left, right) || isAncestorOf(taxonomy, right, left);
}

/**
 * Mapea los valores de una ficha externa contra la taxonomía y el estado
 * actual de CRV. El orden de la fuente se conserva: es la única pista de
 * prioridad que da, y la persona decide qué es principal.
 */
export function mapExternalValues(
  taxonomy: Taxonomy, values: ExternalGenreValue[], state: CrvGenreState, policy: TagPolicy = DEFAULT_TAG_POLICY,
): MappingResult {
  const mapped: MappedValue[] = [];
  const proposals: MappingResult["proposals"] = [];
  const unmapped: string[] = [];
  const seenGenres = new Set<number>();
  const seenRaw = new Set<string>();
  const confirmed = new Set(state.confirmedGenreIds);
  const suggested = new Set(state.suggestedGenreIds);
  const rejected = new Set(state.rejectedGenreIds);

  for (const item of values) {
    const raw = item.value.trim();
    const key = normalizeGenreText(raw);
    if (!key || seenRaw.has(key)) continue;
    seenRaw.add(key);
    const count = item.count ?? null;
    const push = (status: MappedStatus, reason: string, genreId: number | null = null) => {
      mapped.push({
        raw, kind: item.kind, count, status, genreId,
        genreSlug: genreId === null ? null : taxonomy.genres.get(genreId)?.slug ?? null, reason,
      });
    };

    if (policy.ignore.includes(key)) {
      push("ignored_value", `la ficha de la fuente no traduce «${raw}»: es una etiqueta de catálogo, no un género`);
      continue;
    }
    if (!policy.acceptKinds.includes(item.kind)) {
      push("ignored_kind", `la ficha de la fuente no acepta etiquetas de clase ${item.kind}`);
      continue;
    }
    if (item.kind === "community_tag" && (count ?? 0) < policy.minTagCount) {
      push("below_min_count", `etiqueta comunitaria con ${count ?? 0} voto(s); el mínimo es ${policy.minTagCount}`);
      continue;
    }

    const resolution = resolveGenreValue(taxonomy, raw);
    const resolved = resolution.items.filter((entry) => entry.kind === "genre");
    if (!resolved.length) {
      if (resolution.notAGenre.length && !resolution.items.length) {
        push("not_a_genre", `«${resolution.notAGenre.join(", ")}» no es un género`);
      } else {
        push("unmapped", "sin equivalencia en la taxonomía aprobada");
        unmapped.push(raw);
      }
      continue;
    }

    for (const entry of resolved) {
      const genreId = entry.kind === "genre" ? entry.genreId : 0;
      if (seenGenres.has(genreId)) continue;
      seenGenres.add(genreId);
      const genre = taxonomy.genres.get(genreId);
      if (!genre?.active) {
        push("unmapped", "el género equivalente está inactivo", genreId);
        continue;
      }
      if (rejected.has(genreId)) {
        push("contradicts", "CRV rechazó este género para esta ficha", genreId);
        continue;
      }
      if (confirmed.has(genreId) || suggested.has(genreId)) {
        push("already_known", "CRV ya lo tiene en la ficha", genreId);
        continue;
      }
      // Solo la familia de algo que CRV ya precisó: no aporta, resta.
      const moreSpecific = [...confirmed].some((known) => isAncestorOf(taxonomy, genreId, known));
      if (moreSpecific) {
        push("too_generic", "CRV ya tiene un género hijo confirmado de esa familia", genreId);
        continue;
      }
      // Cajón de la fuente: abarca familias que en CRV son hermanas. Si CRV ya
      // confirmó algo dentro del cajón, el término no aporta nada nuevo.
      const covered = bucketFamilyIds(taxonomy, policy, raw);
      if (covered.size) {
        const inside = [...confirmed].find((known) =>
          covered.has(known) || (familyIdOf(taxonomy, known) !== null && covered.has(familyIdOf(taxonomy, known)!)));
        if (inside !== undefined) {
          const known = taxonomy.genres.get(inside)?.slug ?? inside;
          push("too_generic", `«${raw}» es un cajón de la fuente que ya cubre el género confirmado (${known})`, genreId);
          continue;
        }
      }
      push("proposed", "propuesta nueva para revisión", genreId);
      if (proposals.length < policy.maxValues) proposals.push({ genreId, raw, kind: item.kind, count });
    }
  }

  // Acuerdo con lo confirmado: la medida del informe de precisión.
  let agreement: Agreement = "no_reference";
  let agreementDetail = "CRV no tiene principal confirmado para comparar";
  if (state.primaryGenreId !== null) {
    const external = mapped.filter((value) => value.genreId !== null
      && (value.status === "proposed" || value.status === "already_known" || value.status === "too_generic"))
      .map((value) => value.genreId!);
    const primary = state.primaryGenreId;
    const primaryFamily = familyIdOf(taxonomy, primary);
    // Cajón comparable de la fuente que abarca la familia del principal.
    const bucketOverPrimary = primaryFamily === null ? null
      : mapped.find((value) => (value.status === "proposed" || value.status === "already_known" || value.status === "too_generic")
        && bucketFamilyIds(taxonomy, policy, value.raw).has(primaryFamily))?.raw ?? null;
    if (!external.length) {
      agreement = "no_reference";
      agreementDetail = "la fuente no aportó ningún género comparable";
    } else if (external.includes(primary)) {
      agreement = "agree";
      agreementDetail = `la fuente nombra el principal confirmado (${taxonomy.genres.get(primary)?.slug ?? primary})`;
    } else if (external.some((genreId) => related(taxonomy, genreId, primary))) {
      agreement = "family_agree";
      agreementDetail = "la fuente coincide en la familia del principal confirmado";
    } else if (bucketOverPrimary) {
      // El cajón de la fuente abarca la familia del principal: no es un
      // desacuerdo, es que la fuente agrupa más grueso que CRV.
      agreement = "family_agree";
      agreementDetail = `el cajón «${bucketOverPrimary}» de la fuente abarca la familia del principal`
        + ` (${taxonomy.genres.get(primary)?.slug ?? primary})`;
    } else {
      agreement = "disagree";
      agreementDetail = `la fuente propone ${external.map((id) => taxonomy.genres.get(id)?.slug ?? id).join(", ")}`
        + ` frente al principal ${taxonomy.genres.get(primary)?.slug ?? primary}`;
    }
  }

  return { values: mapped, proposals, unmapped, agreement, agreementDetail };
}

/** Familia de un género, para los informes por familia. */
export function familySlugOf(taxonomy: Taxonomy, genreId: number): string | null {
  return familyOf(taxonomy, genreId)?.slug ?? null;
}
