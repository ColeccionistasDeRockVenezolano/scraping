// CRV · Adaptadores de fuentes externas de géneros (PLAN_GENEROS etapa 4).
//
// Un adaptador solo sabe pedir y leer: busca candidatos, devuelve las
// etiquetas de una ficha y dice de qué clase es cada una. No decide identidad
// (eso es `identity.ts`), no resuelve géneros (eso es `mapping.ts`) y no
// escribe nada. Todo lo que pide pasa por `fetchCachedJson`, así que queda
// guardado con su URL y su fecha.
//
// Hoy están implementados MusicBrainz (API documentada, datos CC0, MBID
// estable) y Discogs (API autenticada con token propio, la mejor para
// ediciones físicas venezolanas). Wikidata tiene su ficha de evaluación
// (`data/genres/external-sources.json`,
// `docs/curation/GENEROS_FUENTES_EXTERNAS.md`) y entrará con su propio
// adaptador cuando se autorice; mientras, ninguna función la inventa.
import { getEnv } from "../../config/env.js";
import { normalizeIdentitySecondary } from "../../normalization/claims.js";
import { fetchCachedJson, type FetchContext, type JsonResponse } from "./http.js";
import type { ExternalCandidate } from "./identity.js";
import type { ExternalGenreValue } from "./mapping.js";

export interface AdapterContext {
  fetch: (requestKey: string, url: string) => Promise<JsonResponse>;
}

export interface ExternalFicha {
  values: ExternalGenreValue[];
  /** De dónde salió, para la evidencia de la sugerencia. */
  url: string;
  fetchedAt: Date;
}

export interface ExternalAdapter {
  slug: string;
  /** Niveles que esta fuente publica. Un género de artista nunca cruza a un disco. */
  levels: "artist" | "album" | "both";
  searchArtists: (context: AdapterContext, name: string) => Promise<ExternalCandidate[]>;
  artistGenres: (context: AdapterContext, externalId: string) => Promise<ExternalFicha>;
  /** Lanzamientos del artista ya identificado: candidatos para sus discos. */
  albumCandidates: (context: AdapterContext, artistExternalId: string) => Promise<ExternalCandidate[]>;
  albumGenres: (context: AdapterContext, externalId: string) => Promise<ExternalFicha>;
  urlFor: (level: "artist" | "album", externalId: string) => string;
}

export function adapterContextFor(context: FetchContext): AdapterContext {
  return { fetch: (requestKey, url) => fetchCachedJson(context, requestKey, url) };
}

// --- MusicBrainz -----------------------------------------------------------

const MB_BASE = "https://musicbrainz.org/ws/2";
/** Candidatos de la búsqueda que se completan con su ficha (una petición cada uno). */
const MB_HYDRATE = 3;

interface MbNamed { name?: unknown; count?: unknown }
interface MbArtist {
  id?: unknown; name?: unknown; country?: unknown; disambiguation?: unknown;
  area?: { name?: unknown } | null;
  "life-span"?: { begin?: unknown } | null;
  aliases?: Array<{ name?: unknown }> | null;
  genres?: MbNamed[] | null;
  tags?: MbNamed[] | null;
  "release-groups"?: Array<{ id?: unknown; title?: unknown; "first-release-date"?: unknown; "primary-type"?: unknown }> | null;
}

const text = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function yearOf(value: unknown): number | null {
  const match = /^(\d{4})/u.exec(typeof value === "string" ? value : "");
  return match ? Number(match[1]) : null;
}

/** Caracteres con significado en la consulta de búsqueda de MusicBrainz. */
function escapeLucene(value: string): string {
  return value.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/gu, "\\$1");
}

function requestKey(parts: string[]): string {
  return parts.join(":").slice(0, 300);
}

/**
 * A quién se le pide la ficha completa. Completar cuesta una o dos peticiones
 * por candidato y el límite de la fuente es lo caro: primero los que ya se
 * llaman igual que la ficha de CRV (Discogs devuelve también a los músicos de
 * la banda al buscar su nombre) y, si sobran turnos, los demás en orden —así
 * un alias con otro nombre sigue teniendo su oportunidad.
 */
