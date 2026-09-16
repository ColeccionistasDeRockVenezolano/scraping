// CRV · Vocabulario aprendido del propio catálogo.
//
// El detector no trae listas cerradas de «palabras de sello», «lugares» o
// «roles»: las deriva en cada análisis de lo que el catálogo ya sabe.
//  * Lugares: las partes de `artists.origin_city`.
//  * Roles: las palabras de `album_credits.role` y `track_credits.role`.
//  * Marcas de organización: palabras mucho más frecuentes en nombres de
//    organización que en nombres de persona (lift), más el patrón compartido
//    de person-names.ts.
//  * Tipos de disco: palabras sobre-representadas en los títulos de cada
//    `album_type` ya clasificado, más una semilla mínima para un catálogo
//    donde casi todo es `other`.
//  * Perfil de cada campo de texto: caracteres, largo y proporción de letras,
//    con los que «Otros» reconoce lo atípico sin saber de antemano qué buscar.
// Cuando el catálogo cambia, el vocabulario cambia con él.
import { normalizeEntityName } from "../normalization/entity-name.js";
import type { CatalogSnapshot, EntityRef, SnapshotAlbum, SnapshotArtist } from "./types.js";

/** Clave sin tildes, mayúsculas ni signos. */
export function nameKey(value: string): string {
  return normalizeEntityName(value).secondaryKey;
}

export function keyTokens(value: string): string[] {
  return nameKey(value).split(" ").filter(Boolean);
}

/** Clave sin artículo inicial y sin espacios: «Los Flanders» = «Flanders», «AC/DC» = «AC DC». */
export function compactKey(value: string): string {
  return normalizeEntityName(value).articlelessSecondaryKey.replace(/\s+/gu, "");
}

export type NameKind = "artist" | "person" | "organization" | "album" | "track";

export interface NameValue {
  kind: NameKind;
  id: number;
  field: "name" | "title";
  value: string;
  label: string;
  related: EntityRef[];
}

export interface FieldProfile {
  values: number;
  /** En cuántos valores aparece cada signo (no letra, no dígito, no espacio). */
  signDocs: Map<string, number>;
  lengthMedian: number;
  lengthMad: number;
  letterRatioMedian: number;
}

export interface Lexicon {
  places: Set<string>;
  placeTokens: Set<string>;
  roleTokens: Set<string>;
  organizationMarkers: Set<string>;
  albumTypeWords: Map<string, string>;
  vocabulary: Set<string>;
  artistsByKey: Map<string, SnapshotArtist[]>;
  personsByKey: Map<string, number[]>;
  organizationsByKey: Map<string, number[]>;
  profiles: Map<string, FieldProfile>;
}

/** Semilla de tipos: el catálogo tiene 3.481 de 4.694 discos sin clasificar. */
const SEED_ALBUM_TYPE_WORDS: ReadonlyArray<[string, string]> = [
  ["demo", "demo"], ["maqueta", "demo"],
  ["ep", "ep"],
  ["single", "single"], ["sencillo", "single"],
  ["en vivo", "live_album"], ["live", "live_album"], ["directo", "live_album"],
  ["recopilatorio", "compilation"], ["compilado", "compilation"], ["compilation", "compilation"], ["antologia", "compilation"],
  ["split", "collaboration_album"],
  ["soundtrack", "soundtrack"], ["banda sonora", "soundtrack"],
  ["remix", "remix"], ["remixes", "remix"],
];

const PLACE_SPLIT = /\s*(?:[-–—,/()]|\by\b)\s*/u;
const TRIVIAL_PLACE_TOKENS = new Set(["edo", "estado", "de", "del", "la", "el", "los", "las", "san", "city", "ciudad"]);

