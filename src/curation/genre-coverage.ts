// CRV · Etapa 1 de PLAN_GENEROS_CATALOGO_Y_RADIO_CRV.md — inventario de lo que
// las fuentes ya publican en género, por fuente y por nivel (artista/álbum).
//
// No interpreta compuestos ni decide taxonomía (eso es etapa 2): solo mide
// qué hay, de dónde viene y en qué forma (valor simple, lista con separador,
// compuesto con guion o no-género), para que la etapa 2 parta de datos reales
// y no de una lista a priori.
export type GenreValueShape = "simple" | "list_separator" | "hyphen_compound" | "not_a_genre";

// Reconocidos por descarte explícito, nunca por vocabulario musical: formato,
// contexto de publicación o adjetivo promocional, no un género (PLAN §Etapa 2
// punto 3). Aquí solo sirven para clasificar el inventario de la etapa 1, no
// para descartar nada todavía.
const NOT_A_GENRE = /^(?:independent|independiente|underground|autoeditad[oa]|ep|demo|single|sencillo|live|en vivo|recopilat(?:orio)?|compilat(?:orio)?|cl[aá]sico|legendario|various artists?|split)\.?$/iu;
const LIST_SEPARATOR = /\s*[/,;]\s*|\s+y\s+|\s+&\s+/iu;

export function classifyGenreValue(rawValue: string): GenreValueShape {
  const value = rawValue.trim();
  if (NOT_A_GENRE.test(value)) return "not_a_genre";
  if (LIST_SEPARATOR.test(value)) return "list_separator";
  if (value.includes("-")) return "hyphen_compound";
  return "simple";
}

export interface SourceLevelCoverageRow {
  sourceSlug: string;
  sourceName: string;
  level: "artist" | "album";
  totalEntities: number;
  entitiesWithGenre: number;
  genreClaims: number;
  distinctValues: number;
}

export interface GenreValueRow {
  level: "artist" | "album";
  value: string;
  claims: number;
  shape: GenreValueShape;
  sources: string[];
}

export interface AlbumGenreProjectionSummary {
  totalAlbums: number;
  albumsWithGenre: number;
  distinctGenreValues: number;
}

export interface MultiSourceEntity {
  level: "artist" | "album";
  entityId: number;
  sources: string[];
  values: string[];
}

export interface GenreSourceCoverageReport {
  generatedAt: string;
  bySourceAndLevel: SourceLevelCoverageRow[];
  valueInventory: GenreValueRow[];
  albumsGenreProjection: AlbumGenreProjectionSummary;
  multiSourceEntities: MultiSourceEntity[];
  sourcesWithoutGenreEvidence: Array<{ sourceSlug: string; sourceName: string; totalClaims: number; distinctFields: number }>;
}

function share(part: number, whole: number): string {
  return whole === 0 ? "—" : `${((part / whole) * 100).toFixed(1)} %`;
}

export function renderGenreSourceCoverageMarkdown(report: GenreSourceCoverageReport): string {
  const lines: string[] = [];
  lines.push("# Cobertura de géneros por fuente (Etapa 1)");
  lines.push("");
  lines.push(`Generado: ${report.generatedAt}`);
  lines.push("");
  lines.push("## Por fuente y nivel");
  lines.push("");
  lines.push("| Fuente | Nivel | Fichas | Con género | Cobertura | Claims | Valores distintos |");
  lines.push("|---|---|---:|---:|---:|---:|---:|");
  for (const row of report.bySourceAndLevel) {
    lines.push(`| ${row.sourceName} | ${row.level} | ${row.totalEntities} | ${row.entitiesWithGenre} | ${share(row.entitiesWithGenre, row.totalEntities)} | ${row.genreClaims} | ${row.distinctValues} |`);
  }
  lines.push("");
  lines.push("## Fuentes sin ninguna evidencia de género");
  lines.push("");
  if (report.sourcesWithoutGenreEvidence.length === 0) {
    lines.push("Ninguna: todas las fuentes con fichas de artista o álbum aportan al menos un claim de género.");
  } else {
    lines.push("| Fuente | Claims totales | Campos distintos |");
    lines.push("|---|---:|---:|");
    for (const row of report.sourcesWithoutGenreEvidence) {
      lines.push(`| ${row.sourceName} | ${row.totalClaims} | ${row.distinctFields} |`);
    }
  }
  lines.push("");
  lines.push("## Proyección `albums.genre`");
  lines.push("");
  lines.push(`Total álbumes: ${report.albumsGenreProjection.totalAlbums} · con \`genre\` no nulo: ${report.albumsGenreProjection.albumsWithGenre} (${share(report.albumsGenreProjection.albumsWithGenre, report.albumsGenreProjection.totalAlbums)}) · valores distintos: ${report.albumsGenreProjection.distinctGenreValues}`);
  lines.push("");
  lines.push("## Entidades con género de varias fuentes");
  lines.push("");
  lines.push(`${report.multiSourceEntities.length} entidades tienen claims de género de más de una fuente.`);
  lines.push("");
  lines.push("## Inventario de valores por forma");
  lines.push("");
  const byShape = new Map<GenreValueShape, number>();
  for (const row of report.valueInventory) byShape.set(row.shape, (byShape.get(row.shape) ?? 0) + 1);
  lines.push("| Forma | Valores distintos |");
  lines.push("|---|---:|");
  for (const shape of ["simple", "list_separator", "hyphen_compound", "not_a_genre"] as const) {
    lines.push(`| ${shape} | ${byShape.get(shape) ?? 0} |`);
  }
  lines.push("");
  lines.push("## Los 30 valores más frecuentes por nivel");
  lines.push("");
  for (const level of ["artist", "album"] as const) {
    lines.push(`### ${level}`);
    lines.push("");
    lines.push("| Valor | Claims | Forma | Fuentes |");
    lines.push("|---|---:|---|---|");
    const top = report.valueInventory.filter((row) => row.level === level).sort((a, b) => b.claims - a.claims).slice(0, 30);
    for (const row of top) lines.push(`| ${row.value} | ${row.claims} | ${row.shape} | ${row.sources.join(", ")} |`);
    lines.push("");
  }
  return lines.join("\n");
}
