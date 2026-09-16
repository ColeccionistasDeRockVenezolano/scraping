// Clasificador de nombres de persona (PHASES E11.7; plan P11).
//
// ~600 fichas del catálogo no son personas: estudios y sellos tipados como
// persona, duraciones sueltas («9'44»), fragmentos de texto («Tema
// interpretado por "Poster») y listas de varias personas metidas en una fila.
// Este módulo las CLASIFICA para que una persona decida (convertir en
// organización o artista, dividir, retirar): no borra ni transforma nada.
//
// Es puro y determinista: sin base de datos, con tests unitarios, y comparte
// con el detector de candidatos y la fusión el helper de organización
// (`looksLikeOrganization`, en person-names.ts) para no tener dos listas de
// palabras de estudio/sello que se separen con el tiempo.
export { looksLikeOrganization } from "./person-names.js";

import { looksLikeOrganization } from "./person-names.js";

export type PersonNameClass = "ok" | "organization_like" | "duration" | "fragment" | "multiple_people";

export interface PersonNameClassification {
  kind: PersonNameClass;
  /** Vacío cuando el nombre es un nombre. */
  reason: string;
}

/** Solo dígitos y marcas de tiempo («9'44», «4:39», «(66)»). */
const DURATION_ONLY = /^[\d\s:'"().,-]+$/u;
/** Prefijos de un fragmento de texto que nunca son un nombre. */
const FRAGMENT_PREFIX = /^(tema|part|track|cara|lado)\b/iu;
/** Listas explícitas: conjunción o separador con cuatro o más tokens. */
const LIST_SEPARATOR = /( y | & |, |\/)/u;
/**
 * Conectores de apellidos compuestos («de Las Casas», «van der Berg»). Solo
 * salvan del aviso de lista cuando están en los últimos tres tokens: al
 * principio del nombre son la prueba de que hay varios nombres propios
 * seguidos («Juan Manuel De Ferrari Alejandro Londoño» son dos personas).
 */
const NAME_CONNECTOR = /\b(de|del|la|las|los|van|von|der|da|dos|y|e|san|santa)\b/iu;
const LONG_NAME_TOKENS = 6;

/** Clasifica el nombre de una ficha «persona». Nunca lanza: un nombre raro es `ok`. */
export function classifyPersonName(name: string): PersonNameClassification {
  const trimmed = name.trim();
  if (DURATION_ONLY.test(trimmed)) return { kind: "duration", reason: "solo números o marcas de tiempo" };
  if (looksLikeOrganization(trimmed)) {
    return { kind: "organization_like", reason: "contiene una palabra de estudio, sello o productora" };
  }
  const quotes = (trimmed.match(/"/gu) ?? []).length;
  if (trimmed.length < 3 || quotes % 2 === 1 || FRAGMENT_PREFIX.test(trimmed)) {
    return { kind: "fragment", reason: "fragmento de texto, no un nombre" };
  }
  const tokens = trimmed.split(/\s+/u).filter(Boolean);
  if (LIST_SEPARATOR.test(trimmed) && tokens.length >= 4) {
    return { kind: "multiple_people", reason: "parece una lista de varias personas" };
  }
  // 6+ tokens sin apellido compuesto al final: «Carlos "Nene" Quintero Jesús
  // "Chuo" Quintero», «Ana Valencia Pimpi Santistevan Carlos Moreán Gonzalo
  // "Chile" Veloz», «Juan Manuel De Ferrari Alejandro Londoño».
  if (tokens.length >= LONG_NAME_TOKENS && !NAME_CONNECTOR.test(tokens.slice(-3).join(" "))) {
    return { kind: "multiple_people", reason: "demasiados tokens para un nombre" };
  }
  return { kind: "ok", reason: "" };
}