function median(sorted: number[]): number {
  if (!sorted.length) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function robustSpread(values: number[]): { median: number; mad: number } {
  const sorted = [...values].sort((a, b) => a - b);
  const m = median(sorted);
  const deviations = sorted.map((value) => Math.abs(value - m)).sort((a, b) => a - b);
  return { median: m, mad: median(deviations) };
}

export function letterRatio(value: string): number {
  const visible = value.replace(/\s+/gu, "");
  if (!visible.length) return 0;
  return (visible.match(/\p{L}/gu) ?? []).length / visible.length;
}

export function signsOf(value: string): Set<string> {
  return new Set([...value].filter((char) => !/[\p{L}\p{N}\s]/u.test(char)));
}

function profileOf(values: string[]): FieldProfile {
  const signDocs = new Map<string, number>();
  for (const value of values) for (const sign of signsOf(value)) signDocs.set(sign, (signDocs.get(sign) ?? 0) + 1);
  const lengths = robustSpread(values.map((value) => [...value].length));
  return {
    values: values.length,
    signDocs,
    lengthMedian: lengths.median,
    lengthMad: lengths.mad,
    letterRatioMedian: median(values.map(letterRatio).sort((a, b) => a - b)),
  };
}

function docFrequency(values: string[]): Map<string, number> {
  const docs = new Map<string, number>();
  for (const value of values) for (const token of new Set(keyTokens(value))) docs.set(token, (docs.get(token) ?? 0) + 1);
  return docs;
}

function learnOrganizationMarkers(snapshot: CatalogSnapshot): Set<string> {
  const orgDocs = docFrequency(snapshot.organizations.map((org) => org.name));
  const personDocs = docFrequency(snapshot.persons.map((person) => person.name));
  const orgs = Math.max(snapshot.organizations.length, 1);
  const persons = Math.max(snapshot.persons.length, 1);
  const markers = new Set<string>();
  for (const [token, docs] of orgDocs) {
    if (docs < 3 || token.length < 3 || /^\d+$/u.test(token)) continue;
    const lift = (docs / orgs) / (((personDocs.get(token) ?? 0) + 0.5) / persons);
    if (lift >= 25) markers.add(token);
  }
  return markers;
}

function learnRoleTokens(snapshot: CatalogSnapshot): Set<string> {
  const uses = new Map<string, number>();
  const distinctRoles = new Map<string, number>();
  for (const credit of snapshot.creditRoles) {
    for (const token of new Set([...keyTokens(credit.role), ...keyTokens(credit.creditType.replace(/_/gu, " "))])) {
      uses.set(token, (uses.get(token) ?? 0) + credit.uses);
      distinctRoles.set(token, (distinctRoles.get(token) ?? 0) + 1);
    }
  }
  const personDocs = docFrequency(snapshot.persons.map((person) => person.name));
  const persons = Math.max(snapshot.persons.length, 1);
  const roles = new Set<string>();
  for (const [token, count] of uses) {
    // Una palabra de rol que también es frecuente en nombres («de», «la»,
    // «San») no distingue nada.
    // Un nombre propio dentro de un rol («Voz de Ángela») aparece en uno o dos
    // roles; una palabra de rol, en muchos distintos.
    if (count >= 5 && (distinctRoles.get(token) ?? 0) >= 3 && token.length >= 3 && !/^\d+$/u.test(token)
      && (personDocs.get(token) ?? 0) / persons < 0.002) roles.add(token);
  }
  return roles;
}

function learnAlbumTypeWords(albums: SnapshotAlbum[]): Map<string, string> {
  const words = new Map<string, string>(SEED_ALBUM_TYPE_WORDS);
  const typed = albums.filter((album) => album.albumType !== "other");
  if (typed.length < 20) return words;
  const allDocs = new Map<string, number>();
  for (const album of albums) for (const token of new Set(keyTokens(album.title))) allDocs.set(token, (allDocs.get(token) ?? 0) + 1);
  const perType = new Map<string, Map<string, number>>();
  const overall = new Map<string, number>();
  // Artistas distintos por palabra: la discografía de un solo artista
  // («Diego», «Caracas» en los recopilatorios de Various Artists) no enseña
  // qué significa un tipo de disco.
  const artistsPerToken = new Map<string, Set<number>>();
  const typeTotals = new Map<string, number>();
  for (const album of typed) {
    typeTotals.set(album.albumType, (typeTotals.get(album.albumType) ?? 0) + 1);
    const counts = perType.get(album.albumType) ?? new Map<string, number>();
    for (const token of new Set(keyTokens(album.title))) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
      overall.set(token, (overall.get(token) ?? 0) + 1);
      artistsPerToken.set(token, (artistsPerToken.get(token) ?? new Set<number>()).add(album.artistId));
    }
    perType.set(album.albumType, counts);
  }
  for (const [type, counts] of perType) {
    for (const [token, count] of counts) {
      const share = count / (overall.get(token) ?? count);
      const lift = (count / (typeTotals.get(type) ?? 1)) / ((overall.get(token) ?? count) / typed.length);
      // Y la palabra tiene que ser propia de ese tipo en TODO el catálogo, no
      // solo entre los clasificados: «rock» o «vol» abundan en discos sin tipo.
      if (count >= 5 && share >= 0.7 && lift >= 4 && (artistsPerToken.get(token)?.size ?? 0) >= 5 && count / (allDocs.get(token) ?? count) >= 0.25
        && token.length >= 2 && !/^\d+$/u.test(token) && !words.has(token)) words.set(token, type);
    }
  }
  return words;
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const item of items) {
    const value = key(item);
    if (!value) continue;
    const list = out.get(value);
    if (list) list.push(item); else out.set(value, [item]);
  }
  return out;
}