function pickForHydration<T>(query: string, items: T[], nameOf: (item: T) => string | null, max: number): T[] {
  const wanted = normalizeIdentitySecondary(query);
  const exact: T[] = [];
  const rest: T[] = [];
  for (const item of items) {
    const name = nameOf(item);
    (name && normalizeIdentitySecondary(name) === wanted ? exact : rest).push(item);
  }
  return [...exact, ...rest].slice(0, max);
}

/** `genres` es vocabulario curado; `tags` son etiquetas de la comunidad. No se mezclan. */
function valuesOf(entity: { genres?: MbNamed[] | null; tags?: MbNamed[] | null }): ExternalGenreValue[] {
  const read = (list: MbNamed[] | null | undefined, kind: ExternalGenreValue["kind"]): ExternalGenreValue[] =>
    (list ?? []).flatMap((item) => {
      const name = text(item.name);
      if (!name) return [];
      return [{ value: name, kind, count: typeof item.count === "number" ? item.count : null }];
    }).sort((a, b) => (b.count ?? 0) - (a.count ?? 0) || a.value.localeCompare(b.value));
  return [...read(entity.genres, "editorial_genre"), ...read(entity.tags, "community_tag")];
}

function artistCandidate(artist: MbArtist): ExternalCandidate | null {
  const id = text(artist.id);
  const name = text(artist.name);
  if (!id || !name) return null;
  return {
    externalId: id,
    name,
    url: `https://musicbrainz.org/artist/${id}`,
    disambiguation: text(artist.disambiguation),
    country: text(artist.country),
    areaName: text(artist.area?.name),
    beginYear: yearOf(artist["life-span"]?.begin),
    releaseTitles: (artist["release-groups"] ?? []).flatMap((group) => {
      const title = text(group.title);
      return title ? [title] : [];
    }),
    memberNames: [],
  };
}

async function mbArtistLookup(context: AdapterContext, externalId: string): Promise<{ artist: MbArtist; response: JsonResponse }> {
  const url = `${MB_BASE}/artist/${encodeURIComponent(externalId)}?inc=genres+tags+release-groups&fmt=json`;
  const response = await context.fetch(requestKey(["artist", "lookup", externalId]), url);
  return { artist: (response.payload ?? {}) as MbArtist, response };
}

export const musicbrainzAdapter: ExternalAdapter = {
  slug: "musicbrainz",
  levels: "both",

  async searchArtists(context, name) {
    const query = `artist:"${escapeLucene(name)}"`;
    const url = `${MB_BASE}/artist?query=${encodeURIComponent(query)}&fmt=json&limit=8`;
    const response = await context.fetch(requestKey(["artist", "search", name.toLowerCase()]), url);
    const found = ((response.payload ?? {}) as { artists?: MbArtist[] }).artists ?? [];
    // La ficha completa (país, discografía) solo se pide para los primeros:
    // cada una es una petición y el límite de la fuente es sagrado.
    const hydrate = pickForHydration(name, found, (artist) => text(artist.name), MB_HYDRATE);
    const candidates: ExternalCandidate[] = [];
    for (const artist of found) {
      const id = text(artist.id);
      if (!id) continue;
      const full = hydrate.includes(artist) ? (await mbArtistLookup(context, id)).artist : {};
      const candidate = artistCandidate({ ...artist, ...full });
      if (candidate) candidates.push(candidate);
    }
    return candidates;
  },

  async artistGenres(context, externalId) {
    const { artist, response } = await mbArtistLookup(context, externalId);
    return { values: valuesOf(artist), url: response.url, fetchedAt: response.fetchedAt };
  },

  async albumCandidates(context, artistExternalId) {
    const { artist } = await mbArtistLookup(context, artistExternalId);
    return (artist["release-groups"] ?? []).flatMap((group) => {
      const id = text(group.id);
      const title = text(group.title);
      if (!id || !title) return [];
      return [{
        externalId: id,
        name: title,
        url: `https://musicbrainz.org/release-group/${id}`,
        artistExternalId,
        year: yearOf(group["first-release-date"]),
        trackTitles: [],
        labelNames: [],
        catalogNumbers: [],
      } satisfies ExternalCandidate];
    });
  },

  async albumGenres(context, externalId) {
    const url = `${MB_BASE}/release-group/${encodeURIComponent(externalId)}?inc=genres+tags&fmt=json`;
    const response = await context.fetch(requestKey(["release-group", "lookup", externalId]), url);
    return { values: valuesOf((response.payload ?? {}) as MbArtist), url: response.url, fetchedAt: response.fetchedAt };
  },

  urlFor(level, externalId) {
    return level === "artist" ? `https://musicbrainz.org/artist/${externalId}` : `https://musicbrainz.org/release-group/${externalId}`;
  },
};

