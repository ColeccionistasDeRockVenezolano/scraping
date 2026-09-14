export interface ParsedTitle { artist: string | null; title: string; year: number | null; format: string | null; isFullAlbum: boolean; }
export interface DescriptionSection { kind: string; heading: string; content: string; position: number; }
export interface TimestampEntry { title: string; startSeconds: number; position: number; }
export interface CreditLine {
  verbs: string[]; preposition: "by" | "at"; value: string; sectionKind: string;
  /** La persona acreditada, ya separada del lugar. `null` si no es un nombre. */
  names: string[];
  /** El estudio o local: lo que sigue a " at ". */
  venue: string | null;
  /** El paréntesis final del lugar: "(Caracas, Venezuela)". */
  location: string | null;
}
export interface ParsedDescription { sections: DescriptionSection[]; tracklist: TimestampEntry[]; credits: CreditLine[]; }

const TITLE_SEPARATORS = /\s+(?:-|–|—)\s+/;
// Dos disposiciones reales conviven en las descripciones del canal: el
// timestamp puede abrir la línea ("00:00 - Título") o cerrarla tras un número
// de pista ("01 - Título 00:00"). Se prueban en ese orden.
const LEADING_TIMESTAMP = /^\s*(?:[-*•]\s*)?((?:\d{1,2}:)?\d{1,2}:\d{2})\s*(?:[-–—.)]\s*)?(.+?)\s*$/;
// El asterisco de nota al pie ("01 - Estado Alucinando 00:00 *") va después
// del reloj y no debe impedir que la línea se reconozca como pista.
const TRAILING_TIMESTAMP = /^\s*(?:[-*•]\s*)?(?:\d{1,2}\s*[-–—.)]\s*)?(.+?)\s+((?:\d{1,2}:)?\d{1,2}:\d{2})\s*[*†‡]*\s*$/;
// Medido sobre las 636 descripciones del canal (2026-09-08), no supuesto.
// El vocabulario real de encabezados es corto: Other Credits (634),
// Musicians (621), Tracklist (599), Guest Musicians (360), Bonus Track/s
// (94) y Timestamps (34, sinónimo de Tracklist). Los nombres de crédito
// —"Produced by", "Recorded by", "Mastered by"— NO son encabezados: viven
// como líneas sueltas dentro de Other Credits ("Produced by Los Mentas"),
// y por eso se reconocen aparte, en CREDIT_LINES, y no aquí.
//
// Ojo con lo que deliberadamente NO está: "Guitars", "Bass", "Backing
// Vocals" y demás aparecen a menudo al inicio de línea, pero son *roles*
// dentro de un bloque de músicos, no secciones. Ascenderlos partiría el
// bloque en pedazos y perdería a quién pertenece cada instrumento.
const SECTION_NAMES: Array<[RegExp, string]> = [
  // "Trackslist" (con ese de más) aparece en dos videos del canal; medido, no
  // supuesto. La `s?` intermedia lo cubre sin abrir la puerta a nada más.
  [/^tracks?\s*list$/i, "tracklist"], [/^time\s*stamps?$/i, "tracklist"], [/^tracks$/i, "tracklist"],
  [/^bonus\s*tracks?$/i, "bonus_tracks"],
  [/^guests?\s+musicians?$/i, "guest_musicians"], [/^musicians?$/i, "musicians"],
  [/^other credits?$/i, "other_credits"],
  [/^artwork$/i, "artwork"], [/^illustration$/i, "illustration"],
  [/^photography$/i, "photography"], [/^recorded at$/i, "recorded_at"],
];

/** Las secciones cuyas líneas con timestamp son pistas reales del video. */
const TRACK_SECTIONS = new Set(["tracklist", "bonus_tracks"]);

// Créditos en línea, la forma real en que aparecen. El verbo puede venir
// compuesto ("Recorded & Mixed by", "Produced & Written by"), así que se
// captura entero y se parte después. El arte y la foto se escriben con
// sustantivo, no con participio: "Artwork & Illustration by", "Photography by",
// "Photos by", "Graphic Design by" (medido en el canal, 2026-09-14).
const CREDIT_VERB = "produced|recorded|mixed|mastered|written|composed|arranged|engineered|designed|photographed|illustrated|artwork|illustrations?|photography|photos|graphic\\s+design";
const CREDIT_LINE = new RegExp(`^\\s*((?:${CREDIT_VERB})(?:\\s*&\\s*(?:${CREDIT_VERB}))*)\\s+(by|at)\\s*:?\\s+(.+?)\\s*$`, "i");