export function collectNames(snapshot: CatalogSnapshot): NameValue[] {
  const artists = new Map(snapshot.artists.map((artist) => [artist.id, artist]));
  const albums = new Map(snapshot.albums.map((album) => [album.id, album]));
  const names: NameValue[] = [];
  for (const artist of snapshot.artists) names.push({ kind: "artist", id: artist.id, field: "name", value: artist.name, label: artist.name, related: [] });
  for (const person of snapshot.persons) names.push({ kind: "person", id: person.id, field: "name", value: person.name, label: person.name, related: [] });
  for (const org of snapshot.organizations) names.push({ kind: "organization", id: org.id, field: "name", value: org.name, label: org.name, related: [] });
  for (const album of snapshot.albums) {
    const artist = artists.get(album.artistId);
    names.push({ kind: "album", id: album.id, field: "title", value: album.title, label: album.title,
      related: artist ? [{ kind: "artist", id: artist.id, label: artist.name }] : [] });
  }
  for (const track of snapshot.tracks) {
    const album = albums.get(track.albumId);
    const artist = album ? artists.get(album.artistId) : undefined;
    names.push({ kind: "track", id: track.id, field: "title", value: track.title, label: track.title,
      related: album ? [{ kind: "album", id: album.id, label: artist ? `${album.title} — ${artist.name}` : album.title }] : [] });
  }
  return names;
}

export function buildLexicon(snapshot: CatalogSnapshot, names: NameValue[]): Lexicon {
  const places = new Set<string>();
  const placeTokens = new Set<string>();
  for (const artist of snapshot.artists) {
    for (const part of (artist.originCity ?? "").split(PLACE_SPLIT)) {
      const key = nameKey(part);
      if (key.length < 4 || /^\d+$/u.test(key)) continue;
      places.add(key);
      for (const token of key.split(" ")) if (token.length >= 4 && !TRIVIAL_PLACE_TOKENS.has(token) && !/^\d+$/u.test(token)) placeTokens.add(token);
    }
  }

  const vocabulary = new Set<string>();
  const tokenCounts = new Map<string, number>();
  for (const name of names) for (const token of keyTokens(name.value)) tokenCounts.set(token, (tokenCounts.get(token) ?? 0) + 1);
  for (const [token, count] of tokenCounts) if (count >= 2 && token.length >= 3) vocabulary.add(token);

  const profiles = new Map<string, FieldProfile>();
  for (const [field, values] of group(names, (name) => `${name.kind}.${name.field}`)) profiles.set(field, profileOf(values.map((name) => name.value)));

  return {
    places,
    placeTokens,
    roleTokens: learnRoleTokens(snapshot),
    organizationMarkers: learnOrganizationMarkers(snapshot),
    albumTypeWords: learnAlbumTypeWords(snapshot.albums),
    vocabulary,
    artistsByKey: group(snapshot.artists, (artist) => nameKey(artist.name)),
    personsByKey: new Map([...group(snapshot.persons, (person) => nameKey(person.name))].map(([key, list]) => [key, list.map((person) => person.id)])),
    organizationsByKey: new Map([...group(snapshot.organizations, (org) => nameKey(org.name))].map(([key, list]) => [key, list.map((org) => org.id)])),
    profiles,
  };
}

/** ¿El texto nombra un lugar que el catálogo conoce como origen? */
export function isKnownPlace(lexicon: Lexicon, text: string): boolean {
  const key = nameKey(text);
  if (!key) return false;
  if (lexicon.places.has(key)) return true;
  const tokens = key.split(" ").filter((token) => !TRIVIAL_PLACE_TOKENS.has(token));
  return tokens.length > 0 && tokens.length <= 3 && tokens.every((token) => lexicon.placeTokens.has(token));
}
