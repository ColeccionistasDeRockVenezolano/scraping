// CRV · Lote de investigación 2026-10-02 como fuente (etapa 1 del plan
// ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md).
//
// Dos JSON hechos con IA sobre la web abierta (lote 1: 118 artistas; lote 2:
// 70 de música tradicional, coral, cristiana e infantil). Cada artista trae
// sus URLs citadas. Este módulo es puro: convierte una ficha del lote en
// hechos normalizados (campo, valor, evidencia) y decide qué campos pueden
// rellenar un hueco del core. La escritura vive en
// scripts/lote-investigacion-2026-10-02.ts, en un run reversible.
//
// Política de Brian (2026-10-02): el lote solo rellena campos vacíos, nunca
// pisa el canal, la hoja ni otras fuentes; los choques van a un informe.
import { z } from "zod";

export const LOTE_SOURCE_SLUG = "lote-investigacion-2026-10-02";
export const LOTE_EXTRACTOR = "lote-investigacion";
export const LOTE_EXTRACTOR_VERSION = "1";

const placeSchema = z.object({ date: z.string().nullable().optional(), place: z.string().nullable().optional() }).nullable();

const trackSchema = z.object({
  position: z.union([z.number(), z.string()]).nullable().optional(),
  title: z.string(),
  duration: z.string().nullable().optional(),
  artists: z.array(z.string()).nullable().optional(),
}).passthrough();

const releaseSchema = z.object({
  title: z.string(),
  year: z.union([z.number(), z.string()]).nullable().optional(),
  type: z.string().nullable().optional(),
  label: z.string().nullable().optional(),
  total_duration: z.string().nullable().optional(),
  cover_image_url: z.string().nullable().optional(),
  cover_source_page_url: z.string().nullable().optional(),
  tracklist_status: z.string().nullable().optional(),
  tracks: z.array(trackSchema).nullable().optional(),
  source_urls: z.array(z.string()).nullable().optional(),
}).passthrough();

export const loteArtistSchema = z.object({
  id: z.string().min(1),
  artist_name: z.string().min(1),
  real_name: z.string().nullable().optional(),
  aliases: z.array(z.string()).nullable().optional(),
  entity_type: z.string().nullable().optional(),
  nationality_or_origin: z.string().nullable().optional(),
  nationality_basis: z.string().nullable().optional(),
  birth: placeSchema.optional(),
  death: placeSchema.optional(),
  origin: z.string().nullable().optional(),
  years_active: z.string().nullable().optional(),
  genres: z.array(z.string()).nullable().optional(),
  subgenres: z.array(z.string()).nullable().optional(),
  roles: z.array(z.string()).nullable().optional(),
  instruments: z.array(z.string()).nullable().optional(),
  members: z.array(z.string()).nullable().optional(),
  member_of: z.array(z.string()).nullable().optional(),
  labels: z.array(z.string()).nullable().optional(),
  bio: z.string().nullable().optional(),
  artist_image: z.object({ url: z.string().nullable().optional(), source_page_url: z.string().nullable().optional() }).passthrough().nullable().optional(),
  links: z.record(z.string().nullable()).nullable().optional(),
  discography: z.array(releaseSchema).nullable().optional(),
  selected_works: z.array(z.string()).nullable().optional(),
  sources: z.array(z.object({ url: z.string(), note: z.string().nullable().optional() })).nullable().optional(),
  verification_notes: z.array(z.string()).nullable().optional(),
}).passthrough();

export type LoteArtist = z.infer<typeof loteArtistSchema>;
export type LoteRelease = z.infer<typeof releaseSchema>;

export const loteFileSchema = z.object({ artists: z.array(loteArtistSchema) }).passthrough();

// --- Normalizadores --------------------------------------------------------

const clean = (value: string | null | undefined): string | null => {
  const trimmed = value?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed : null;
};

