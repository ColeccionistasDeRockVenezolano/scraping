// CRV · Curaduría: etiquetas y enlaces del detector de conflictos.
//
// Las categorías, detectores y subgrupos llegan con su etiqueta desde la API
// (src/curation/taxonomy.ts y cada detector); aquí solo vive lo que la web
// necesita para presentarlos: iconos, nombres de disparadores y enlaces.
import {
  Broom, Copy, IdentificationCard, LinkBreak, Question, Scales, Scissors, Shapes, Tray, Warning, type Icon,
} from "@phosphor-icons/react";
import { entityHref } from "./routes";
import type { CurationEntityRef, CurationFinding, CurationIgnoreReason, CurationResolution, CurationScan, CurationSeverity } from "./types";

export const CATEGORY_ICON: Readonly<Record<string, Icon>> = {
  nombres_sucios: Broom,
  mal_segmentados: Scissors,
  ficha_de_otro_tipo: IdentificationCard,
  fichas_repetidas: Copy,
  datos_incoherentes: Warning,
  valores_en_disputa: Scales,
  revision_de_ingesta: Tray,
  fichas_sin_vinculos: LinkBreak,
  otros: Question,
};

/** Una categoría nueva que la web aún no conoce recibe un icono neutro. */
export function categoryIcon(key: string): Icon {
  return CATEGORY_ICON[key] ?? Shapes;
}

export const SEVERITY_LABEL: Readonly<Record<CurationSeverity, string>> = { high: "Alta", medium: "Media", low: "Baja" };
export const SEVERITY_BADGE: Readonly<Record<CurationSeverity, string>> = { high: "badge--red", medium: "badge--amber", low: "badge--outline" };

const TRIGGER_LABEL: Readonly<Record<string, string>> = {
  manual: "Análisis manual",
  correccion: "Verificación tras una corrección",
  inicio: "Al arrancar la API",
  cambio_en_catalogo: "Cambio en el catálogo",
  cli: "Desde la terminal",
};

export function triggerLabel(trigger: string): string {
  return TRIGGER_LABEL[trigger] ?? trigger;
}

const RESOLUTION_LABEL: Readonly<Record<CurationResolution, string>> = {
  fixed_by_curation: "Corregido desde Curaduría",
  changed_elsewhere: "Cambió en otra parte",
  entity_removed: "La ficha se retiró",
  rules_changed: "Cambiaron las reglas del detector",
  declared_distinct: "Declaradas fichas distintas",
};

export const IGNORE_REASONS: ReadonlyArray<{ value: CurationIgnoreReason; label: string; hint: string }> = [
  { value: "falso_positivo", label: "Falso positivo", hint: "El detector se equivocó: aquí no hay ningún problema." },
  { value: "correcto_a_proposito", label: "Correcto a propósito", hint: "Parece un error, pero el dato es así (grafía del artista, título real)." },
  { value: "fuera_de_alcance", label: "Fuera de alcance", hint: "Puede ser un problema, pero no se va a corregir en el catálogo." },
];

export function ignoreReasonLabel(reason: CurationIgnoreReason | null): string | null {
  return IGNORE_REASONS.find((item) => item.value === reason)?.label ?? null;
}

const SEVERITY_WORD: Readonly<Record<string, string>> = { high: "alta", medium: "media", low: "baja" };

/** El último cambio de gravedad, título o subgrupo que registró un análisis (`evidence.history`); null si no hubo. */
export function lastChangeText(finding: CurationFinding): string | null {
  const history = finding.evidence["history"];
  const last = Array.isArray(history) ? history[0] as { at?: string; from?: Record<string, string>; to?: Record<string, string> } | undefined : undefined;
  if (!last?.from || !last.to) return null;
  const parts: string[] = [];
  if (last.from["severity"] !== last.to["severity"]) parts.push(`gravedad ${SEVERITY_WORD[last.from["severity"] ?? ""] ?? last.from["severity"]} → ${SEVERITY_WORD[last.to["severity"] ?? ""] ?? last.to["severity"]}`);
  if (last.from["signature"] !== last.to["signature"]) parts.push("subgrupo");
  if (last.from["title"] !== last.to["title"]) parts.push(`antes decía «${last.from["title"]}»`);
  return parts.length ? `Cambió en un análisis${last.at ? ` ${relativeTime(last.at)}` : ""}: ${parts.join(" · ")}` : null;
}

/** Par de fichas de un hallazgo de duplicados (`evidence.pair`); null si no es de par. */
export function findingPair(finding: CurationFinding): [number, number] | null {
  const pair = finding.evidence["pair"];
  return Array.isArray(pair) && pair.length === 2 && pair.every((id) => typeof id === "number") ? [pair[0] as number, pair[1] as number] : null;
}

/** «Corregido desde Curaduría por Ana (run #12)»; null si no se sabe por qué se resolvió. */
export function resolutionText(finding: CurationFinding): string | null {
  if (!finding.resolution) return null;
  const who = finding.resolvedBy ? ` por ${finding.resolvedBy}` : "";
  const run = finding.resolvedByRunId !== null ? ` (run #${finding.resolvedByRunId})` : "";
  return `${RESOLUTION_LABEL[finding.resolution]}${who}${run}`;
}

