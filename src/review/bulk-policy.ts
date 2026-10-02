// CRV · Política de promoción masiva (puro, sin base de datos).
//
// Un millón de claims `low` no los resuelve una persona. Lo que esta política
// hace es sustituir la decisión que la persona tomaría ficha por ficha por una
// regla que se puede leer, probar y deshacer: cada identidad recibe UN veredicto
// con el nombre de la regla que lo produjo, y todo lo que la regla no puede
// afirmar sin inventar se queda ABIERTO (`hold`) en vez de adivinarse.
//
// Principios (reglas de Brian, ver memoria del proyecto):
//   * Un homónimo falso se paga en silencio (una biografía ajena en una ficha);
//     un duplicado se ve y se fusiona con evidencia. Entre dos errores, el
//     segundo: una persona sin coincidencia segura se CREA y se marca como
//     posible duplicado; no se fusiona por parecerse.
//   * Un artista u organización de nombre casi igual a otro del core no se crea
//     a ciegas (`artists.name` es UNIQUE y los discos cuelgan de él): se deja
//     abierto para una persona. Son decenas, no millones.
//   * Un disco o una pista solo se comparan contra los de SU padre: el mismo
//     título bajo otro artista o en otro disco es otra obra.
import { normalizeEntityName } from "../normalization/entity-name.js";
import { classifyPersonName } from "./person-junk.js";

export type BulkKind = "organization" | "artist" | "person" | "album" | "track";

export type ErAction = "AUTO_MATCH" | "POSSIBLE_MATCH" | "REVIEW" | "NO_MATCH";

export interface CandidateEvidence {
  id: number;
  name: string;
  score: number;
  nameBasis?: string;
  /** Artista del disco o disco de la pista candidata (solo álbum/pista). */
  parentId?: number;
}

export interface DecisionEvidence {
  action: ErAction;
  score: number;
  candidates: CandidateEvidence[];
}

export interface ExistingRef {
  id: number;
  name: string;
}

export interface PolicyInput {
  kind: BulkKind;
  /** Nombre del claim de identidad (último segmento de la identidad). */
  name: string;
  decision: DecisionEvidence | undefined;
  /**
   * Entidades del core con el MISMO nombre plegado (sin tildes ni mayúsculas)
   * ahora mismo; en discos y pistas, solo las del mismo padre.
   */
  sameName: ExistingRef[];
  /** Artista (disco) o disco (pista) ya resuelto; sin él no se decide. */
  parentId?: number;
  /**
   * Personas: la fuente solo la nombra como paréntesis final de títulos de
   * pista («Profundo (Capricornio)»), nunca en los créditos del disco ni en
   * otra línea de créditos.
   */
  onlyTitleParenthesis?: boolean;
}

export type Verdict =
  /** Pasa por el merge normal: hereda el destino ya resuelto de la identidad. */
  | { kind: "approve"; rule: string }
  | { kind: "same"; targetId: number; rule: string }
  | { kind: "different"; rule: string; flag?: DuplicateFlag }
  /** Basura evidente (una duración, un fragmento de texto): se rechaza sin tocar el core. */
  | { kind: "dismiss"; rule: string }
  /** No se toca: queda candidato y abierto en la cola. */
  | { kind: "hold"; rule: string; detail: string };

/** Entidad creada que se parece a una existente: insumo del detector de duplicados. */
export interface DuplicateFlag {
  reason: "homonimo-exacto" | "nombre-parecido";
  otherIds: number[];
  otherNames: string[];
}

/**
 * Agrupaciones, instituciones y lugares que Sincopa acredita como si fueran
 * personas («Ensamble Gurrufio», «Rios Reyna Concert Hall»). El clasificador de
 * personas solo conoce estudios y sellos; esto cubre el resto de lo que se vio.
 */
const GROUP_OR_PLACE_WORDS =
  /\b(orquesta|orchestra|ensamble|ensemble|coro|coral|choir|cuarteto|quinteto|sexteto|septeto|quartet|quintet|trio|trío|banda|band|conjunto|grupo|sociedad|fundaci[oó]n|foundation|universidad|university|conservatorio|conservatory|escuela|school|academia|iglesia|church|catedral|teatro|theat(?:er|re)|hall|auditorium|auditorio|sala|festival|radio|televisi[oó]n|producciones|productions?|sound|music|musica|m[uú]sica|recording|recordings|records?|archiv(?:e|o|ing)|labs?|creative|workshop|poliedro|folklore|shutterstock)\b/iu;