// El título del canal es un registro, no un rótulo: 616 de 646 llevan el año
// entre paréntesis, 631 el separador " - " y 77 una etiqueta de formato
// ([EP] ×44, [Single] ×32). El año que sale de aquí es una afirmación
// independiente del `Album Year` de la hoja, y cuando discrepan el conflicto
// se registra conservando ambas.
const TITLE_MARKER = /\|\|([^|]*)\|\|/g;
const TITLE_YEAR = /\((1[89]\d{2}|20\d{2})\)/g;
const TITLE_FORMAT = /\[([^\]]+)\]/;

export function parseYouTubeTitle(raw: string): ParsedTitle {
  const full = raw.trim();
  const isFullAlbum = /(?:^|\s|\|)(full\s+album|album\s+completo|álbum\s+completo|discography)(?:$|\s|\|)/i.test(full);
  // Se quitan en este orden: los marcadores `|| ... ||`, luego el año, luego
  // la etiqueta de formato. Lo que queda es el nombre del disco.
  let rest = full.replace(TITLE_MARKER, " ");
  const years = [...rest.matchAll(TITLE_YEAR)].map((match) => Number(match[1]));
  const year = years.length ? years[years.length - 1]! : null;
  rest = rest.replace(TITLE_YEAR, " ");
  const format = rest.match(TITLE_FORMAT)?.[1]?.trim() ?? null;
  if (format) rest = rest.replace(TITLE_FORMAT, " ");
  rest = rest.replace(/\s+/g, " ").trim();

  const parts = rest.split(TITLE_SEPARATORS);
  const artist = parts.length >= 2 ? parts.shift()!.trim() : null;
  const title = (parts.length ? parts.join(" - ") : rest).trim();
  return { artist: artist || null, title, year, format, isFullAlbum };
}

export function timestampToSeconds(value: string): number | null {
  const bits = value.trim().split(":");
  if (bits.length !== 2 && bits.length !== 3 || bits.some((bit) => !/^\d{1,2}$/.test(bit))) return null;
  const values = bits.map(Number);
  const [hours, minutes, seconds] = bits.length === 3 ? values : [0, values[0]!, values[1]!];
  if (minutes! > 59 || seconds! > 59) return null;
  return hours! * 3600 + minutes! * 60 + seconds!;
}

function sectionFor(heading: string): string | null {
  return SECTION_NAMES.find(([pattern]) => pattern.test(heading.trim()))?.[1] ?? null;
}

/**
 * Extrae encabezados explícitos, las líneas con timestamp de las secciones de
 * pistas (Tracklist y Bonus Tracks comparten numeración y reloj: son pistas
 * del mismo video) y los créditos en línea de las secciones que no son de
 * pistas. Los créditos se derivan pero todavía no se persisten: hoy el bloque
 * crudo vive en `media.youtube_description_sections.content`.
 */
export function parseYouTubeDescription(description: string | null | undefined): ParsedDescription {
  const lines = (description ?? "").replace(/\r\n?/g, "\n").split("\n");
  const sections: DescriptionSection[] = [];
  const tracklist: TimestampEntry[] = [];
  const credits: CreditLine[] = [];
  let current: { kind: string; heading: string; content: string[]; position: number } | null = null;
  const flush = () => {
    if (!current) return;
    const content = current.content.join("\n").trim();
    if (content) sections.push({ ...current, content });
    current = null;
  };

  for (const line of lines) {
    const match = line.match(/^\s*([^:]+?)(?:\s*:\s*(.*))?\s*$/);
    const kind = match ? sectionFor(match[1]!) : null;
    if (kind) {
      flush();
      current = { kind, heading: match![1]!.trim(), content: match![2] ? [match![2]!.trim()] : [], position: sections.length };
      continue;
    }
    if (current) {
      current.content.push(line.trim());
      // Un crédito se reconoce por su forma, no por la sección en que cae:
      // aparecen bajo Other Credits casi siempre, pero también sueltos tras
      // el tracklist. Lo único que lo descarta es que la línea ya sea pista.
      const isTrackLine = TRACK_SECTIONS.has(current.kind) && (LEADING_TIMESTAMP.test(line) || TRAILING_TIMESTAMP.test(line));
      const credit = isTrackLine ? null : line.match(CREDIT_LINE);
      if (credit) {
        const preposition = credit[2]!.toLowerCase() as "by" | "at";
        const value = credit[3]!.trim();
        // Con "at" el valor entero es el lugar; con "by", hay que separarlo.
        const parts = preposition === "at"
          ? { names: [], ...(() => { const t = trimCreditTail(value); const m = t.match(TRAILING_LOCATION);
              const bare = (m ? t.replace(TRAILING_LOCATION, "") : t).trim();
              return { venue: plausibleName(bare) ? bare : null, location: m ? m[1]!.trim() : null }; })() }
          : splitCreditValue(value);
        credits.push({
          verbs: credit[1]!.split(/\s*&\s*/).map((verb) => verb.trim().toLowerCase()),
          preposition, value, sectionKind: current.kind, ...parts,
        });
      }
      if (TRACK_SECTIONS.has(current.kind)) {
        const leading = line.match(LEADING_TIMESTAMP);
        const trailing = leading ? null : line.match(TRAILING_TIMESTAMP);
        const stamp = leading?.[1] ?? trailing?.[2];
        const title = (leading?.[2] ?? trailing?.[1])?.trim();
        const seconds = stamp ? timestampToSeconds(stamp) : null;
        if (seconds !== null && title) tracklist.push({ title, startSeconds: seconds, position: tracklist.length });
      }
    }
  }
  flush();
  return { sections, tracklist, credits };
}