/** Detectores que fallaron en un análisis parcial (se guardan en `counters.failures`). */
export function failedDetectors(scan: CurationScan | null): string[] {
  const failures = scan?.counters["failures"];
  return Array.isArray(failures)
    ? failures.flatMap((item) => (item && typeof item === "object" && typeof (item as { detector?: unknown }).detector === "string" ? [(item as { detector: string }).detector] : []))
    : [];
}

export const ENTITY_KIND_LABEL: Readonly<Record<string, string>> = {
  artist: "Artista", person: "Persona", organization: "Organización", album: "Disco", track: "Pista",
  review: "Revisión", conflict: "Conflicto",
};

const FIELD_LABEL: Readonly<Record<string, string>> = {
  // Las acciones de texto devuelven su resultado bajo `value`: es el campo del
  // hallazgo, que ya se nombra aparte en la tarjeta.
  value: "Valor",
  name: "Nombre", title: "Título", album_type: "Tipo de disco", release_year: "Año", formed_year: "Año de formación",
  disbanded_year: "Año de separación", duration_ms: "Duración", duration_seconds: "Duración", tracks: "Pistas", origin_city: "Ciudad",
  // Etiquetas que usan tanto los hallazgos como el historial por ficha
  // (EntityHistory) para los campos de las cinco entidades y las relaciones.
  genre: "Género", label_id: "Sello", cover_url: "Portada", description: "Descripción", biography: "Biografía",
  nationality: "Nacionalidad", is_venezuelan: "Venezolano/a", birth_date: "Fecha de nacimiento", death_date: "Fecha de fallecimiento",
  picture_url: "Foto", origin_country: "País de origen", artist_type: "Tipo de artista", organization_type: "Tipo de organización",
  country: "País", website_url: "Sitio web", disc_number: "Disco N.º", track_number: "Pista N.º", youtube_start_seconds: "Inicio en YouTube",
  role: "Rol", credit_type: "Tipo de crédito", from_year: "Desde", to_year: "Hasta", is_current: "Vigente",
  format: "Formato", quality: "Calidad", archive_status: "Estado del archivo", file_path: "Ruta del archivo",
  person_id: "Persona acreditada", artist_id: "Artista acreditado", organization_id: "Organización acreditada", album_id: "Disco",
  youtube_url: "URL de YouTube", youtube_status: "Estado en YouTube", instagram_url: "URL de Instagram",
  instagram_status: "Estado en Instagram", wordpress_url: "URL de WordPress", wordpress_status: "Estado en WordPress",
};

export function fieldLabel(field: string): string {
  return FIELD_LABEL[field] ?? field.replace(/_/gu, " ");
}

/** Ruta de una ficha citada por un hallazgo; `null` si no tiene página. */
export function refHref(ref: CurationEntityRef, finding: CurationFinding): string | null {
  if (ref.id === null) return null;
  switch (ref.kind) {
    case "artist": case "person": case "organization": case "album":
      return entityHref(ref.kind, ref.id);
    case "track": {
      const album = finding.related.find((item) => item.kind === "album" && item.id !== null);
      return album?.id ? entityHref("track", ref.id, album.id) : null;
    }
    case "review":
      return `/curaduria/revision/${ref.id}`;
    default:
      return null;
  }
}

export function counter(scan: CurationScan | null, key: string): number {
  const value = scan?.counters[key];
  return typeof value === "number" ? value : 0;
}

