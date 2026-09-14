// CRV · Configuración de campos editables por entidad, en el mismo orden y
// alcance que ENTITY_FIELDS en src/api/routes/catalog-writes.ts.
import type { FieldConfig } from "../components/FormFields";
import { ALBUM_TYPES, ARTIST_TYPES, ORGANIZATION_TYPES, PUBLICATION_STATUSES, albumTypeLabel, artistTypeLabel, organizationTypeLabel, publicationStatusLabel } from "./labels";

const options = (values: readonly string[], toLabel: (v: string) => string) => values.map((value) => ({ value, label: toLabel(value) }));

export const ARTIST_FIELDS: readonly FieldConfig[] = [
  { key: "name", label: "Nombre", type: "text", required: true, span2: true },
  { key: "artistType", label: "Tipo", type: "select", required: true, options: options(ARTIST_TYPES, artistTypeLabel) },
  { key: "originCountry", label: "País de origen", type: "text", required: true },
  { key: "originCity", label: "Ciudad de origen", type: "text" },
  { key: "formedYear", label: "Año de formación", type: "number" },
  { key: "disbandedYear", label: "Año de disolución", type: "number" },
  { key: "pictureUrl", label: "Foto (URL)", type: "url", span2: true },
  { key: "biography", label: "Biografía", type: "textarea", span2: true },
  { key: "notes", label: "Notas internas", type: "textarea", span2: true },
];

export const PERSON_FIELDS: readonly FieldConfig[] = [
  { key: "name", label: "Nombre", type: "text", required: true, span2: true },
  { key: "nationality", label: "Nacionalidad", type: "text" },
  { key: "isVenezuelan", label: "Venezolano/a", type: "checkbox" },
  { key: "birthDate", label: "Fecha de nacimiento", type: "date" },
  { key: "deathDate", label: "Fecha de fallecimiento", type: "date" },
  { key: "pictureUrl", label: "Foto (URL)", type: "url", span2: true },
  { key: "biography", label: "Biografía", type: "textarea", span2: true },
  { key: "notes", label: "Notas internas", type: "textarea", span2: true },
];

export const ORGANIZATION_FIELDS: readonly FieldConfig[] = [
  { key: "name", label: "Nombre", type: "text", required: true, span2: true },
  { key: "organizationType", label: "Tipo", type: "select", required: true, options: options(ORGANIZATION_TYPES, organizationTypeLabel) },
  { key: "country", label: "País", type: "text" },
  { key: "websiteUrl", label: "Sitio web", type: "url" },
  { key: "pictureUrl", label: "Imagen (URL)", type: "url", span2: true },
  { key: "biography", label: "Descripción", type: "textarea", span2: true },
  { key: "notes", label: "Notas internas", type: "textarea", span2: true },
];

export const ALBUM_FIELDS: readonly FieldConfig[] = [
  { key: "title", label: "Título", type: "text", required: true, span2: true },
  { key: "albumType", label: "Tipo", type: "select", required: true, options: options(ALBUM_TYPES, albumTypeLabel) },
  { key: "releaseYear", label: "Año de publicación", type: "number" },
  { key: "genre", label: "Género", type: "text" },
  { key: "coverUrl", label: "Portada (URL)", type: "url", span2: true },
  { key: "youtubeUrl", label: "URL de YouTube", type: "url" },
  { key: "youtubeStatus", label: "Estado en YouTube", type: "select", options: options(PUBLICATION_STATUSES, publicationStatusLabel) },
  { key: "instagramUrl", label: "URL de Instagram", type: "url" },
  { key: "instagramStatus", label: "Estado en Instagram", type: "select", options: options(PUBLICATION_STATUSES, publicationStatusLabel) },
  { key: "wordpressUrl", label: "URL de WordPress", type: "url" },
  { key: "wordpressStatus", label: "Estado en WordPress", type: "select", options: options(PUBLICATION_STATUSES, publicationStatusLabel) },
  { key: "description", label: "Descripción", type: "textarea", span2: true },
  { key: "notes", label: "Notas internas", type: "textarea", span2: true },
];

export const TRACK_FIELDS: readonly FieldConfig[] = [
  { key: "title", label: "Título", type: "text", required: true, span2: true },
  { key: "discNumber", label: "Disco N.º", type: "number", required: true },
  { key: "trackNumber", label: "Pista N.º", type: "number", required: true },
  { key: "durationSeconds", label: "Duración (segundos)", type: "number" },
  { key: "youtubeStartSeconds", label: "Inicio en YouTube (segundos)", type: "number" },
  { key: "notes", label: "Notas internas", type: "textarea", span2: true },
];
