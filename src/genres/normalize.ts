// CRV · Normalización del texto de género (PLAN_GENEROS §4 «Trampas técnicas»).
//
// La base es SQL_ASCII: `translate()`/`unaccent` no quitan tildes allí. Toda
// comparación de alias se hace sobre la forma que calcula este módulo, y los
// alias se guardan ya normalizados.
//
// Solo se igualan diferencias que no cambian el significado: mayúsculas,
// tildes, guiones y apóstrofos, espacios y puntuación de los bordes. Un guion
// NO divide: «Pop-Rock» es un solo término («pop rock»), igual que
// «Death-Thrash» («death thrash»), que resolverá o irá a revisión entero.

/** Forma comparable de un texto de género. */
export function normalizeGenreText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // Apóstrofos y acentos sueltos: «Rock´n´Roll», «Rock 'n' Roll».
    .replace(/[´`'’‘]/gu, "")
    // Guiones y subrayados unen palabras de un mismo término.
    .replace(/[‐-―_-]/gu, " ")
    .replace(/^[\s.,;:!?"()[\]{}]+|[\s.,;:!?"()[\]{}]+$/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Separadores de lista. Fuertes: `/`, `,`, `;` y `|` (PLAN etapa 2 regla 6; el
 * `|` aparece en Descargas Metal Venezolano con el mismo papel). Débiles:
 * « y » y « & »; solo se prueban si el tramo entero no es un término conocido
 * («Rock & Roll» es un género, no una lista).
 */
const STRONG_SEPARATOR = /\s*[/,;|]\s*/u;
const WEAK_SEPARATOR = /\s+(?:y|&)\s+/iu;

export function splitStrong(value: string): string[] {
  return value.split(STRONG_SEPARATOR).map((part) => part.trim()).filter(Boolean);
}

export function splitWeak(value: string): string[] {
  return value.split(WEAK_SEPARATOR).map((part) => part.trim()).filter(Boolean);
}

export function hasListSeparator(value: string): boolean {
  return STRONG_SEPARATOR.test(value) || WEAK_SEPARATOR.test(value);
}

/**
 * Sustantivo núcleo que una lista comparte («Death/Thrash Metal» = Death metal
 * + Thrash metal). Regla `shared_suffix`, aprobada con la taxonomía: un tramo
 * que no resuelve solo toma el último núcleo del tramo final.
 */
export const SHARED_HEAD_WORDS = ["metal", "rock", "punk", "pop", "hardcore", "blues", "jazz", "grind", "core"] as const;

export function sharedHead(lastFragment: string): string | undefined {
  const words = normalizeGenreText(lastFragment).split(" ");
  for (let index = words.length - 1; index >= 0; index -= 1) {
    const word = words[index]!;
    if ((SHARED_HEAD_WORDS as readonly string[]).includes(word)) return word;
  }
  return undefined;
}

/** «Death metal melódico» → «death-metal-melodico». */
export function slugify(name: string): string {
  return normalizeGenreText(name).replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}
