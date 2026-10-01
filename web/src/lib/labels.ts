// CRV · Etiquetas legibles para los enums del core y de ingest (crv_simple_v1.sql,
// migrations/*). Solo presentación: los valores que viajan a la API siguen
// siendo los snake_case originales.
import { TITULAR_ROLE } from "./types";

const DICTS: Record<string, Record<string, string>> = {
  artistType: {
    band: "Banda", solo_artist: "Solista", duo: "Dúo", project: "Proyecto", group: "Agrupación", other: "Otro",
  },
  albumType: {
    studio_album: "Álbum de estudio", live_album: "Álbum en vivo", ep: "EP", single: "Sencillo",
    compilation: "Recopilatorio", demo: "Demo", soundtrack: "Banda sonora",
    collaboration_album: "Colaboración", remix: "Remix", other: "Otro",
  },
  organizationType: {
    record_label: "Sello discográfico", production_company: "Productora", recording_studio: "Estudio de grabación",
    distributor: "Distribuidora", management: "Management", other: "Otro",
  },
  creditType: {
    musician: "Músico", guest: "Invitado", writer: "Autor", composer: "Compositor", producer: "Producción",
    recording: "Grabación", mixing: "Mezcla", mastering: "Masterización", photography: "Fotografía",
    artwork: "Arte", other: "Otro",
  },
  aliasType: {
    name_variant: "Variante de nombre", spelling_variant: "Variante ortográfica", former_name: "Nombre anterior",
    stage_name: "Nombre artístico", acronym: "Sigla", misspelling: "Errata", alternate_title: "Título alterno", other: "Otro",
  },
  publicationStatus: {
    published: "Publicado", unlisted: "No listado", unpublished: "Despublicado", copyright_blocked: "Bloqueado por copyright", unknown: "Desconocido",
  },
  reviewKind: {
    possible_duplicate: "Posible duplicado", field_conflict: "Conflicto de campo", ambiguous_alias: "Alias ambiguo",
    album_match: "Coincidencia de álbum", person_match: "Coincidencia de persona", organization_match: "Coincidencia de organización",
    youtube_match: "Coincidencia de YouTube", manual_review: "Revisión manual", missing_url: "URL faltante",
    seed_incomplete: "Fila de semilla incompleta", media_type_no_album: "Contenido audiovisual sin álbum",
    genre_unknown: "Género desconocido", new_source: "Fuente nueva", low_confidence: "Confianza baja",
    ai_biography: "Biografía generada por IA", ai_entity_resolution: "Identidad propuesta por IA",
    person_duplicate: "Posible persona duplicada",
  },
  reviewStatus: {
    open: "Abierta", in_progress: "En curso", accepted: "Aceptada", rejected: "Rechazada", resolved: "Resuelta",
  },
  confidence: { high: "Alta", medium: "Media", low: "Baja" },
  trustLevel: { high: "Alta", medium: "Media", low: "Baja", api: "API oficial" },
  searchType: {
    artist: "Artista", person: "Persona", album: "Disco", track: "Pista", organization: "Organización",
  },
  entityKind: {
    artist: "Artista", person: "Persona", organization: "Organización", album: "Disco", track: "Pista",
  },
  // Clasificación de nombres de persona (E11.7).
  personNameClass: {
    ok: "Nombre", organization_like: "Parece organización", duration: "Duración o número",
    fragment: "Fragmento de texto", multiple_people: "Varias personas",
  },
};

function label(dict: keyof typeof DICTS, value: string | null | undefined): string {
  if (!value) return "—";
  return DICTS[dict]?.[value] ?? value;
}

export const artistTypeLabel = (value: string) => label("artistType", value);
export const albumTypeLabel = (value: string) => label("albumType", value);
export const organizationTypeLabel = (value: string) => label("organizationType", value);
export const creditTypeLabel = (value: string) => label("creditType", value);
export const aliasTypeLabel = (value: string) => label("aliasType", value);
export const publicationStatusLabel = (value: string) => label("publicationStatus", value);
export const reviewKindLabel = (value: string) => label("reviewKind", value);
export const reviewStatusLabel = (value: string) => label("reviewStatus", value);
export const confidenceLabel = (value: string) => label("confidence", value);
export const trustLevelLabel = (value: string) => label("trustLevel", value);
export const searchTypeLabel = (value: string) => label("searchType", value);
export const entityKindLabel = (value: string) => label("entityKind", value);
export const nameClassLabel = (value: string) => label("personNameClass", value);

export const ARTIST_TYPES = Object.keys(DICTS["artistType"]!);
export const ALBUM_TYPES = Object.keys(DICTS["albumType"]!);
export const ORGANIZATION_TYPES = Object.keys(DICTS["organizationType"]!);
export const CREDIT_TYPES = Object.keys(DICTS["creditType"]!);
export const ALIAS_TYPES = Object.keys(DICTS["aliasType"]!);
export const PUBLICATION_STATUSES = Object.keys(DICTS["publicationStatus"]!);

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/**
 * Un solista no está «en una banda»: está al frente de su proyecto (Brian,
 * 2026-10-01). Un vínculo es de proyecto si el artista lo es —solista o
 * proyecto— o si la persona figura como su titular, que es lo que une a la
 * persona con el artista cuando los dos son la misma identidad.
 */
const PROJECT_ARTIST_TYPES = new Set(["solo_artist", "project"]);

export function isProjectMembership(band: { role: string; artistType?: string }): boolean {
  return band.role === TITULAR_ROLE || PROJECT_ARTIST_TYPES.has(band.artistType ?? "");
}

/** Cómo llamar a lo que vincula a una persona con sus artistas, según cuáles sean. */
export function membershipNoun(bands: ReadonlyArray<{ role: string; artistType?: string }>): { singular: string; plural: string } {
  const projects = bands.filter(isProjectMembership).length;
  if (bands.length > 0 && projects === bands.length) return { singular: "Proyecto", plural: "Proyectos" };
  if (projects === 0) return { singular: "Banda", plural: "Bandas" };
  return { singular: "Banda o proyecto", plural: "Bandas y proyectos" };
}
