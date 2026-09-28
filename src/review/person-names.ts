// Nombres de persona: apodos, apellido y palabras de organización.
//
// Regla 0.1.11 del plan: la base es SQL_ASCII y no pliega tildes ni
// mayúsculas —`lower('ÁNGEL')` sigue devolviendo `Ángel`—, así que toda
// comparación de nombres se hace aquí, en TypeScript, con `normalizeEntityName`.
//
// Vive aparte del detector de candidatos (E11.5) y del clasificador de basura
// (E11.7) porque lo comparten tres capas: el servicio de fusión de personas
// (apellido y aviso de organización), el detector (bloqueo y puntuación) y el
// clasificador.
import { normalizeEntityName } from "../normalization/entity-name.js";

/** Apodo entre comillas (rectas, curvas o angulares) o entre paréntesis. */
const NICKNAME = /["“”«»][^"“”«»]*["“”«»]|\([^)]*\)/gu;

/** Palabras que delatan un estudio, sello o productora dentro de un nombre. */
export const ORGANIZATION_LIKE_WORDS =
  /\b(estudios?|studios?|records|producciones|productora|discos|sello|label|mastering|films?)\b/iu;

/** Nombre sin apodos entre comillas ni paréntesis, sin tildes ni mayúsculas. */
export function nameWithoutNickname(name: string): string {
  return normalizeEntityName(name.replace(NICKNAME, " ")).secondaryKey;
}

/** Claves de bloqueo: solo se comparan pares que comparten alguna. */
export function personBlockingKeys(name: string): string[] {
  const base = nameWithoutNickname(name);
  const tokens = base.split(/\s+/u).filter((token) => token.length > 1);
  const keys = new Set<string>();
  if (base) keys.add(`full:${base}`);
  if (tokens.length >= 2) keys.add(`fl:${tokens[0]}|${tokens[tokens.length - 1]}`);
  return [...keys];
}

/**
 * Hipocorísticos frecuentes en los créditos (clave y valores sin tildes): el
 * mismo músico firma «Beto Montenegro» en un disco y «Alberto Montenegro» en
 * otro. Un hipocorístico admite varios nombres (Beto: Alberto, Roberto…), así
 * que por sí solo es una señal débil.
 */
export const HYPOCORISTICS: Readonly<Record<string, readonly string[]>> = {
  beto: ["alberto", "roberto", "humberto", "norberto", "heriberto", "gilberto"],
  pepe: ["jose"], cheo: ["jose"], joseito: ["jose"], chema: ["jose"], pepito: ["jose"],
  chucho: ["jesus"], chuy: ["jesus"], chui: ["jesus"], chuo: ["jesus"],
  kike: ["enrique"], quique: ["enrique"], kiko: ["enrique", "francisco"],
  paco: ["francisco"], pancho: ["francisco"], pacho: ["francisco"], frank: ["francisco", "franklin"],
  manolo: ["manuel"], manel: ["manuel"], lolo: ["manuel"],
  tono: ["antonio"], tony: ["antonio"], toni: ["antonio"],
  nacho: ["ignacio"], lalo: ["eduardo"], edu: ["eduardo"], memo: ["guillermo"],
  willy: ["william", "guillermo"], rafa: ["rafael"], santi: ["santiago"],
  alex: ["alejandro", "alexander", "alexis"], ale: ["alejandro"], alejo: ["alejandro"],
  richi: ["ricardo"], richie: ["ricardo"], ricky: ["ricardo", "enrique"],
  nando: ["fernando", "hernando"], fer: ["fernando"], gaby: ["gabriel"], gabo: ["gabriel"],
  lucho: ["luis"], licho: ["luis"], nico: ["nicolas"], juancho: ["juan"],
  charlie: ["carlos"], charly: ["carlos"], carlitos: ["carlos"], mike: ["miguel"], migue: ["miguel"],
  tavo: ["gustavo", "octavio"], gus: ["gustavo"], dani: ["daniel"], freddy: ["alfredo", "federico"],
  bobby: ["roberto"], johnny: ["juan", "jonathan"], jhonny: ["juan", "jonathan"], poncho: ["alfonso"],
  sebas: ["sebastian"], javi: ["javier"], goyo: ["gregorio"], moncho: ["ramon"], rulo: ["raul"],
};

/** Contenido de los apodos entre comillas o paréntesis, normalizado. */
export function nicknamesOf(name: string): string[] {
  return [...name.matchAll(NICKNAME)]
    .map((match) => normalizeEntityName(match[0].slice(1, -1)).secondaryKey)
    .filter(Boolean);
}

/** Una manera de firmar: nombre de pila (o apodo usado como tal) y apellido. */
export interface PersonNameForm {
  first: string;
  last: string;
  /** El nombre de pila salió de un apodo declarado («Alberto "Beto" Montenegro» → beto). */
  fromNickname: boolean;
}

/** Formas de firma de una persona a partir de su nombre y sus alias. */
export function personNameForms(name: string, aliases: readonly string[] = []): PersonNameForm[] {
  const forms = new Map<string, PersonNameForm>();
  for (const value of [name, ...aliases]) {
    const tokens = nameWithoutNickname(value).split(/\s+/u).filter((token) => token.length > 1);
    if (tokens.length < 2) continue;
    const last = tokens[tokens.length - 1]!;
    const add = (first: string, fromNickname: boolean) => {
      const key = `${first}|${last}|${fromNickname}`;
      if (!forms.has(key)) forms.set(key, { first, last, fromNickname });
    };
    add(tokens[0]!, false);
    for (const nickname of nicknamesOf(value)) {
      if (/^[a-z]{2,}$/u.test(nickname)) add(nickname, true);
    }
  }
  return [...forms.values()];
}

/** Nombres de pila que puede representar un token: él mismo y, si es hipocorístico, los formales. */
export function firstNameVariants(first: string): string[] {
  return [first, ...(HYPOCORISTICS[first] ?? [])];
}

/** Distancia de Damerau-Levenshtein (transposiciones adyacentes incluidas). */
function editDistance(left: string, right: string): number {
  const rows = Array.from({ length: left.length + 1 }, (_, i) => [i, ...Array<number>(right.length).fill(0)]);
  for (let j = 1; j <= right.length; j += 1) rows[0]![j] = j;
  for (let i = 1; i <= left.length; i += 1) {
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) value = Math.min(value, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = value;
    }
  }
  return rows[left.length]![right.length]!;
}