const RELATIVE = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.round((new Date(iso).getTime() - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return "hace un momento";
  if (abs < 3600) return RELATIVE.format(Math.round(seconds / 60), "minute");
  if (abs < 86400) return RELATIVE.format(Math.round(seconds / 3600), "hour");
  return RELATIVE.format(Math.round(seconds / 86400), "day");
}

export function formatCount(value: number): string {
  return value.toLocaleString("es-VE");
}

/** «1 corrección» / «4 correcciones»: el plural fijo se nota y queda mal. */
export function plural(count: number, singular: string, many: string): string {
  return `${formatCount(count)} ${count === 1 ? singular : many}`;
}

// ---------------------------------------------------------------------------
// Acciones de corrección: nivel y consecuencia (PLAN_CURADURIA E8.1).
//
// El nivel no es un número decorativo: dice cuánto se puede confiar en la
// acción sin mirarla. La tarjeta lo escribe en una línea junto al botón
// principal, para que nadie tenga que abrir el diálogo para saber qué pasa si
// lo pulsa.
// ---------------------------------------------------------------------------

const ACTION_LEVEL: ReadonlyArray<{ label: string; consequence: string }> = [
  { label: "seguro", consequence: "cambio determinista y reversible" },
  { label: "sugerido", consequence: "se aplica con tu confirmación y se puede deshacer" },
  { label: "asistido", consequence: "hay más de una salida: revísalo ficha por ficha" },
  { label: "manual", consequence: "se decide a mano en la ficha" },
];

export function actionLevelLabel(level: number): string {
  return ACTION_LEVEL[level]?.label ?? `nivel ${level}`;
}

/** «Limpiar el texto · nivel 0 (seguro): cambio determinista y reversible.» */
export function actionConsequence(action: { label: string; level: number }): string {
  const level = ACTION_LEVEL[action.level];
  return level
    ? `${action.label} · nivel ${action.level} (${level.label}): ${level.consequence}.`
    : `${action.label} · nivel ${action.level}.`;
}

const FIX_MODE_LABEL: Readonly<Record<string, string>> = {
  individual: "Un hallazgo", selected: "Selección", group: "Grupo filtrado", auto: "Automático", undo: "Deshacer",
};

export function fixModeLabel(mode: string): string {
  return FIX_MODE_LABEL[mode] ?? mode;
}

const FIX_STATUS_LABEL: Readonly<Record<string, string>> = {
  previewed: "Solo vista previa", running: "A medias", done: "Aplicado", partial: "Aplicado en parte",
  failed: "Falló", undone: "Deshecho",
};

export function fixStatusLabel(status: string): string {
  return FIX_STATUS_LABEL[status] ?? status;
}

export const FIX_STATUS_BADGE: Readonly<Record<string, string>> = {
  previewed: "badge badge--outline", running: "badge badge--amber", done: "badge badge--teal",
  partial: "badge badge--amber", failed: "badge badge--red", undone: "badge",
};

// ---------------------------------------------------------------------------
// Evidencia legible (PLAN_CURADURIA E8.8, M10).
//
// La evidencia es el jsonb que dejó el detector. Mostrarla en crudo obliga a
// leer JSON para entender por qué el hallazgo existe; aquí cada clave conocida
// tiene su nombre en español y su valor se escribe como una frase. Una clave
// que ningún detector de hoy usa no rompe nada: se humaniza el camelCase y se
// muestra igual, porque un detector nuevo no debería requerir tocar la web.
// ---------------------------------------------------------------------------

const EVIDENCE_LABEL: Readonly<Record<string, string>> = {
  characters: "Caracteres invisibles", words: "Palabras pegadas", parts: "Partes", segments: "Segmentos",
  signs: "Signos poco comunes", sign: "Signo", mark: "Signo", repair: "Reparación propuesta",
  vocabularyMatches: "Palabras reconocidas tras reparar", domain: "Dominio", label: "Rótulo",
  learnedRole: "El rótulo es un rol aprendido", learnedMarkers: "Marcas aprendidas", learnedTokens: "Palabras aprendidas",
  lowercase: "Empieza en minúscula", personShaped: "Tiene forma de nombre de persona", knownPersons: "Personas ya conocidas",
  name: "Nombre", alias: "Alias", region: "Región", originCity: "Ciudad de origen",
  values: "Valores del grupo", groupSize: "Fichas del grupo", years: "Años", yearA: "Año A", yearB: "Año B",
  positions: "Posiciones", groupPositions: "Posiciones del grupo", index: "Posición", length: "Longitud",
  median: "Mediana del campo", letterRatio: "Proporción de letras", fieldMedian: "Mediana del campo",
  storedType: "Tipo guardado", declaredTypes: "Tipos que sugiere el título", wordSource: "Origen de la palabra",
  titleYear: "Año en el título", releaseYear: "Año de publicación", formedYear: "Año de formación",
  durationSeconds: "Duración (s)", robustZ: "Desvío respecto al disco", disc: "Disco", missing: "Pistas que faltan",
  present: "Pistas presentes", highest: "Número más alto", field: "Campo", year: "Año", value: "Valor",
  reviewId: "Revisión", kind: "Tipo", status: "Estado", priority: "Prioridad", createdAt: "Creada",
  payload: "Datos de la revisión", reason: "Motivo", conflictId: "Conflicto", entityKind: "Tipo de ficha",
  valueA: "Valor A", valueB: "Valor B", sourceA: "Fuente A", sourceB: "Fuente B",
  codePoint: "Punto de código", class: "Clase", left: "Izquierda", right: "Derecha", id: "Ficha",
  trustLevel: "Confianza", url: "URL", at: "Fecha", size: "Tamaño", letters: "Letras", item: "Elemento",
  first: "Primero", x: "Valor",
};

/** Nombre en español de una clave de evidencia; camelCase legible si es desconocida. */
export function evidenceLabel(key: string): string {
  return EVIDENCE_LABEL[key]
    ?? key.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/[_-]+/gu, " ").replace(/^./u, (char) => char.toUpperCase());
}

/** Valor de evidencia como frase: sin llaves ni comillas cuando se puede evitar. */
export function evidenceText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "boolean") return value ? "Sí" : "No";
  if (typeof value === "number") return formatCount(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.length ? value.map(evidenceText).join(" · ") : "—";
  return Object.entries(value as Record<string, unknown>)
    .map(([key, item]) => `${evidenceLabel(key)}: ${evidenceText(item)}`)
    .join(" · ");
}
