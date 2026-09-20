// CRV · Vocabulario en caché (PLAN_CURADURIA E9.3).
//
// Aprender cómo escribe el catálogo —lugares, roles, marcas de sello, nombres
// de pila, descriptores, piezas breves, perfiles por campo y la distribución de
// duraciones— cuesta cerca de la mitad de un análisis completo y solo cambia
// cuando cambia el catálogo. La caché guarda el último vocabulario aprendido
// con la huella del catálogo del que salió (`catalogSignature`).
//
// QUIÉN LA USA, Y QUIÉN NO:
//  * Un análisis DIRIGIDO —la verificación de cuatro fichas recién corregidas—
//    la usa siempre: por definición el catálogo acaba de cambiar (esa es la
//    escritura que se está verificando), y unas pocas filas no mueven una
//    estadística de 44.000 nombres. Cargar el catálogo entero solo para
//    aprenderlo costaría más que el análisis, y es justo lo que E9 vino a
//    quitar del camino. La huella no decide si se usa: decide cómo se llama lo
//    que se usó, «cache» si es la de ahora y «cache_anterior» si el catálogo
//    ya se movió. Queda escrito en los contadores del análisis.
//  * Un análisis COMPLETO nunca la reutiliza: aprende del catálogo que acaba de
//    cargar y deja la caché al día. Tentaba ahorrárselo cuando la huella no ha
//    cambiado, pero `catalogSignature` sale de `pg_stat_user_tables`, que el
//    recolector de estadísticas actualiza con retraso: «la huella no cambió»
//    puede significar «las estadísticas aún no se enteraron». El análisis que
//    manda no puede juzgar el catálogo de ahora con el vocabulario de antes
//    —así es como un hallazgo se abre y se cierra solo—, y lo que se ahorraría
//    es un segundo y medio en un caso que el vigilante ya evita: no lanza un
//    completo si la huella no se movió.
import type { Lexicon } from "./lexicon.js";

export type LexiconSource = "catalogo" | "cache" | "cache_anterior";

export interface LexiconUse {
  lexicon: Lexicon;
  source: LexiconSource;
  /** Antigüedad del vocabulario reutilizado, en milisegundos. */
  ageMs: number;
}

interface Entry {
  signature: string;
  lexicon: Lexicon;
  builtAt: number;
}

let entry: Entry | null = null;

/**
 * El último vocabulario aprendido, para el análisis dirigido. La huella no
 * decide si vale, sino cómo se llama: «cache» cuando es la del catálogo de
 * ahora, «cache_anterior» cuando el catálogo ya se movió.
 */
export function cachedLexicon(signature: string): LexiconUse | null {
  if (!entry) return null;
  return {
    lexicon: entry.lexicon,
    source: entry.signature === signature ? "cache" : "cache_anterior",
    ageMs: Date.now() - entry.builtAt,
  };
}

export function rememberLexicon(signature: string, lexicon: Lexicon): void {
  entry = { signature, lexicon, builtAt: Date.now() };
}

/** Pruebas y cierre ordenado: el proceso siguiente vuelve a aprender. */
export function resetLexiconCache(): void {
  entry = null;
}