/** Clave de comparación: sin tildes, sin mayúsculas, sin puntuación ni comillas tipográficas. */
export function compareKey(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/[“”«»"'’`´]/g, "").replace(/&/g, " y ").replace(/[^a-z0-9]+/g, " ").trim();
}

/** Fecha completa AAAA-MM-DD válida; un año suelto no rellena una fecha. */
export function fullDate(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text || !/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== text ? null : text;
}

/** Año suelto («1981») o el año de una fecha completa. */
export function yearOf(value: string | null | undefined): number | null {
  const text = clean(value);
  const match = text?.match(/^(\d{4})(?:-\d{2}-\d{2})?$/);
  return match ? Number(match[1]) : null;
}

/**
 * Ciudad de un lugar del lote: «Barbacoas, Aragua, Venezuela» → «Barbacoas».
 * Un país suelto, «Raised in…» o dos orígenes («Venezuela / Mexico») no dan ciudad.
 */
export function cityOf(place: string | null | undefined): string | null {
  const text = clean(place);
  if (!text || /\braised\b|\bcriad[oa]\b|\//i.test(text)) return null;
  const parts = text.split(",").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2) return null;
  const city = parts[0]!;
  return /^(venezuela|caracas metropolitan area)$/i.test(city) ? null : city;
}

/** Lugar del lote que termina en Venezuela («Maracaibo, Zulia, Venezuela»). */
export function isVenezuelanPlace(place: string | null | undefined): boolean {
  const text = clean(place);
  return !!text && /,\s*venezuela\s*$/i.test(text);
}

/**
 * Misma ciudad aunque el core la escriba con su estado o con ruido:
 * «Caracas» ≈ «Caracas - Distrito Capital», «Barquisimeto- Lara», «1972 in Caracas».
 */
export function sameCity(lote: string, core: string): boolean {
  const city = compareKey(lote);
  const words = compareKey(core);
  return !!city && (words === city || words.startsWith(`${city} `) || words.endsWith(` ${city}`) || words.includes(` ${city} `));
}

/** Mismo título salvo calificadores entre paréntesis o corchetes: «Flor de Fuego» ≈ «Flor De Fuego (CD/DVD)». */
export function sameTitle(lote: string, core: string): boolean {
  const bare = (value: string) => compareKey(value.replace(/\s*[([][^)\]]*[)\]]/g, " "));
  return bare(lote) === bare(core);
}

/** Mismo nombre aunque cambien espacios y apóstrofos: «Oscar D'León» ≈ «Oscar D' León». */
export function sameName(lote: string, core: string): boolean {
  return compareKey(lote).replace(/ /g, "") === compareKey(core).replace(/ /g, "");
}

export interface YearsActive { text: string; from: number; to: number | null }

/**
 * «1974–present» → 1974-present; «1981–1992» → 1981-1992. Las décadas
 * («1970s–present»), los «late…» y los tramos con reunión no se interpretan.
 */
export function parseYearsActive(value: string | null | undefined): YearsActive | null {
  const text = clean(value);
  const match = text?.match(/^(\d{4})\s*[–—-]\s*(present|presente|\d{4})$/i);
  if (!match) return null;
  const from = Number(match[1]);
  const to = /^\d{4}$/.test(match[2]!) ? Number(match[2]) : null;
  if (to !== null && to < from) return null;
  return { text: `${from}-${to ?? "present"}`, from, to };
}

export type CoreArtistType = "band" | "solo_artist" | "duo" | "project" | "group" | "other";

/** Tipo del lote → tipo del core. «group» y «orchestra» son conjuntos (`band`). */
export function mapArtistType(value: string | null | undefined): CoreArtistType | null {
  switch (clean(value)?.toLowerCase()) {
    case "solo": return "solo_artist";
    case "duo": return "duo";
    case "band": case "group": case "orchestra": return "band";
    default: return null;
  }
}

/**
 * Solista y proyecto son una persona; banda, grupo y dúo son conjuntos. Solo
 * choca cruzar esa línea (un solista registrado como banda), no el matiz.
 */
export function artistTypeClash(lote: CoreArtistType, core: CoreArtistType): boolean {
  const solo = (type: CoreArtistType) => type === "solo_artist" || type === "project";
  if (core === "other") return false;
  return solo(lote) !== solo(core);
}

export type CoreAlbumType =
  | "studio_album" | "live_album" | "ep" | "single" | "compilation" | "demo" | "soundtrack" | "collaboration_album" | "remix" | "other";

export function mapAlbumType(value: string | null | undefined): CoreAlbumType | null {
  switch (clean(value)?.toLowerCase()) {
    case "album": return "studio_album";
    case "ep": return "ep";
    case "single": return "single";
    case "compilation": return "compilation";
    case "collaborative album": return "collaboration_album";
    case "live album": case "live": return "live_album";
    case "remix album": return "remix";
    case "soundtrack": return "soundtrack";
    default: return null;
  }
}

