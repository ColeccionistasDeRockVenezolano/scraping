// E10 · Comparaciones de texto del resolutor. Todas son deterministas y
// explicables: devuelven una relación con nombre, no un puntaje suelto.
import { jaroWinkler } from "../er/scoring.js";
import { normalizeEntityName } from "../normalization/entity-name.js";

/** Distancia de edición con transposición de vecinos (alineamiento óptimo). */
export function damerauLevenshtein(left: string, right: string): number {
  const rows = left.length + 1; const cols = right.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) value = Math.min(value, d[i - 2]![j - 2]! + 1);
      d[i]![j] = value;
    }
  }
  return d[left.length]![right.length]!;
}

/** Clave de palabras sin tildes, mayúsculas ni signos ("Andrés Mayo" → "andres mayo"). */
export function wordKey(value: string): string {
  return normalizeEntityName(value).secondaryKey;
}

const NUMBER_WORDS: Readonly<Record<string, string>> = {
  cero: "0", uno: "1", dos: "2", tres: "3", cuatro: "4", cinco: "5", seis: "6", siete: "7", ocho: "8", nueve: "9", diez: "10", once: "11", doce: "12",
};
const ROMAN: Readonly<Record<string, string>> = { ii: "2", iii: "3", iv: "4", vi: "6", vii: "7", viii: "8", ix: "9", xi: "11", xii: "12" };
const VOLUME = new Set(["vol", "vols", "volume", "volumen"]);
const ARTICLES = new Set(["el", "la", "los", "las", "the", "a", "an", "un", "una"]);
/** Palabras que por sí solas no identifican un disco ("Demo", "En Vivo", "Vol. 1"). */
const GENERIC_WORDS = new Set([
  "demo", "demos", "ep", "eps", "single", "sencillo", "maqueta", "maquetas", "bootleg", "promo", "sampler", "lp",
  "en", "vivo", "live", "directo", "casero", "volumen", "de", "el", "la", "los", "las",
]);

/** Tokens de un título con números y volúmenes normalizados ("Cinema Cero" = "Cinema 0", "Vol. II" = "Volumen 2"). */
export function titleTokens(value: string): string[] {
  const raw = wordKey(value).split(" ").filter(Boolean);
  return raw.map((token, index) => {
    if (VOLUME.has(token)) return "volumen";
    const number = NUMBER_WORDS[token] ?? ROMAN[token];
    if (number) return number;
    if (token === "i" && index > 0 && VOLUME.has(raw[index - 1]!)) return "1";
    return token;
  });
}

function withoutArticle(tokens: string[]): string[] {
  let rest = tokens;
  while (rest.length > 1 && ARTICLES.has(rest[0]!)) rest = rest.slice(1);
  return rest;
}

function titleVariants(title: string, artistName: string): string[][] {
  const tokens = titleTokens(title);
  const artist = titleTokens(artistName);
  const variants = [tokens, withoutArticle(tokens)];
  for (const prefix of [artist, withoutArticle(artist)]) {
    if (prefix.length && tokens.length > prefix.length && prefix.every((token, index) => tokens[index] === token)) variants.push(tokens.slice(prefix.length));
  }
  return variants.filter((variant) => variant.length > 0);
}

/** Título que no identifica el disco: solo palabras genéricas y números, o el nombre del artista. */
export function isGenericTitle(title: string, artistName: string): boolean {
  const tokens = titleTokens(title);
  if (!tokens.length) return true;
  if (tokens.every((token) => GENERIC_WORDS.has(token) || /^\d+$/u.test(token))) return true;
  const artist = titleTokens(artistName);
  return tokens.join(" ") === artist.join(" ") || withoutArticle(tokens).join(" ") === withoutArticle(artist).join(" ");
}

export type TitleRelation = "equal" | "contains" | "fuzzy" | "generic" | "unrelated";
const RELATION_RANK: Readonly<Record<TitleRelation, number>> = { equal: 4, contains: 3, fuzzy: 2, generic: 1, unrelated: 0 };

