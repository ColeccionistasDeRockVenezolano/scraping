export interface ParsedTitle { artist: string | null; title: string; year: number | null; format: string | null; isFullAlbum: boolean; }
export interface DescriptionSection { kind: string; heading: string; content: string; position: number; }
export interface TimestampEntry { title: string; startSeconds: number; position: number; }
export interface CreditLine { verbs: string[]; preposition: "by" | "at"; value: string; sectionKind: string; }
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
// captura entero y se parte después.
const CREDIT_LINE = /^\s*((?:produced|recorded|mixed|mastered|written|composed|arranged|engineered|designed|photographed|illustrated)(?:\s*&\s*(?:produced|recorded|mixed|mastered|written|composed|arranged|engineered|mixed))*)\s+(by|at)\s*:?\s+(.+?)\s*$/i;

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
        credits.push({
          verbs: credit[1]!.split(/\s*&\s*/).map((verb) => verb.trim().toLowerCase()),
          preposition: credit[2]!.toLowerCase() as "by" | "at",
          value: credit[3]!.trim(),
          sectionKind: current.kind,
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