// --- Discogs ---------------------------------------------------------------
//
// Su catálogo es el más fuerte en ediciones físicas venezolanas (sellos,
// números de catálogo, prensados). Dos particularidades que marcan el diseño:
//
//   * NO PUBLICA GÉNEROS DE ARTISTA: `genres` y `styles` viven en la edición
//     maestra o en el lanzamiento. Por eso su ficha declara `levels: album`.
//   * `styles` es el detalle (Hard Rock, Ska Punk) y `genres` lo ancho (Rock).
//     Se ofrecen en ese orden: el mapeo descarta como «demasiado general» lo
//     que solo repita la familia de algo que CRV ya precisó.
const DISCOGS_BASE = "https://api.discogs.com";
const DISCOGS_HYDRATE = 3;

interface DiscogsRelease {
  id?: unknown; type?: unknown; title?: unknown; year?: unknown; role?: unknown; label?: unknown;
}

/** `master:123` / `release:456`: el prefijo dice a qué endpoint volver. */
function discogsRef(type: unknown, id: unknown): string | null {
  const numeric = typeof id === "number" ? String(id) : text(id);
  if (!numeric) return null;
  return `${type === "master" ? "master" : "release"}:${numeric}`;
}

function discogsUrlFor(ref: string): string {
  const [kind, id] = ref.split(":");
  return `https://www.discogs.com/${kind === "master" ? "master" : "release"}/${id ?? ""}`;
}

async function discogsArtist(context: AdapterContext, externalId: string): Promise<Record<string, unknown>> {
  const url = `${DISCOGS_BASE}/artists/${encodeURIComponent(externalId)}`;
  const response = await context.fetch(requestKey(["artist", "lookup", externalId]), url);
  return (response.payload ?? {}) as Record<string, unknown>;
}

async function discogsArtistReleases(context: AdapterContext, externalId: string): Promise<DiscogsRelease[]> {
  const url = `${DISCOGS_BASE}/artists/${encodeURIComponent(externalId)}/releases?per_page=100&sort=year&sort_order=asc`;
  const response = await context.fetch(requestKey(["artist", "releases", externalId]), url);
  const all = ((response.payload ?? {}) as { releases?: DiscogsRelease[] }).releases ?? [];
  // Solo lo que la banda firma: las apariciones en compilados ajenos no son su discografía.
  return all.filter((release) => release.role === "Main" || release.role === undefined);
}