/**
 * Dos apellidos que difieren por una errata («Monetegro» / «Montenegro»): misma
 * inicial, cinco letras o más y a lo sumo 1 edición (2 si pasan de 7 letras).
 */
export function surnameTypo(left: string, right: string): boolean {
  if (left === right || left[0] !== right[0] || Math.min(left.length, right.length) < 5) return false;
  return editDistance(left, right) <= (Math.min(left.length, right.length) > 7 ? 2 : 1);
}

/**
 * Claves de bloqueo por variante de firma: nombre de pila (o su forma formal si
 * es un hipocorístico, o un apodo declarado) con el principio o el final del
 * apellido, para que una errata en medio del apellido no separe el par.
 */
export function personVariantBlockingKeys(name: string, aliases: readonly string[] = []): string[] {
  const keys = new Set<string>();
  for (const form of personNameForms(name, aliases)) {
    for (const first of firstNameVariants(form.first)) {
      keys.add(`nv:${first}|${form.last.slice(0, 3)}`);
      keys.add(`nv:${first}|…${form.last.slice(-3)}`);
    }
  }
  return [...keys];
}

/** Último token de la clave sin apodo: el apellido, para el aviso de la fusión. */
export function surnameToken(name: string): string {
  const tokens = nameWithoutNickname(name).split(/\s+/u).filter(Boolean);
  return tokens[tokens.length - 1] ?? "";
}

/** Aviso barato de «esto no parece una persona» (el clasificador completo es E11.7). */
export function looksLikeOrganization(name: string): boolean {
  return ORGANIZATION_LIKE_WORDS.test(name.trim());
}

/** El mismo patrón, para quitar esas palabras de una clave de comparación. */
const ORGANIZATION_LIKE_WORD = /\b(estudios?|studios?|records|producciones|productora|discos|sello|label|mastering|films?)\b/giu;

/**
 * Clave de una organización sin las palabras que casi nunca distinguen
 * («Estudio Uno» y «Uno» son la misma organización): la usa el detector de
 * candidatos para bloquear pares (E11.10).
 */
export function organizationKey(name: string): string {
  return normalizeEntityName(name.replace(ORGANIZATION_LIKE_WORD, " ")).secondaryKey;
}
