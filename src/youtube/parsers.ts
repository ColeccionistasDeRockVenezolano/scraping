export interface ParsedTitle { artist: string | null; title: string; isFullAlbum: boolean; }
export interface DescriptionSection { kind: string; heading: string; content: string; position: number; }
export interface TimestampEntry { title: string; startSeconds: number; position: number; }
export interface ParsedDescription { sections: DescriptionSection[]; tracklist: TimestampEntry[]; }

const TITLE_SEPARATORS = /\s+(?:-|–|—)\s+/;
// Dos disposiciones reales conviven en las descripciones del canal: el
// timestamp puede abrir la línea ("00:00 - Título") o cerrarla tras un número
// de pista ("01 - Título 00:00"). Se prueban en ese orden.
const LEADING_TIMESTAMP = /^\s*(?:[-*•]\s*)?((?:\d{1,2}:)?\d{1,2}:\d{2})\s*(?:[-–—.)]\s*)?(.+?)\s*$/;
const TRAILING_TIMESTAMP = /^\s*(?:[-*•]\s*)?(?:\d{1,2}\s*[-–—.)]\s*)?(.+?)\s+((?:\d{1,2}:)?\d{1,2}:\d{2})\s*$/;
const SECTION_NAMES: Array<[RegExp, string]> = [
  [/^track\s*list$/i, "tracklist"], [/^musicians?$/i, "musicians"], [/^other credits?$/i, "other_credits"],
  [/^produced by$/i, "produced_by"], [/^recorded by$/i, "recorded_by"], [/^mixed by$/i, "mixed_by"],
  [/^mastered by$/i, "mastered_by"], [/^artwork$/i, "artwork"], [/^illustration$/i, "illustration"],
  [/^photography$/i, "photography"], [/^written by$/i, "written_by"], [/^composed by$/i, "composed_by"],
  [/^recorded at$/i, "recorded_at"],
];

export function parseYouTubeTitle(raw: string): ParsedTitle {
  const title = raw.trim();
  const parts = title.split(TITLE_SEPARATORS);
  const artist = parts.length >= 2 ? parts.shift()!.trim() : null;
  const remainder = (parts.length ? parts.join(" - ") : title).trim();
  return { artist: artist || null, title: remainder, isFullAlbum: /(?:^|\s)(full\s+album|album\s+completo|álbum\s+completo|discography)(?:$|\s)/i.test(title) };
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

/** Extracts only explicit heading sections and timestamp lines under Tracklist. */
export function parseYouTubeDescription(description: string | null | undefined): ParsedDescription {
  const lines = (description ?? "").replace(/\r\n?/g, "\n").split("\n");
  const sections: DescriptionSection[] = [];
  const tracklist: TimestampEntry[] = [];
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
      if (current.kind === "tracklist") {
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
  return { sections, tracklist };
}
