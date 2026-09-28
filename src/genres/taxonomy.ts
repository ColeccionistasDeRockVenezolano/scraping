// CRV · Taxonomía de géneros en memoria y resolución de un texto de fuente
// (PLAN_GENEROS etapa 2, reglas 4–6).
//
// Resolver es solo buscar: un texto entero, o cada tramo de una lista, se
// busca en los alias aprobados. Nada se adivina por parecido. Lo que no está
// en los alias queda `unresolved` y va a revisión; lo marcado `not_a_genre`
// (formato, sello, lugar…) no crea género ni pide revisión.
import {
  hasListSeparator, normalizeGenreText, sharedHead, splitStrong, splitWeak,
} from "./normalize.js";

export type GenreLevel = "family" | "genre";

export interface GenreNode {
  id: number;
  slug: string;
  name: string;
  level: GenreLevel;
  parentId: number | null;
  active: boolean;
  replacedById: number | null;
}

export type AliasTarget = { kind: "genre"; genreId: number } | { kind: "not_a_genre" };

export interface Taxonomy {
  genres: ReadonlyMap<number, GenreNode>;
  bySlug: ReadonlyMap<string, GenreNode>;
  aliases: ReadonlyMap<string, AliasTarget>;
}

export function buildTaxonomy(genres: GenreNode[], aliases: Array<[string, AliasTarget]>): Taxonomy {
  return {
    genres: new Map(genres.map((genre) => [genre.id, genre])),
    bySlug: new Map(genres.map((genre) => [genre.slug, genre])),
    aliases: new Map(aliases),
  };
}

/**
 * Género vigente: un género desactivado apunta a su reemplazo (PLAN §4
 * «Género desactivado»: las filas `rule` pasan al reemplazo con recálculo).
 */
export function effectiveGenreId(taxonomy: Taxonomy, genreId: number): number | undefined {
  let current = taxonomy.genres.get(genreId);
  for (let hops = 0; current && !current.active && hops < 16; hops += 1) {
    current = current.replacedById === null ? undefined : taxonomy.genres.get(current.replacedById);
  }
  return current?.active ? current.id : undefined;
}

/** `true` si `familyId` es la familia de `genreId`. */
export function isFamilyOf(taxonomy: Taxonomy, familyId: number, genreId: number): boolean {
  const family = taxonomy.genres.get(familyId);
  const genre = taxonomy.genres.get(genreId);
  return family?.level === "family" && genre?.parentId === familyId;
}

export function familyOf(taxonomy: Taxonomy, genreId: number): GenreNode | undefined {
  const genre = taxonomy.genres.get(genreId);
  if (!genre) return undefined;
  return genre.level === "family" ? genre : genre.parentId === null ? undefined : taxonomy.genres.get(genre.parentId);
}

export type ResolvedItem =
  | { kind: "genre"; genreId: number; fragment: string; via: "alias" | "shared_suffix" }
  | { kind: "unresolved"; fragment: string };

export interface ValueResolution {
  raw: string;
  normalized: string;
  /** En el orden de la fuente, sin repetidos y sin los no-géneros. */
  items: ResolvedItem[];
  /** Tramos reconocidos como no-género (formato, sello, lugar…). */
  notAGenre: string[];
  /** El valor se dividió como lista (separador fuerte o débil). */
  isList: boolean;
  /** Algún tramo sin resolver traía guion: posible término compuesto. */
  hyphenCompound: boolean;
}

function lookup(taxonomy: Taxonomy, key: string): { genreId: number } | "not_a_genre" | undefined {
  const target = taxonomy.aliases.get(key);
  if (!target) return undefined;
  if (target.kind === "not_a_genre") return "not_a_genre";
  const genreId = effectiveGenreId(taxonomy, target.genreId);
  return genreId === undefined ? undefined : { genreId };
}

interface Piece { fragment: string; result: { genreId: number; via: "alias" | "shared_suffix" } | "not_a_genre" | undefined }

