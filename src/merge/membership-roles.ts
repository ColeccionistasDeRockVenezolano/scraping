// Roles de membresía: cuándo dos textos dicen lo mismo y cómo se unen.
//
// Cada fuente escribe el rol a su manera («Guitar», «Guitars», «guitarra»,
// «Lead Guitar», «Guitars (lead)»), y la clave de idempotencia por texto
// literal dejaba a la misma persona dos veces en la misma banda (caso Abaddon,
// 2026-10-04). Aquí el rol se parte en piezas y cada pieza se reduce a una
// clave de instrumento; dos textos son el mismo rol si cubren las mismas
// claves, y unirlos es tomar el más completo y añadirle lo que el otro aporta.
//
//  * NADA SE PIERDE: lo que no se reconoce queda como pieza propia (su clave es
//    el texto normalizado) y se añade al rol unido.
//  * LOS GENÉRICOS CEDEN: «Integrante», «Unknown» solo sobreviven si no hay nada
//    más concreto.

const GENERIC = new Set(["integrante", "miembro", "member", "unknown", "desconocido", "n/a", "?", "musico", "musician"]);

/** Palabra → término canónico. `""` la descarta (calificadores sin instrumento). */
const WORDS: Record<string, string> = {
  guitar: "guitar", guitars: "guitar", guitarra: "guitar", guitarras: "guitar", guitarrista: "guitar",
  bass: "bass", bajo: "bass", bajos: "bass", bajista: "bass",
  drum: "drums", drums: "drums", bateria: "drums", baterista: "drums",
  vocal: "vocals", vocals: "vocals", voz: "vocals", voces: "vocals", vocalista: "vocals", canto: "vocals",
  cantante: "vocals", singer: "vocals", coros: "vocals", coro: "vocals", choirs: "vocals", choir: "vocals",
  chorus: "vocals", backing: "", background: "", harsh: "",
  keyboard: "keyboards", keyboards: "keyboards", keys: "keyboards", teclado: "keyboards", teclados: "keyboards", tecladista: "keyboards",
  percussion: "percussion", percusion: "percussion", percusionista: "percussion",
  programming: "programming", programacion: "programming", programaciones: "programming",
  sequence: "sequences", sequences: "sequences", secuencia: "sequences", secuencias: "sequences",
  sample: "samples", samples: "samples", sampler: "samples", samplers: "samples",
  violin: "violin", violines: "violin", violinista: "violin",
  flute: "flute", flauta: "flute", flautas: "flute",
  trombone: "trombone", trombon: "trombone", trombones: "trombone",
  trumpet: "trumpet", trompeta: "trumpet", trompetas: "trumpet",
  sax: "saxophone", saxo: "saxophone", saxofon: "saxophone", saxophone: "saxophone",
  piano: "piano", pianista: "piano",
  timbal: "timbales", timbales: "timbales",
  bongo: "bongos", bongos: "bongos", bongoes: "bongos",
  conga: "congas", congas: "congas", tumbadora: "congas", tumbadoras: "congas",
  acoustic: "acoustic", acustica: "acoustic", acustico: "acoustic",
  electric: "electric", electrica: "electric", electrico: "electric",
  bagpipe: "bagpipes", bagpipes: "bagpipes", gaita: "bagpipes", gaitas: "bagpipes",
  ukelele: "ukulele", ukulele: "ukulele",
  accordion: "accordion", acordeon: "accordion",
  arranger: "arranger", arrangements: "arranger", arreglos: "arranger", arreglista: "arranger",
  producer: "producer", produccion: "producer", productor: "producer",
  latin: "latin", latina: "latin", latino: "latin", ethnic: "ethnic", etnica: "ethnic", etnico: "ethnic",
  maraca: "percussion", maracas: "percussion", flamenco: "",
  baritone: "baritone", baritono: "baritone", tenor: "tenor", contratenor: "countertenor", countertenor: "countertenor",
  // Calificadores: no cambian el instrumento.
  lead: "", rhythm: "", principal: "", lider: "", main: "", first: "", second: "", primer: "", primera: "",
  segundo: "", segunda: "", additional: "", de: "", del: "", la: "", el: "", y: "", and: "", the: "", of: "",
};
/** Una pieza que es solo un registro de voz («tenor», «barítono») es una voz. */
const VOICE_TYPES = new Set(["tenor", "baritone", "countertenor"]);

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Parte un rol en piezas por comas, «&», « y », « and », «/» y «;» fuera de paréntesis. */
export function rolePieces(role: string): string[] {
  const pieces: string[] = [];
  let depth = 0;
  let current = "";
  const push = () => { if (current.trim()) pieces.push(current.trim()); current = ""; };
  for (let index = 0; index < role.length; index += 1) {
    const char = role[index]!;
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(0, depth - 1);
    if (depth === 0) {
      if (char === "," || char === "&" || char === "/" || char === ";") { push(); continue; }
      const rest = role.slice(index);
      const word = /^ (y|and) /i.exec(rest);
      if (word) { push(); index += word[0].length - 1; continue; }
    }
    current += char;
  }
  push();
  return pieces;
}