export const discogsAdapter: ExternalAdapter = {
  slug: "discogs",
  levels: "album",

  async searchArtists(context, name) {
    const url = `${DISCOGS_BASE}/database/search?type=artist&per_page=8&q=${encodeURIComponent(name)}`;
    const response = await context.fetch(requestKey(["artist", "search", name.toLowerCase()]), url);
    const found = ((response.payload ?? {}) as { results?: Array<Record<string, unknown>> }).results ?? [];
    const candidates: ExternalCandidate[] = [];
    const hydrate = pickForHydration(name, found, (result) => text(result["title"]), DISCOGS_HYDRATE);
    for (const result of hydrate) {
      const id = typeof result["id"] === "number" ? String(result["id"]) : text(result["id"]);
      if (!id) continue;
      const artist = await discogsArtist(context, id);
      const releases = await discogsArtistReleases(context, id);
      candidates.push({
        externalId: id,
        name: text(artist["name"]) ?? text(result["title"]) ?? id,
        url: `https://www.discogs.com/artist/${id}`,
        disambiguation: text(artist["profile"])?.slice(0, 200) ?? null,
        // Discogs no declara país del artista: la identidad se apoya en la
        // discografía y en los miembros, que sí publica.
        country: null,
        areaName: null,
        releaseTitles: releases.flatMap((release) => {
          const title = text(release.title);
          return title ? [title] : [];
        }),
        memberNames: ((artist["members"] as Array<{ name?: unknown }> | undefined) ?? [])
          .flatMap((member) => {
            const memberName = text(member.name);
            return memberName ? [memberName] : [];
          }),
      });
    }
    return candidates;
  },

  async artistGenres() {
    // Discogs no publica géneros de artista. Devolver nada es la respuesta
    // correcta: un género de disco NUNCA sube al artista.
    return { values: [], url: `${DISCOGS_BASE}/artists`, fetchedAt: new Date() };
  },

  async albumCandidates(context, artistExternalId) {
    const releases = await discogsArtistReleases(context, artistExternalId);
    return releases.flatMap((release) => {
      const ref = discogsRef(release.type, release.id);
      const title = text(release.title);
      if (!ref || !title) return [];
      const label = text(release.label);
      return [{
        externalId: ref,
        name: title,
        url: discogsUrlFor(ref),
        artistExternalId,
        year: typeof release.year === "number" && release.year > 0 ? release.year : yearOf(release.year),
        trackTitles: [],
        labelNames: label ? [label] : [],
        catalogNumbers: [],
      } satisfies ExternalCandidate];
    });
  },

  async albumGenres(context, externalId) {
    const [kind, id] = externalId.split(":");
    const path = kind === "master" ? "masters" : "releases";
    const url = `${DISCOGS_BASE}/${path}/${encodeURIComponent(id ?? "")}`;
    const response = await context.fetch(requestKey([path, "lookup", id ?? ""]), url);
    const payload = (response.payload ?? {}) as { genres?: unknown[]; styles?: unknown[] };
    const read = (list: unknown[] | undefined) => (list ?? []).flatMap((item) => {
      const value = text(item);
      return value ? [{ value, kind: "editorial_genre" as const, count: null }] : [];
    });
    // Primero el detalle (`styles`), después lo ancho (`genres`).
    return { values: [...read(payload.styles), ...read(payload.genres)], url: response.url, fetchedAt: response.fetchedAt };
  },

  urlFor(level, externalId) {
    return level === "artist" ? `https://www.discogs.com/artist/${externalId}` : discogsUrlFor(externalId);
  },
};

/**
 * Credenciales e identificación propias de cada fuente. El token de Discogs
 * viaja en la cabecera, NUNCA en la URL: `ingest.genre_external_cache` guarda
 * la URL de cada respuesta y un secreto no tiene nada que hacer ahí.
 */
export function sourceAuthHeaders(slug: string): Record<string, string> {
  if (slug !== "discogs") return {};
  const token = getEnv().DISCOGS_TOKEN?.trim();
  if (!token) throw new Error("falta DISCOGS_TOKEN en .env: la API de Discogs exige token propio");
  return { authorization: `Discogs token=${token}` };
}

const ADAPTERS = new Map<string, ExternalAdapter>([
  [musicbrainzAdapter.slug, musicbrainzAdapter],
  [discogsAdapter.slug, discogsAdapter],
]);

export function adapterFor(slug: string): ExternalAdapter | undefined {
  return ADAPTERS.get(slug);
}

export function knownAdapterSlugs(): string[] {
  return [...ADAPTERS.keys()].sort();
}