function compareTitleTokens(left: string[], right: string[]): TitleRelation {
  const leftKey = left.join(""); const rightKey = right.join("");
  if (leftKey === rightKey) return "equal";
  const [short, long] = leftKey.length <= rightKey.length ? [left, right] : [right, left];
  const shortKey = short.join(""); const longKey = long.join("");
  const informative = short.filter((token) => !GENERIC_WORDS.has(token) && !/^\d+$/u.test(token));
  if (informative.length && shortKey.length >= 4 && longKey.includes(shortKey)) return "contains";
  if (short.length >= 2 && informative.length && short.every((token) => long.includes(token))) return "contains";
  const shortest = Math.min(leftKey.length, rightKey.length);
  if (shortest >= 8 && (jaroWinkler(leftKey, rightKey) >= 0.9 || damerauLevenshtein(leftKey, rightKey) <= 2)) return "fuzzy";
  if (shortest >= 6 && damerauLevenshtein(leftKey, rightKey) <= 1) return "fuzzy";
  return "unrelated";
}

/**
 * Relación entre dos títulos de disco del mismo artista, la mejor entre sus
 * variantes (con y sin artículo, con y sin el nombre del artista delante).
 * `generic` cuando uno de los dos no identifica nada por sí mismo.
 */
export function titleRelation(left: string, right: string, artistName: string): TitleRelation {
  let best: TitleRelation = "unrelated";
  for (const a of titleVariants(left, artistName)) {
    for (const b of titleVariants(right, artistName)) {
      const relation = compareTitleTokens(a, b);
      if (RELATION_RANK[relation] > RELATION_RANK[best]) best = relation;
    }
  }
  if (best !== "equal" && (isGenericTitle(left, artistName) || isGenericTitle(right, artistName))) return "generic";
  return best;
}

// Un paréntesis que nombra otra grabación ("Remix", "En Vivo", "V2") hace
// distinta la pista; los demás ("Feat. X", "Radio Cut", "Cover AC/DC", una
// traducción) solo la describen.
const OTHER_RECORDING = /\b(remix|mix|live|en vivo|vivo|directo|acustic[oa]|acoustic|unplugged|instrumental|demo|maqueta|reprise|v\d+|version extendida|extended|remaster\w*)\b/u;
const BRACKETED = /[([{]([^)\]}]*)[)\]}]/gu;

function trackCore(title: string): { key: string; marker: string } {
  const markers: string[] = [];
  const stripped = title.replace(BRACKETED, (_, inner: string) => {
    const key = wordKey(inner);
    if (OTHER_RECORDING.test(key)) markers.push(key);
    return " ";
  });
  return { key: wordKey(stripped).replace(/\s+/gu, ""), marker: markers.sort().join("|") };
}

/**
 * Dos títulos de pista que nombran la misma grabación: iguales, con una errata
 * proporcional a su largo («Ceniza»/«Cenizas», «Bond, Jaime Bond»/«Bond, James
 * Bond») o uno truncado del otro («Mercy Mercy»/«Mercy, Mercy, Mercy»).
 */
export function trackTitlesEquivalent(left: string, right: string): boolean {
  const a = trackCore(left); const b = trackCore(right);
  if (!a.key || !b.key || a.marker !== b.marker) return false;
  if (a.key === b.key) return true;
  const length = Math.min(a.key.length, b.key.length);
  const distance = damerauLevenshtein(a.key, b.key);
  if (distance <= (length >= 10 ? 2 : length >= 5 ? 1 : 0)) return true;
  const [shortRaw, short, long] = a.key.length <= b.key.length ? [left, a.key, b.key] : [right, b.key, a.key];
  return long.startsWith(short) && (short.length >= 8 || /(?::|\.\.\.|…)\s*$/u.test(shortRaw.trim()));
}

// ─── Personas ────────────────────────────────────────────────────────────────