/**
 * Lo que Sincopa escribe en «Company:» cuando NO hay sello: es un marcador, no
 * una organización. La primera ola rechazó esos claims (1.776 de «Independent»)
 * y dejó el disco sin `label_id`; aquí se mantiene el criterio.
 */
const NO_LABEL_MARKER = /^(independent|independiente|self[- ]?released|autoeditad[oa]|sin sello|no label|n\/a|varios|various)$/iu;

const NAME_CONNECTORS = new Set(["de", "del", "la", "las", "los", "el", "y", "e", "da", "do", "dos", "di", "van", "von", "der", "den", "le", "san", "santa", "bin", "al", "ibn", "mc", "jr", "jr.", "sr."]);

/**
 * «The forbidden land», «The erotronic ritual dance» o «mar Oliveros»: lo que
 * la sección de créditos de Sincopa trae como texto libre y no como nombre.
 * Un nombre propio va en mayúsculas; con dos o más palabras sueltas en
 * minúscula (fuera de los conectores de apellido) es casi seguro un título.
 */
function looksLikeTitleOrFragment(name: string): boolean {
  const tokens = name.replace(/["“”«»()]/gu, " ").split(/\s+/u).filter(Boolean);
  if (tokens.length === 0) return false;
  const first = tokens[0]!;
  if (/^\p{Ll}/u.test(first) && !NAME_CONNECTORS.has(first.toLowerCase())) return true;
  const lower = tokens.slice(1).filter((token) => /^\p{Ll}/u.test(token) && !NAME_CONNECTORS.has(token.toLowerCase()));
  return tokens.length >= 3 && lower.length >= 2;
}

/**
 * Rótulos que Sincopa deja en el lugar del nombre: «Feat. Elisa Rego»,
 * «Arr: Miguel Astor», «Bonus Track», «tracks 1-4», «Radio Version», «3rd Mov»,
 * «Carlos Rodríguez (track…». Ninguno es, tal cual, el nombre de alguien.
 */
const CREDIT_LABEL = new RegExp([
  String.raw`^(?:feat\.?|ft\.?|featuring|arr\.?|arreglo|detail by|with|from)(?![\p{L}\d])`,
  String.raw`(?<![\p{L}\d])a\.?k\.?a\.?(?![\p{L}\d])`,
  String.raw`\(track`,
  String.raw`(?<![\p{L}\d])(?:live|bonus|tracks?|mix|remix|version|versión|mov|movement|movimiento|intro|outro|interlude|interludio|reprise|instrumental|unplugged|unpluged|en vivo)(?![\p{L}\d])`,
  String.raw`(?<![\p{L}\d])parte?\s+(?:[ivx]+|\d+)(?![\p{L}\d])`,
  // Rol pegado al nombre: «Comp: X», «Recop: X», «Rec. X», «Compilation: X».
  String.raw`^(?:comp|recop|recopilaci[oó]n|compilation|compilaci[oó]n|letra|lyrics|m[uú]sica|music|words|adaptaci[oó]n)\s*:`,
  String.raw`^(?:rec|recp|recop|comp|adapt|vers?)\.\s`,
  // Una palabra que describe la pista, no a su autor: «(Cuento)», «(Demo)».
  String.raw`^(?:cuento|poema|poes[ií]a|narraci[oó]n|recitad[oa]|declamaci[oó]n|demo|ac[uú]stic[oa]|acoustic|in[eé]dit[oa]|medley|popurr[ií]|potpourri|tributo|cover|hidden track|tema oculto|a cap+el+a|dub|edit|radio edit|extended)$`,
].join("|"), "iu");

/** Un año, un número o un rango («1928», «1248-1254»): no es un nombre. */
const ONLY_DIGITS = /^[\d\s.,/-]+$/u;

/** Palabras del nombre. */
function nameTokenCount(name: string): number {
  return name.split(/\s+/u).filter(Boolean).length;
}

const STOP = new Set(["de", "del", "la", "el", "los", "las", "y", "e", "the", "and", "&", "a", "of"]);

/** Nombre plegado: sin tildes, mayúsculas ni puntuación. */
export function foldName(name: string): string {
  return normalizeEntityName(name).secondaryKey;
}

function significantTokens(folded: string): string[] {
  return folded.split(" ").filter((token) => token.length > 0 && !STOP.has(token));
}

/** Distancia de edición acotada: corta en cuanto supera `limit`. */
export function editDistanceWithin(a: string, b: string, limit: number): number {
  if (Math.abs(a.length - b.length) > limit) return limit + 1;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[b.length]!;
}

export type Nearness = "exacto" | "reordenado" | "contenido" | "errata" | undefined;

/**
 * ¿Se parecen lo bastante como para que decidir sea cosa de una persona?
 * `minContainedTokens` es cuántas palabras debe tener el nombre contenido:
 * en personas una sola («Frank») no dice nada; en bandas sí («Impromptu»).
 */
export function nearness(a: string, b: string, minContainedTokens: number): Nearness {
  const fa = foldName(a);
  const fb = foldName(b);
  if (fa === fb) return "exacto";
  const ta = significantTokens(fa);
  const tb = significantTokens(fb);
  if (ta.length > 0 && ta.join(" ") === tb.join(" ")) return "exacto";
  if (ta.length > 1 && [...ta].sort().join(" ") === [...tb].sort().join(" ")) return "reordenado";
  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  if (shorter.length >= minContainedTokens && shorter.length < longer.length && shorter.every((token) => longer.includes(token))) {
    return "contenido";
  }
  const ca = ta.join("");
  const cb = tb.join("");
  const limit = Math.min(ca.length, cb.length) >= 12 ? 2 : Math.min(ca.length, cb.length) >= 6 ? 1 : 0;
  if (limit > 0 && editDistanceWithin(ca, cb, limit) <= limit) return "errata";
  return undefined;
}

function nearCandidates(input: PolicyInput, minContainedTokens: number, sameParentOnly: boolean): CandidateEvidence[] {
  const pool = input.decision?.candidates ?? [];
  return pool.filter((candidate) => {
    if (sameParentOnly && (input.parentId === undefined || candidate.parentId !== input.parentId)) return false;
    return nearness(input.name, candidate.name, minContainedTokens) !== undefined;
  });
}

const flagFrom = (reason: DuplicateFlag["reason"], refs: ReadonlyArray<{ id: number; name: string }>): DuplicateFlag => ({
  reason, otherIds: refs.map((ref) => ref.id), otherNames: refs.map((ref) => ref.name),
});

/**
 * El veredicto de UNA identidad. Función pura: mismo insumo, mismo veredicto.
 *
 * `same` solo sale cuando el ER dejó la identidad en REVIEW/POSSIBLE_MATCH y el
 * core ya tiene UNA entidad con el mismo nombre (y el mismo padre): el ER no
 * encontró contradicción, solo le faltaba contexto. Si dijo NO_MATCH con un
 * homónimo delante, es que hay una contradicción (otro año, otro país): no se
 * fusiona ni se crea, se deja abierto.
 */
export function decideVerdict(input: PolicyInput): Verdict {
  const { decision } = input;
  if (input.kind === "organization" && NO_LABEL_MARKER.test(foldName(input.name))) {
    return { kind: "dismiss", rule: "marcador-sin-sello" };
  }
  if (input.kind === "person") {
    if (CREDIT_LABEL.test(input.name) || ONLY_DIGITS.test(input.name)) {
      return { kind: "hold", rule: "no-es-una-persona:rotulo", detail: "rótulo o número en el lugar del nombre (Feat., Arr:, Bonus Track, tracks 1-4, un año)" };
    }
    // Sincopa escribe «Título (Compositor)», pero también «Título (traducción)»,
    // «(Capricornio)» o «(Goyescas)». En jazz, clásica y new age, lo que SOLO
    // llega por ese paréntesis resultó ser casi siempre un título. Se crea
    // únicamente si el ER ya lo enlazó con seguridad a una persona existente.
    const safeLink = decision?.action === "AUTO_MATCH" && nameTokenCount(input.name) >= 2;
    if (input.onlyTitleParenthesis === true && !safeLink) {
      return { kind: "hold", rule: "no-es-una-persona:parentesis-de-titulo", detail: "solo aparece como paréntesis final de títulos de pista; puede ser un subtítulo o una traducción" };
    }
  }
  if (decision === undefined) return { kind: "hold", rule: "sin-decision-er", detail: "la identidad no tiene decisión de ER registrada" };
  if (decision.action === "AUTO_MATCH") return { kind: "approve", rule: "auto-match" };
  const contradicted = decision.action === "NO_MATCH";

  if (input.kind === "album" || input.kind === "track") {
    if (input.parentId === undefined) {
      return { kind: "hold", rule: "padre-sin-resolver", detail: input.kind === "album" ? "el artista del disco aún no está en el core" : "el disco de la pista aún no está en el core" };
    }
    if (input.sameName.length > 1) {
      return { kind: "hold", rule: "varios-con-el-mismo-titulo", detail: `ya hay ${input.sameName.length} con ese título bajo el mismo padre: ${input.sameName.map((ref) => ref.id).join(", ")}` };
    }
    if (input.sameName.length === 1) {
      const other = input.sameName[0]!;
      if (contradicted) return { kind: "hold", rule: "titulo-igual-con-contradiccion", detail: `${other.id} «${other.name}»: el ER vio una contradicción (año, duración…)` };
      return { kind: "same", targetId: other.id, rule: input.kind === "album" ? "mismo-titulo-mismo-artista" : "mismo-titulo-mismo-disco" };
    }
    const near = nearCandidates(input, 1, true);
    if (near.length > 0) {
      return { kind: "hold", rule: "titulo-casi-igual-mismo-padre", detail: near.slice(0, 3).map((c) => `${c.id} «${c.name}»`).join("; ") };
    }
    return { kind: "different", rule: contradicted ? "sin-coincidencia" : "solo-coincide-bajo-otro-padre" };
  }

  if (input.kind === "person") {
    // Un «crédito» que no es una persona (lista, estudio, duración, fragmento)
    // no se convierte en ficha: su tratamiento propio va aparte.
    // Sincopa separa con «/» a los autores de una misma pista («Castillo/Della
    // Noche»): es una lista, no el nombre de nadie.
    if (input.name.includes("/")) return { kind: "hold", rule: "no-es-una-persona:multiple_people", detail: "crédito con varios nombres separados por «/»" };
    const classified = classifyPersonName(input.name);
    if (classified.kind === "duration" || classified.kind === "fragment") return { kind: "dismiss", rule: `basura:${classified.kind}` };
    if (classified.kind === "ok" && looksLikeTitleOrFragment(input.name)) {
      return { kind: "hold", rule: "no-es-una-persona:parece-un-titulo", detail: "empieza en minúscula o lleva varias palabras en minúscula: parece un título o un texto suelto" };
    }
    if (classified.kind === "ok" && GROUP_OR_PLACE_WORDS.test(input.name)) {
      return { kind: "hold", rule: "no-es-una-persona:agrupacion-o-lugar", detail: "el nombre es de una agrupación, institución o lugar" };
    }
    if (classified.kind !== "ok") return { kind: "hold", rule: `no-es-una-persona:${classified.kind}`, detail: classified.reason };
    if (input.sameName.length > 0) {
      return { kind: "different", rule: "homonimo-sin-proyecto-comun", flag: flagFrom("homonimo-exacto", input.sameName) };
    }
    const near = nearCandidates(input, 2, false);
    if (near.length > 0) return { kind: "different", rule: "nombre-parecido-sin-proyecto-comun", flag: flagFrom("nombre-parecido", near) };
    return { kind: "different", rule: contradicted ? "sin-coincidencia" : "solo-coincidencias-debiles" };
  }

  // Artistas y organizaciones: un nombre igual o casi igual no se crea a ciegas.
  if (input.sameName.length === 1 && !contradicted) {
    const other = input.sameName[0]!;
    return { kind: "same", targetId: other.id, rule: "mismo-nombre-sin-tildes" };
  }
  if (input.sameName.length > 0) {
    return { kind: "hold", rule: "mismo-nombre-en-el-core", detail: input.sameName.map((ref) => `${ref.id} «${ref.name}»`).join("; ") };
  }
  const near = nearCandidates(input, 1, false);
  if (near.length > 0) {
    return { kind: "hold", rule: "nombre-casi-igual", detail: near.slice(0, 3).map((c) => `${c.id} «${c.name}»`).join("; ") };
  }
  return { kind: "different", rule: contradicted ? "sin-coincidencia" : "solo-coincidencias-debiles" };
}