// ---------------------------------------------------------------------------
// Créditos con persona y rol. Es lo que el canal aporta y ninguna otra fuente
// da con esta densidad: 622 descripciones traen bloque de músicos y 374
// además el de invitados, con la atribución por pista entre paréntesis.
//
// Dos disposiciones conviven, y las dos son reales:
//
//   Lead Vocals: Walter Gangi                 ← rol y nombre en la misma línea
//   Guitars:                                  ← rol suelto…
//   -Jefrey Sánchez (tracks 01,02,04)         ← …y nombres debajo
//
// Lo que NO se emite: cualquier valor con dígitos sueltos, punto y coma o
// "except". Son notas de matiz ("Produced by X, except; Track 12 by Y") y
// convertirlas en nombre de persona inventaría a alguien que no existe.

export interface PersonCredit { role: string; name: string; trackNumbers: number[]; sectionKind: string; }

// El valor puede venir vacío ("Guitars:" y debajo los nombres con viñeta),
// así que `(.*)` en vez de `(.+?)`: con `.+?` esa forma no casaba y el rol
// se perdía junto con todos sus nombres.
const ROLE_AND_NAMES = /^\s*-?\s*([^:]{2,60}?)\s*:\s*(.*)$/;
const BULLET_NAME = /^\s*[-–—•]\s*(.+?)\s*$/;
// El alcance puede venir prefijado por disco ("CD2 track 05") o sin número
// ("all tracks"). En los dos casos el paréntesis se retira del nombre; solo
// el segundo se queda sin pistas que acotar.
const TRACK_SCOPE = /\((?:\s*cd\s*\d+\s*[,:]?\s*)?\s*(?:all\s+)?(?:tracks?|pistas?)\s*([^)]*)\)/iu;
// Ciudad, marca de fallecido, banda de procedencia: nada de eso es el
// nombre. Se retira del nombre y el valor crudo lo conserva igual.
const ANY_PARENTHETICAL = /\s*\([^()]*\)\s*/gu;
// La banda de procedencia del invitado va entre corchetes —"[from Sentimiento
// Muerto]"— y a veces sin cerrar. Es un dato real, pero no es el nombre y hoy
// no tiene columna donde vivir; el valor crudo del claim lo conserva.
const TRAILING_BRACKET = /\s*\[[^\]]*\]?\s*$/u;
const CREDIT_SECTIONS = new Set(["musicians", "guest_musicians", "artwork", "illustration", "photography"]);

// La coma separa personas tanto como el "&": "Ana Valencia, María José
// Valencia" son dos. Lo que la coma NO separa es un sufijo de linaje, que
// pertenece al nombre anterior.
const NAME_SUFFIX = /^(?:jr|sr|ii|iii|iv|hijo|padre)\.?$/iu;

function splitNames(value: string): string[] {
  // "Lamarca+Batoni" son dos personas (decisión del propietario, 2026-09-14).
  return value.split(/\s*&\s*|\s*\+\s*|\s*,\s*|\s+y\s+/u)
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !NAME_SUFFIX.test(name));
}

/**
 * Un acreditado que es un sello o un estudio, aunque venga con "by". La
 * marca está al final del nombre —"Soul Jazz Records", "Silversound
 * Mastering Studios"—; exigirla al final evita confundir a una persona cuyo
 * rol mencione la palabra.
 */