const QUOTED = /["“”«»]([^"“”«»]+)["“”«»]/gu;

export interface ParsedPerson {
  /** Nombre sin apodos ni paréntesis, en tokens sin tildes. */
  tokens: string[];
  nicknames: string[];
  /** El nombre parece contener a más de una persona o a un estudio. */
  compound: boolean;
}

export function parsePersonName(name: string): ParsedPerson {
  const nicknames = [...name.matchAll(QUOTED)].map((match) => wordKey(match[1]!)).filter(Boolean);
  const base = name.replace(QUOTED, " ").replace(/\([^)]*\)/gu, " ");
  const tokens = wordKey(base).split(" ").filter(Boolean);
  const compound = nicknames.length >= 2 || /\([^)]*["“”«»]/u.test(name) || /^(estudios?|studios?)\s/iu.test(name.trim());
  return { tokens, nicknames, compound };
}

export type NicknameCompatibility = "equal" | "one_missing" | "conflict";

export function nicknameCompatibility(left: ParsedPerson, right: ParsedPerson): NicknameCompatibility {
  if (!left.nicknames.length || !right.nicknames.length) return "one_missing";
  const close = (a: string, b: string): boolean => a === b || (Math.min(a.length, b.length) >= 6 && damerauLevenshtein(a, b) <= 1);
  return left.nicknames.some((a) => right.nicknames.some((b) => close(a, b))) ? "equal" : "conflict";
}

export type PersonRelation = "nickname_variant" | "extra_given_name" | "initials" | "surname_typo" | "given_typo" | "nickname_surname" | "fuzzy";

function initialsCompatible(left: string[], right: string[]): boolean {
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  let usedInitial = false;
  for (let index = 0; index < short.length; index += 1) {
    const a = short[index]!; const b = long[index]!;
    if (a === b) continue;
    if (a.length === 1 && b.startsWith(a)) { usedInitial = true; continue; }
    if (b.length === 1 && a.startsWith(b)) { usedInitial = true; continue; }
    return false;
  }
  // Una lista más corta solo vale si está hecha de iniciales («C.» / «Carlos Eduardo»).
  return usedInitial && (short.length === long.length || short.every((token) => token.length === 1));
}

/**
 * Relación nominal entre dos personas, o null si sus nombres no se parecen de
 * ninguna forma conocida. La relación es una señal: nunca basta sola.
 */
export function personRelation(left: ParsedPerson, right: ParsedPerson): PersonRelation | null {
  const a = left.tokens; const b = right.tokens;
  if (!a.length || !b.length) return null;
  if (a.join(" ") === b.join(" ")) return a.length >= 2 ? "nickname_variant" : null;
  if (a.length >= 2 && b.length >= 2) {
    const sameLast = a.at(-1) === b.at(-1);
    if (sameLast) {
      const givenA = a.slice(0, -1); const givenB = b.slice(0, -1);
      if (initialsCompatible(givenA, givenB)) return "initials";
      if (givenA[0] === givenB[0] && (givenA.every((token) => givenB.includes(token)) || givenB.every((token) => givenA.includes(token)))) return "extra_given_name";
      if (givenA.length === givenB.length && givenA.slice(1).join(" ") === givenB.slice(1).join(" ")
        && Math.min(givenA[0]!.length, givenB[0]!.length) >= 4 && damerauLevenshtein(givenA[0]!, givenB[0]!) <= 2) return "given_typo";
    }
    if (a.length === b.length && a[0] === b[0]) {
      const different = a.map((token, index) => [token, b[index]!] as const).filter(([x, y]) => x !== y);
      // La primera letra se conserva: «Hernández» / «Fernández» o «Zavarce» /
      // «Javarce» son apellidos distintos, no erratas.
      if (different.length === 1 && different[0]![0][0] === different[0]![1][0]) {
        const [x, y] = different[0]!;
        const length = Math.min(x.length, y.length); const distance = damerauLevenshtein(x, y);
        if ((length >= 5 && distance <= 1) || (length >= 7 && distance <= 2)) return "surname_typo";
      }
    }
    if (sameLast && left.nicknames.some((nickname) => right.nicknames.includes(nickname))) return "nickname_surname";
  }
  // Palabra por palabra: sobre el nombre entero, un nombre de pila largo y
  // compartido («Fernando Carías» / «Fernando Cárdenas») inflaría el parecido.
  if (a.length >= 2 && a.length === b.length && a.every((token, index) => Math.min(token.length, b[index]!.length) >= 3 && jaroWinkler(token, b[index]!) >= 0.9)) return "fuzzy";
  return null;
}

/** ` texto ` contiene ` nombre ` como secuencia de palabras completas. */
export function textMentions(textKey: string, nameKey: string): boolean {
  return nameKey.length > 0 && ` ${textKey} `.includes(` ${nameKey} `);
}