/** Clave de una pieza: palabras canónicas ordenadas. `""` = genérica. */
export function pieceKey(piece: string): string {
  const folded = fold(piece)
    .replace(/\(([^)]*)\)/g, (_, inner: string) => (/\d/.test(inner) ? " " : ` ${inner} `))
    .replace(/[^a-z0-9/?\s-]/g, " ")
    .trim();
  if (!folded || GENERIC.has(folded.replace(/\s+/g, " "))) return "";
  const words = folded.split(/[\s-]+/).filter(Boolean).flatMap((word) => {
    if (word in WORDS) return WORDS[word] ? [WORDS[word]!] : [];
    if (/^\d+$/.test(word)) return [];
    // Plural inglés o castellano no catalogado: «Ukeleles» → «ukelele».
    return [word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word];
  });
  const set = new Set(words);
  if (set.size === 1 && VOICE_TYPES.has([...set][0]!)) set.add("vocals");
  return [...set].sort().join(" ");
}

/** Claves no genéricas de un rol completo. */
export function roleKeys(role: string): Set<string> {
  return new Set(rolePieces(role).map(pieceKey).filter(Boolean));
}

/**
 * Una clave queda cubierta por otra igual o más concreta: «guitar» por
 * «acoustic guitar», no al revés.
 */
function covers(keys: Iterable<string>, key: string): boolean {
  const words = key.split(" ");
  for (const candidate of keys) {
    const have = new Set(candidate.split(" "));
    if (words.every((word) => have.has(word))) return true;
  }
  return false;
}

/** Dos roles son el mismo si cada uno cubre las claves del otro (o ambos son genéricos). */
export function sameRole(left: string, right: string): boolean {
  const a = roleKeys(left);
  const b = roleKeys(right);
  return [...a].every((key) => covers(b, key)) && [...b].every((key) => covers(a, key));
}

const ROLE_MAX = 200;

/**
 * Une varios textos de rol en uno. La base es el más completo (más claves;
 * a igualdad, el que empieza en mayúscula —convención de las fuentes
 * estructuradas— y después el primero); se le añaden, en orden, las piezas de
 * los demás que no cubre. Si el resultado excede la columna, queda la base.
 */
export function combineRoles(roles: readonly string[]): string {
  const texts = roles.map((role) => role.trim()).filter(Boolean);
  if (texts.length === 0) return "";
  const ranked = texts.map((text, index) => ({ text, index, keys: roleKeys(text) }));
  const base = [...ranked].sort((left, right) =>
    right.keys.size - left.keys.size
    || Number(/^[A-ZÁÉÍÓÚÑ]/.test(right.text)) - Number(/^[A-ZÁÉÍÓÚÑ]/.test(left.text))
    || left.index - right.index)[0]!;
  const covered = new Set(base.keys);
  const extra: string[] = [];
  for (const item of ranked) {
    if (item === base) continue;
    for (const piece of rolePieces(item.text)) {
      const key = pieceKey(piece);
      if (!key || covers(covered, key)) continue;
      covered.add(key);
      extra.push(piece);
    }
  }
  const combined = [base.text, ...extra].join(", ");
  return combined.length <= ROLE_MAX ? combined : base.text;
}

/** Período de una membresía (años de entrada y salida, cualquiera puede faltar). */
export interface MembershipPeriod { from_year: number | null; to_year: number | null }

/**
 * Dos períodos son la misma etapa si no se contradicen: para cada año, alguno
 * falta o los dos coinciden (DATA_MODEL §6).
 */
export function compatiblePeriods(left: MembershipPeriod, right: MembershipPeriod): boolean {
  const compatible = (a: number | null, b: number | null): boolean => a === null || b === null || a === b;
  return compatible(left.from_year, right.from_year) && compatible(left.to_year, right.to_year);
}

/**
 * Dos etapas distintas: los dos períodos tienen algún año y no se tocan
 * (Darrell Laclé en Cultura Tres: 2008–2009 y 2017–2020). Un año que falta
 * cuenta como abierto hacia ese lado.
 */
export function disjointPeriods(left: MembershipPeriod, right: MembershipPeriod): boolean {
  const known = (period: MembershipPeriod) => period.from_year !== null || period.to_year !== null;
  if (!known(left) || !known(right)) return false;
  const low = (period: MembershipPeriod) => period.from_year ?? Number.NEGATIVE_INFINITY;
  const high = (period: MembershipPeriod) => period.to_year ?? Number.POSITIVE_INFINITY;
  return high(left) < low(right) || high(right) < low(left);
}