/** Resuelve los tramos de una lista y aplica la regla `shared_suffix` desde el último. */
function resolvePieces(taxonomy: Taxonomy, fragments: string[]): Piece[] {
  const pieces: Piece[] = fragments.map((fragment) => {
    const found = lookup(taxonomy, normalizeGenreText(fragment));
    return { fragment, result: found === undefined || found === "not_a_genre" ? found : { genreId: found.genreId, via: "alias" } };
  });
  const head = fragments.length > 1 ? sharedHead(fragments[fragments.length - 1]!) : undefined;
  if (head) {
    for (const piece of pieces.slice(0, -1)) {
      if (piece.result !== undefined) continue;
      const key = normalizeGenreText(piece.fragment);
      if (key.split(" ").includes(head)) continue;
      const found = lookup(taxonomy, `${key} ${head}`);
      if (found && found !== "not_a_genre") piece.result = { genreId: found.genreId, via: "shared_suffix" };
    }
  }
  return pieces;
}

export function resolveGenreValue(taxonomy: Taxonomy, raw: string): ValueResolution {
  const normalized = normalizeGenreText(raw);
  const resolution: ValueResolution = { raw, normalized, items: [], notAGenre: [], isList: false, hyphenCompound: false };
  if (!normalized) return resolution;

  const whole = lookup(taxonomy, normalized);
  let pieces: Piece[];
  if (whole === "not_a_genre") {
    resolution.notAGenre.push(normalized);
    return resolution;
  } else if (whole) {
    pieces = [{ fragment: raw.trim(), result: { genreId: whole.genreId, via: "alias" } }];
  } else if (!hasListSeparator(raw)) {
    pieces = [{ fragment: raw.trim(), result: undefined }];
  } else {
    resolution.isList = true;
    pieces = [];
    for (const piece of resolvePieces(taxonomy, splitStrong(raw))) {
      // Un tramo fuerte que no resuelve se prueba con separadores débiles:
      // «Hard & Heavy» solo se parte si no es un término entero conocido.
      const weak = piece.result === undefined ? splitWeak(piece.fragment) : [];
      if (weak.length > 1) pieces.push(...resolvePieces(taxonomy, weak));
      else pieces.push(piece);
    }
  }

  const seen = new Set<number>();
  for (const piece of pieces) {
    if (piece.result === "not_a_genre") {
      resolution.notAGenre.push(normalizeGenreText(piece.fragment));
    } else if (piece.result === undefined) {
      if (/[-‐-―]/u.test(piece.fragment)) resolution.hyphenCompound = true;
      resolution.items.push({ kind: "unresolved", fragment: piece.fragment });
    } else if (!seen.has(piece.result.genreId)) {
      seen.add(piece.result.genreId);
      resolution.items.push({ kind: "genre", genreId: piece.result.genreId, fragment: piece.fragment, via: piece.result.via });
    }
  }
  return resolution;
}

/**
 * Claves de alias que la resolución de `raw` puede consultar. Sirve para saber
 * a qué entidades afecta crear, cambiar o quitar un alias sin recalcular todo.
 */
export function candidateAliasKeys(raw: string): Set<string> {
  const keys = new Set<string>();
  const add = (value: string) => { const key = normalizeGenreText(value); if (key) keys.add(key); };
  add(raw);
  const withSuffix = (fragments: string[]) => {
    for (const fragment of fragments) add(fragment);
    const head = fragments.length > 1 ? sharedHead(fragments[fragments.length - 1]!) : undefined;
    if (head) for (const fragment of fragments.slice(0, -1)) add(`${normalizeGenreText(fragment)} ${head}`);
  };
  const strong = splitStrong(raw);
  withSuffix(strong);
  for (const fragment of strong) {
    const weak = splitWeak(fragment);
    if (weak.length > 1) withSuffix(weak);
  }
  return keys;
}
