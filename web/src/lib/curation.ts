// CRV · Curaduría: etiquetas y enlaces del detector de conflictos.
//
// Las categorías, detectores y subgrupos llegan con su etiqueta desde la API
// (src/curation/taxonomy.ts y cada detector); aquí solo vive lo que la web
// necesita para presentarlos: iconos, nombres de disparadores y enlaces.
import {
  Broom, Copy, IdentificationCard, LinkBreak, Question, Scales, Scissors, Shapes, Tray, Warning, type Icon,
} from "@phosphor-icons/react";
import { entityHref } from "./routes";
import type { CurationEntityRef, CurationFinding, CurationScan, CurationSeverity } from "./types";

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

export const ENTITY_KIND_LABEL: Readonly<Record<string, string>> = {
  artist: "Artista", person: "Persona", organization: "Organización", album: "Disco", track: "Pista",
  review: "Revisión", conflict: "Conflicto",
};

const FIELD_LABEL: Readonly<Record<string, string>> = {
  name: "Nombre", title: "Título", album_type: "Tipo de disco", release_year: "Año", formed_year: "Año de formación",
  disbanded_year: "Año de separación", duration_ms: "Duración", tracks: "Pistas", origin_city: "Ciudad",
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