/** «03:05» → 185; «1:02:03» → 3723. */
export function durationSeconds(value: string | null | undefined): number | null {
  const text = clean(value);
  const match = text?.match(/^(?:(\d+):)?(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const seconds = Number(match[1] ?? 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return seconds > 0 ? seconds : null;
}

/** Venezolano según el lote; la nacionalidad «indicada por el proyecto» no cuenta. */
export function isVenezuelanPerLote(value: string | null | undefined): boolean | null {
  const text = clean(value);
  if (!text) return null;
  if (/user-specified|not located|indicada por el proyecto/i.test(text)) return null;
  return /^venezuelan\b/i.test(text) ? true : null;
}

/**
 * Miembro con nombre propio. «others», «multiple generations of vocalists» y
 * similares se descartan; «(early)», «(founder/leader)» pasan a nota.
 */
export function cleanMember(value: string): { name: string; note: string | null } | null {
  const text = clean(value);
  if (!text) return null;
  const note = text.match(/\(([^)]*)\)\s*$/)?.[1]?.trim() ?? null;
  const name = text.replace(/\s*\([^)]*\)\s*$/, "").trim();
  if (!name || /^(others?|otros?|various|varios)$/i.test(name)) return null;
  if (/\b(multiple|several|various|generations?|vocalists|musicians|members|lineups?|rotating)\b/i.test(name)) return null;
  if (!/\p{Lu}/u.test(name.charAt(0))) return null;
  return { name, note };
}

// --- Géneros: «Gothic» suelto según contexto ------------------------------

/**
 * Decisión de Brian (2026-10-02): «Gothic» suelto es metal gótico solo si la
 * ficha ya es de la familia metal; si no, rock gótico. Las cadenas explícitas
 * («Gothic Metal», «Gothic Rock») no cambian. Devuelve el texto con que el
 * claim entra al motor de reglas, para que la regla no dependa de código nuevo.
 */
export function contextualGenreText(raw: string, artistIsMetal: boolean): { text: string; contextual: boolean } {
  const key = compareKey(raw);
  if (key === "gothic" || key === "gotico" || key === "goth") {
    return { text: artistIsMetal ? "Gothic Metal" : "Gothic Rock", contextual: true };
  }
  return { text: raw.trim(), contextual: false };
}

// --- Hechos ---------------------------------------------------------------

export type FactTarget = "artist" | "person" | "album" | "track";

/** Qué hace la etapa 1 con un hecho cuya ficha ya existe. */
export type FactPolicy =
  /** Rellena el campo del core si está vacío; si no, confirma o choca. */
  | "fill"
  /** Nunca escribe: confirma o choca (nombre, tipo); el cambio es de la etapa 2. */
  | "compare"
  /** Queda como candidato para una etapa posterior (bio, géneros, miembros…). */
  | "candidate";

export interface LoteEvidence { url: string; excerpt: string; position: number }

export interface LoteFact {
  target: FactTarget;
  field: string;
  value: string | number | boolean;
  policy: FactPolicy;
  /** Texto literal del lote cuando el valor se normalizó. */
  raw?: string | undefined;
  note?: string | undefined;
  evidence: LoteEvidence[];
}

const ARTIST_FILL_FIELDS = new Set(["origin_city", "years_active", "formed_year", "disbanded_year"]);
const PERSON_FILL_FIELDS = new Set(["real_name", "birth_date", "birth_city", "death_date", "is_deceased", "is_venezuelan"]);
const ALBUM_FILL_FIELDS = new Set(["release_year", "album_type"]);

export function fillableFields(target: FactTarget): ReadonlySet<string> {
  return target === "artist" ? ARTIST_FILL_FIELDS : target === "person" ? PERSON_FILL_FIELDS : target === "album" ? ALBUM_FILL_FIELDS : new Set();
}

function artistEvidence(artist: LoteArtist, excerpt: string): LoteEvidence[] {
  const sources = (artist.sources ?? []).filter((source) => /^https?:\/\//.test(source.url));
  return sources.map((source, index) => ({
    url: source.url,
    excerpt: `${source.note ? `${source.note} · ` : ""}${excerpt}`.slice(0, 2_000),
    position: index,
  }));
}

function releaseEvidence(artist: LoteArtist, release: LoteRelease, excerpt: string): LoteEvidence[] {
  const urls = [...new Set([...(release.source_urls ?? []), release.cover_source_page_url ?? ""].filter((url) => /^https?:\/\//.test(url)))];
  if (!urls.length) return artistEvidence(artist, excerpt);
  return urls.map((url, index) => ({ url, excerpt: excerpt.slice(0, 2_000), position: index }));
}

const GROUP_TYPES = new Set(["band", "group", "orchestra", "duo"]);

/** Hechos de la ficha de artista (y de su persona titular, si es solista). */
export function artistFacts(artist: LoteArtist): LoteFact[] {
  const facts: LoteFact[] = [];
  const add = (target: FactTarget, field: string, value: string | number | boolean | null, policy: FactPolicy, excerpt: string, extra: Partial<LoteFact> = {}) => {
    if (value === null || value === "") return;
    const evidence = artistEvidence(artist, excerpt);
    if (!evidence.length) return;
    facts.push({ target, field, value, policy, evidence, ...extra });
  };
  const isGroup = GROUP_TYPES.has(clean(artist.entity_type)?.toLowerCase() ?? "");

  add("artist", "name", artist.artist_name.trim(), "compare", `artist_name: ${artist.artist_name}`);
  const type = mapArtistType(artist.entity_type);
  add("artist", "artist_type", type, "compare", `entity_type: ${artist.entity_type}`, { raw: artist.entity_type ?? undefined });
  for (const alias of artist.aliases ?? []) {
    if (clean(alias) && compareKey(alias) !== compareKey(artist.artist_name)) add("artist", "alias", clean(alias), "candidate", `aliases: ${alias}`);
  }
  const origin = clean(artist.origin);
  const birthPlace = clean(artist.birth?.place);
  // El origen de una ficha del catálogo es venezolano: un solista nacido en
  // Roma o Viena no tiene «Roma» por origen (su persona sí, como nacimiento).
  const fromOrigin = isVenezuelanPlace(origin) ? cityOf(origin) : null;
  const fromBirth = !isGroup && !origin && isVenezuelanPlace(birthPlace) ? cityOf(birthPlace) : null;
  if (fromOrigin) add("artist", "origin_city", fromOrigin, "fill", `origin: ${origin}`, { raw: origin ?? undefined });
  else if (fromBirth) add("artist", "origin_city", fromBirth, "fill", `birth.place: ${birthPlace}`, { raw: birthPlace ?? undefined });
  else if (origin) add("artist", "origin_text", origin, "candidate", `origin: ${origin}`);
  const years = parseYearsActive(artist.years_active);
  if (years) {
    add("artist", "years_active", years.text, "fill", `years_active: ${artist.years_active}`, { raw: artist.years_active ?? undefined });
    if (isGroup) {
      add("artist", "formed_year", years.from, "fill", `years_active: ${artist.years_active}`);
      if (years.to !== null) add("artist", "disbanded_year", years.to, "fill", `years_active: ${artist.years_active}`);
    }
  } else if (clean(artist.years_active)) {
    add("artist", "years_active_text", clean(artist.years_active), "candidate", `years_active: ${artist.years_active}`);
  }
  add("artist", "biography", clean(artist.bio), "candidate", clean(artist.bio) ?? "");
  const terms = [...(artist.genres ?? []), ...(artist.subgenres ?? [])].map(clean).filter((term): term is string => term !== null);
  [...new Set(terms)].forEach((term, index) => add("artist", "genre", term, "candidate", `${index < (artist.genres ?? []).length ? "genres" : "subgenres"}: ${term}`, { note: `orden ${index}` }));
  for (const member of artist.members ?? []) {
    const cleaned = cleanMember(member);
    if (cleaned) add("artist", "member", cleaned.name, "candidate", `members: ${member}`, cleaned.note ? { note: cleaned.note } : {});
  }
  for (const group of artist.member_of ?? []) {
    const cleaned = cleanMember(group);
    if (cleaned) add("artist", "member_of", cleaned.name, "candidate", `member_of: ${group}`, cleaned.note ? { note: cleaned.note } : {});
  }
  for (const [kind, url] of Object.entries(artist.links ?? {})) {
    if (url && /^https?:\/\//.test(url)) add("artist", `${kind}_url`, url, "candidate", `links.${kind}: ${url}`);
  }
  const imagePage = clean(artist.artist_image?.source_page_url);
  if (imagePage && /^https?:\/\//.test(imagePage)) add("artist", "picture_source_page", imagePage, "candidate", `artist_image.source_page_url: ${imagePage}`);
  if (artist.roles?.length) add("artist", "roles", artist.roles.join(", "), "candidate", `roles: ${artist.roles.join(", ")}`);
  if (artist.instruments?.length) add("artist", "instruments", artist.instruments.join(", "), "candidate", `instruments: ${artist.instruments.join(", ")}`);
  for (const work of artist.selected_works ?? []) add("artist", "notable_work", clean(work), "candidate", `selected_works: ${work}`);
  for (const note of artist.verification_notes ?? []) add("artist", "verification_note", clean(note), "candidate", `verification_notes: ${note}`);
  add("artist", "nationality", clean(artist.nationality_or_origin), "candidate", `nationality_or_origin: ${artist.nationality_or_origin}`);

  // Persona titular: solo solistas. Los conjuntos no tienen nacimiento propio.
  if (!isGroup) {
    const realName = clean(artist.real_name);
    add("person", "real_name", realName, "fill", `real_name: ${realName}`);
    const birthDate = fullDate(artist.birth?.date);
    add("person", "birth_date", birthDate, "fill", `birth.date: ${artist.birth?.date}`);
    if (!birthDate) add("person", "birth_year", yearOf(artist.birth?.date), "candidate", `birth.date: ${artist.birth?.date}`);
    add("person", "birth_city", cityOf(birthPlace), "fill", `birth.place: ${birthPlace}`, { raw: birthPlace ?? undefined });
    const deathDate = fullDate(artist.death?.date);
    add("person", "death_date", deathDate, "fill", `death.date: ${artist.death?.date}`);
    if (!deathDate) add("person", "death_year", yearOf(artist.death?.date), "candidate", `death.date: ${artist.death?.date}`);
    const deathPlace = clean(artist.death?.place);
    add("person", "death_place", deathPlace, "candidate", `death.place: ${deathPlace}`);
    if (deathDate || yearOf(artist.death?.date) !== null) add("person", "is_deceased", true, "fill", `death.date: ${artist.death?.date}`);
    add("person", "is_venezuelan", isVenezuelanPerLote(artist.nationality_or_origin), "fill", `nationality_or_origin: ${artist.nationality_or_origin}`);
  }
  return facts;
}

export interface ReleaseFacts { release: LoteRelease; index: number; album: LoteFact[]; tracks: Array<{ key: string; facts: LoteFact[] }> }

/** Hechos de un disco del lote y de sus pistas. */
export function releaseFacts(artist: LoteArtist, release: LoteRelease, index: number): ReleaseFacts {
  const album: LoteFact[] = [];
  const add = (list: LoteFact[], target: FactTarget, field: string, value: string | number | null, policy: FactPolicy, excerpt: string, extra: Partial<LoteFact> = {}) => {
    if (value === null || value === "") return;
    const evidence = releaseEvidence(artist, release, excerpt);
    if (!evidence.length) return;
    list.push({ target, field, value, policy, evidence, ...extra });
  };
  const head = `${artist.artist_name} — ${release.title}`;
  add(album, "album", "title", release.title.trim(), "compare", `${head}`);
  const year = typeof release.year === "number" ? release.year : yearOf(release.year ?? null);
  add(album, "album", "release_year", year, "fill", `${head} · year: ${release.year}`);
  // «album» a secas es el genérico de la investigación: no distingue estudio,
  // recopilatorio ni directo, así que ni rellena `other` ni choca. Solo los
  // tipos explícitos (EP, sencillo, recopilatorio, directo…) rellenan.
  const type = mapAlbumType(release.type);
  const generic = clean(release.type)?.toLowerCase() === "album";
  if (type) add(album, "album", "album_type", type, generic ? "candidate" : "fill", `${head} · type: ${release.type}`, { raw: release.type ?? undefined });
  else add(album, "album", "album_type_text", clean(release.type), "candidate", `${head} · type: ${release.type}`);
  add(album, "album", "label", clean(release.label), "candidate", `${head} · label: ${release.label}`);
  add(album, "album", "total_duration", clean(release.total_duration), "candidate", `${head} · total_duration: ${release.total_duration}`);
  add(album, "album", "tracklist_status", clean(release.tracklist_status), "candidate", `${head} · tracklist_status: ${release.tracklist_status}`);
  const cover = clean(release.cover_image_url);
  if (cover && /^https?:\/\//.test(cover)) add(album, "album", "cover_url", cover, "candidate", `${head} · cover_image_url: ${cover}`);

  const tracks: ReleaseFacts["tracks"] = [];
  (release.tracks ?? []).forEach((track, trackIndex) => {
    const position = typeof track.position === "number" ? track.position : Number.parseInt(String(track.position ?? ""), 10) || trackIndex + 1;
    const facts: LoteFact[] = [];
    const excerpt = `${head} · ${position}. ${track.title}${track.duration ? ` (${track.duration})` : ""}`;
    add(facts, "track", "title", track.title.trim(), "candidate", excerpt);
    add(facts, "track", "track_number", position, "candidate", excerpt);
    add(facts, "track", "duration_seconds", durationSeconds(track.duration), "candidate", excerpt, { raw: track.duration ?? undefined });
    for (const guest of track.artists ?? []) add(facts, "track", "featured_artist", clean(guest), "candidate", excerpt);
    tracks.push({ key: String(position), facts });
  });
  return { release, index, album, tracks };
}
