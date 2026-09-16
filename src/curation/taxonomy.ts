// CRV · Taxonomía del detector de conflictos.
//
// Las categorías salen del estudio del catálogo (2026-09-16): 10.248 personas,
// 1.982 artistas, 687 organizaciones, 4.694 discos y 26.860 pistas. Cada
// detector declara su categoría; lo que ningún detector explica —y cualquier
// categoría o tipo de revisión que esta lista no conozca— cae en «otros», que
// siempre existe. Así un conflicto nuevo nunca se pierde por no tener casilla.
import type { CategoryDefinition } from "./types.js";

export const OTHER_CATEGORY = "otros";

export const CATEGORIES: readonly CategoryDefinition[] = [
  {
    key: "nombres_sucios",
    label: "Nombres sucios",
    description: "Texto con defectos de forma: caracteres invisibles, espacios de más, codificación rota, entidades HTML, signos colgantes o sin cerrar.",
  },
  {
    key: "mal_segmentados",
    label: "Mal segmentados",
    description: "Un solo campo mezcla varios datos: artista dentro del título, créditos o duración en el nombre, región o alias entre paréntesis, varias personas en una ficha.",
  },
  {
    key: "ficha_de_otro_tipo",
    label: "Ficha de otro tipo",
    description: "La ficha no es lo que dice ser: estudios y sellos cargados como persona, bandas como persona, duraciones o fragmentos de texto como nombre.",
  },
  {
    key: "fichas_repetidas",
    label: "Fichas repetidas",
    description: "Artistas, discos, pistas u organizaciones que parecen la misma ficha escrita de otra forma, y coincidencias pendientes de la ingesta.",
  },
  {
    key: "datos_incoherentes",
    label: "Datos incoherentes",
    description: "Datos que se contradicen entre sí: tipo de disco contra título, años imposibles, duraciones atípicas, pistas con huecos en la numeración.",
  },
  {
    key: "valores_en_disputa",
    label: "Valores en disputa",
    description: "Dos fuentes afirman valores distintos para el mismo campo y el core quedó intacto hasta que una persona elija.",
  },
  {
    key: "revision_de_ingesta",
    label: "Revisión de ingesta",
    description: "Casos que la ingesta no pudo decidir sola: baja confianza, URL faltante, coincidencias de YouTube, fuentes nuevas.",
  },
  {
    key: "fichas_sin_vinculos",
    label: "Fichas sin vínculos",
    description: "Fichas que nada del catálogo referencia: restos de fusiones, retiros o cargas incompletas.",
  },
  {
    key: OTHER_CATEGORY,
    label: "Otros",
    description: "Anomalías que ningún detector específico explica: el catálogo las marca como raras frente a su propio perfil. Aquí aparecen los tipos de conflicto nuevos.",
  },
];

const KNOWN = new Set(CATEGORIES.map((category) => category.key));

/** Categoría efectiva: una que la taxonomía no conoce va a «otros». */
export function effectiveCategory(key: string): string {
  return KNOWN.has(key) ? key : OTHER_CATEGORY;
}

/**
 * Tipos de la cola de revisión y la categoría donde se muestran. Un tipo que
 * se añada al enum `ingest.review_kind` y no esté aquí aparece en «otros».
 * `person_duplicate` no entra: tiene su propia pestaña (Posibles duplicados).
 */
export const REVIEW_KIND_CATEGORY: Readonly<Record<string, string>> = {
  field_conflict: "valores_en_disputa",
  possible_duplicate: "fichas_repetidas",
  ambiguous_alias: "fichas_repetidas",
  album_match: "fichas_repetidas",
  person_match: "fichas_repetidas",
  organization_match: "fichas_repetidas",
  youtube_match: "revision_de_ingesta",
  manual_review: "revision_de_ingesta",
  missing_url: "revision_de_ingesta",
  seed_incomplete: "revision_de_ingesta",
  media_type_no_album: "revision_de_ingesta",
  genre_unknown: "revision_de_ingesta",
  new_source: "revision_de_ingesta",
  low_confidence: "revision_de_ingesta",
  ai_biography: "revision_de_ingesta",
  ai_entity_resolution: "revision_de_ingesta",
};

/** Revisiones que viven en otra pestaña de Curaduría. */
export const REVIEW_KINDS_WITH_OWN_TAB = new Set(["person_duplicate"]);
