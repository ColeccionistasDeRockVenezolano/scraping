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