export function looksLikeOrganization(name: string): boolean {
  const value = name.trim();
  // Estudios de diseño, foto y video acreditados en el arte: "NHF Design",
  // "Killdom Imaging", "Photochino's" o una web ("www.ozfilms.net").
  // Medidos en el canal y confirmados por el propietario (2026-09-14).
  return /\b(?:records?|studios?|mastering|productions?|estudios?|discos|design|imaging|films?)\s*$/iu.test(value)
    || /^photo\p{L}*(?:'s)?$/iu.test(value)
    || /^(?:https?:\/\/|www\.)|\.(?:com|net|org)(?:\.[a-z]{2})?$/iu.test(value);
}

// Un año o un mes dentro del valor no son parte del nombre: son la fecha de
// la sesión ("Boris Milan, August 1992"). Y una salvedad ("…, except;") abre
// una lista de excepciones que ya no habla del mismo acreditado.
const NAME_TAIL = /\s*[,;]\s*(?:except|salvo|excepto|but)\b[\s\S]*$|\s*;[\s\S]*$/iu;
const NAME_DATE_TAIL = /\s*,\s*(?:(?:january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre)\b[^,]*)?\s*(?:1[89]\d{2}|20\d{2})\s*$/iu;

/** Recorta lo que sigue al nombre: salvedades y fechas de sesión. */
function trimCreditTail(value: string): string {
  return value.replace(NAME_TAIL, "").replace(NAME_DATE_TAIL, "").trim().replace(/[,;.]+$/u, "").trim();
}

/**
 * Un nombre creíble. Los dígitos NO lo descalifican —"Zapato 3" y "Candy66"
 * son bandas reales del catálogo—; lo que descalifica es llevar un año, una
 * salvedad o un largo que ya no es de nombre sino de frase.
 */
function plausibleName(value: string): boolean {
  if (value.length < 2 || value.length > 80) return false;
  if (/\b(?:1[89]\d{2}|20\d{2})\b/u.test(value)) return false;
  if (/[;]|\bexcept\b|\bsalvo\b|\bexcepto\b/iu.test(value)) return false;
  return /\p{L}/u.test(value);
}

// "Recorded by Jesús Jiménez at Optilaser (Caracas, Venezuela)" son dos
// hechos en una línea: quién grabó y dónde. El " at " los separa.
const VENUE_SPLIT = /\s+\bat\b\s+/iu;
const TRAILING_LOCATION = /\s*\(([^()]{2,80})\)\s*$/u;

function splitCreditValue(value: string): { names: string[]; venue: string | null; location: string | null } {
  const [personPart, ...rest] = value.split(VENUE_SPLIT);
  const venueRaw = rest.length ? rest.join(" at ") : null;
  let venue: string | null = null; let location: string | null = null;
  if (venueRaw) {
    const trimmed = trimCreditTail(venueRaw);
    const match = trimmed.match(TRAILING_LOCATION);
    location = match ? match[1]!.trim() : null;
    const bare = (match ? trimmed.replace(TRAILING_LOCATION, "") : trimmed).trim();
    venue = plausibleName(bare) ? bare : null;
  }
  const scoped = scopeOf(trimCreditTail(personPart ?? ""));
  const names = splitNames(scoped.clean).filter(plausibleName);
  return { names, venue, location };
}

function scopeOf(value: string): { clean: string; trackNumbers: number[] } {
  const match = value.match(TRACK_SCOPE);
  const numbers = match
    ? [...new Set((match[1]!.match(/\d{1,3}/gu) ?? []).map(Number))].filter((n) => n > 0 && n < 1000).sort((a, b) => a - b)
    : [];
  // El alcance se extrae primero; después cae cualquier otro paréntesis.
  const clean = (match ? value.replace(TRACK_SCOPE, " ") : value)
    .replace(ANY_PARENTHETICAL, " ").replace(TRAILING_BRACKET, "").replace(/\s+/gu, " ").trim();
  return { clean, trackNumbers: numbers };
}

/** Extrae (rol, persona) de los bloques de músicos y de arte. */
export function parseCreditSections(sections: DescriptionSection[]): PersonCredit[] {
  const out: PersonCredit[] = [];
  for (const section of sections) {
    if (!CREDIT_SECTIONS.has(section.kind)) continue;
    // Un encabezado como "Artwork" ya nombra el rol de todo su bloque.
    let currentRole = section.kind === "musicians" || section.kind === "guest_musicians" ? null : section.heading.trim();
    for (const line of section.content.split("\n")) {
      if (!line.trim() || line.trim().startsWith("*")) continue;
      const paired = line.match(ROLE_AND_NAMES);
      if (paired) {
        const role = paired[1]!.trim();
        const value = paired[2]!.trim();
        if (!value) { currentRole = role; continue; }
        const { clean, trackNumbers } = scopeOf(value);
        for (const name of splitNames(clean)) {
          if (plausibleName(name)) out.push({ role, name, trackNumbers, sectionKind: section.kind });
        }
        continue;
      }
      const bullet = line.match(BULLET_NAME);
      if (bullet && currentRole) {
        const { clean, trackNumbers } = scopeOf(bullet[1]!);
        for (const name of splitNames(clean)) {
          if (plausibleName(name)) out.push({ role: currentRole, name, trackNumbers, sectionKind: section.kind });
        }
      }
    }
  }
  return out;
}
