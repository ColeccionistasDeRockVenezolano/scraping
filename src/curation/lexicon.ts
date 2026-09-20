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
//  * Nombres de pila: primeras palabras frecuentes de los nombres de persona
//    («Dan», «John»), para reconocer la forma de un nombre de persona.
//  * Palabras de nombre de persona: las que aparecen en varios nombres que
//    empiezan por un nombre de pila; un texto sin ninguna no es un nombre.
//  * Descriptores: palabras de género o de serie («Rock», «Punk», «Vol») que
//    usan en su nombre varios artistas y en sus títulos muchos más. Describen
//    la música, no el tipo de disco ni a una persona.
//  * Piezas breves: palabras de título cuyas pistas son casi siempre cortas
//    («Intro», «Entrevista»), más una semilla mínima.
//  * Perfil de cada campo de texto: caracteres, largo y proporción de letras,
//    con los que «Otros» reconoce lo atípico sin saber de antemano qué buscar.
// Cuando el catálogo cambia, el vocabulario cambia con él.
import { normalizeEntityName } from "../normalization/entity-name.js";
import { looksLikeOrganization } from "../review/person-names.js";
import type { CatalogSnapshot, EntityRef, SnapshotAlbum, SnapshotArtist } from "./types.js";

/**
 * Clave sin tildes, mayúsculas ni signos.
 *
 * Memoizada: normalizar cuesta ~5 µs y el análisis completo la llama más de un
 * millón de veces sobre los mismos ~44.000 nombres (el vocabulario la recorre
 * cinco veces y cada detector otras tantas). Con la caché, construir el
 * vocabulario baja de ~1,2 s a ~0,4 s (PLAN_CURADURIA E9.5). La caché se vacía
 * entera al llegar al tope: es un acelerador, no un índice, y ningún resultado
 * depende de qué haya dentro.
 */
const KEY_CACHE_MAX = 200_000;
const keyCache = new Map<string, string>();

export function nameKey(value: string): string {
  const cached = keyCache.get(value);
  if (cached !== undefined) return cached;
  const key = normalizeEntityName(value).secondaryKey;
  if (keyCache.size >= KEY_CACHE_MAX) keyCache.clear();
  keyCache.set(value, key);
  return key;
}

/** Solo para pruebas y medidas: vacía la caché de claves. */
export function resetNameKeyCache(): void {
  keyCache.clear();
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
  /** Primeras palabras frecuentes de los nombres de persona: «dan», «john», «maria». */
  givenNames: Set<string>;
  /** Palabras que aparecen en varios nombres de persona con nombre de pila. */
  personNameTokens: Set<string>;
  /** Las que aparecen detrás del nombre de pila: apellidos («jimenez», «rada»). */
  surnames: Set<string>;
  /** Palabras de género o de serie: «rock», «punk», «vol». */
  descriptorTokens: Set<string>;
  /** Palabras de título de pieza breve: una pista corta con una de ellas no es atípica. */
  briefPieceTokens: Set<string>;
  /**
   * Distribución de duraciones del catálogo entero en escala logarítmica
   * (mediana y desviación robusta). Vive aquí, y no en el detector, porque es
   * una medida global: un análisis dirigido mira cuatro pistas y no podría
   * calcularla (PLAN_CURADURIA E9.1). `null` = el catálogo no tiene bastantes
   * duraciones para comparar.
   */
  durations: { median: number; mad: number } | null;
  vocabulary: Set<string>;
  artistsByKey: Map<string, SnapshotArtist[]>;
  personsByKey: Map<string, number[]>;
  organizationsByKey: Map<string, number[]>;
  profiles: Map<string, FieldProfile>;
}

/**
 * Semilla de tipos: el catálogo tiene 3.481 de 4.694 discos sin clasificar.
 * Solo las semillas declaran un tipo sin criterio humano (PLAN_CURADURIA §2.1,
 * nivel 0); lo aprendido del catálogo siempre pide confirmación. Los plurales
 * van en la semilla: «Demos» sin clasificar se parece en el catálogo a «Vol»
 * (la mayoría de sus discos no tiene tipo) y ya no se aprendería.
 */
const SEED_ALBUM_TYPE_WORDS: ReadonlyArray<[string, string]> = [
  ["demo", "demo"], ["demos", "demo"], ["maqueta", "demo"], ["maquetas", "demo"],
  ["ep", "ep"],
  // «Singles» o «Sencillos» como título es una colección de sencillos: un recopilatorio, no un sencillo.
  ["single", "single"], ["sencillo", "single"],
  ["en vivo", "live_album"], ["live", "live_album"], ["directo", "live_album"],
  ["recopilatorio", "compilation"], ["compilado", "compilation"], ["compilation", "compilation"], ["antologia", "compilation"],
  ["split", "collaboration_album"],
  ["soundtrack", "soundtrack"], ["banda sonora", "soundtrack"],
  ["remix", "remix"], ["remixes", "remix"],
];

export const SEED_ALBUM_TYPE_WORD_SET: ReadonlySet<string> = new Set(SEED_ALBUM_TYPE_WORDS.map(([word]) => word));

/** Numeran una serie, no dicen el tipo: «Rock Venezolano Vol. 2» no es un recopilatorio por decir «vol». */
const VOLUME_TOKENS = new Set(["vol", "vols", "volumen", "volume", "parte", "part", "pt", "tomo", "capitulo", "chapter"]);
/**
 * Una palabra aprendida tiene que describir a la mayoría de los discos que la
 * usan: si más de la mitad está sin clasificar, lo aprendido de la minoría
 * clasificada decidiría por el resto («vol» y «rock»: 59–60 % sin tipo).
 */
const MAX_UNCLASSIFIED_SHARE = 0.5;
/** Una palabra que usan en su nombre tantos artistas, y en sus títulos tantos más, es género o serie («Rock», «Vol»). */
const DESCRIPTOR_MIN_ARTIST_NAMES = 3;
const DESCRIPTOR_MIN_TITLE_ARTISTS = 5;
/**
 * Y describe el disco, no la canción: su frecuencia en títulos de disco es al
 * menos 2,5 veces la de títulos de pista («rock» 2,8; «punk» 3,2). Las palabras
 * comunes que también nombran bandas («blood», «pan», «tierra») rondan 1.
 */
const DESCRIPTOR_ALBUM_TITLE_LIFT = 2.5;

/** Artículos, partículas y rótulos que empiezan nombres sin ser nombres de pila. */
const NOT_GIVEN_NAMES = new Set([
  "el", "la", "los", "las", "lo", "un", "una", "the", "a", "an", "de", "del", "y", "e", "and", "of", "da", "do", "dos", "van", "von",
  "der", "le", "les", "di", "du", "mr", "mrs", "ms", "dr", "sr", "sra", "dj", "mc", "grupo", "banda", "orquesta", "conjunto", "coro",
  // Rótulos de versión e idioma: «Versión Radio», «Spanish Version» son créditos mal cargados, no personas.
  "version", "remix", "mix", "live", "vivo", "demo", "edit", "dub", "instrumental", "acustica", "acustico", "acoustic", "bonus",
  "spanish", "english", "espanol", "ingles", "italiano",
]);
const GIVEN_NAME_MIN_PERSONS = 3;
const PERSON_TOKEN_MIN_PERSONS = 2;

/** Semilla de piezas breves: en casi cualquier catálogo duran menos de un minuto. */
const SEED_BRIEF_PIECE_TOKENS = [
  "intro", "introduccion", "outro", "interludio", "interlude", "intermedio", "skit", "presentacion", "preludio", "prelude",
  "coda", "reprise", "jingle", "cortina", "saludo", "bloopers",
];
const BRIEF_PIECE_MIN_TRACKS = 5;
const BRIEF_PIECE_MIN_ALBUMS = 3;
/** Una palabra de pieza breve: la mediana de sus pistas no llega a un tercio de la del catálogo. */
const BRIEF_PIECE_MEDIAN_RATIO = 1 / 3;

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

/**
 * Unidor de ancho cero (U+200D) y selector de variación U+FE0F dentro de un
 * emoji compuesto («👨‍🎤»): son parte legítima del emoji, no un invisible suelto.
 */
const EMOJI_JOINER = /(?<=\p{Extended_Pictographic}[\u{1F3FB}-\u{1F3FF}]?)\uFE0F|(?<=\p{Extended_Pictographic}(?:[\u{1F3FB}-\u{1F3FF}]|\uFE0F)?)\u200D(?=\p{Extended_Pictographic})/gu;

export function withoutEmojiJoiners(value: string): string {
  return value.replace(EMOJI_JOINER, "");
}

export function signsOf(value: string): Set<string> {
  return new Set([...withoutEmojiJoiners(value)].filter((char) => !/[\p{L}\p{N}\s]/u.test(char)));
}

export type SignClass = "puntuacion" | "moneda" | "simbolo" | "invisible_o_marca";

/** Clase Unicode de un signo: «Otros» agrupa por clase, no un subgrupo por carácter. */
export function signClass(sign: string): SignClass {
  if (/\p{P}/u.test(sign)) return "puntuacion";
  if (/\p{Sc}/u.test(sign)) return "moneda";
  if (/\p{S}/u.test(sign)) return "simbolo";
  return "invisible_o_marca";
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

function learnAlbumTypeWords(albums: SnapshotAlbum[], descriptors: Set<string>): Map<string, string> {
  const words = new Map<string, string>(SEED_ALBUM_TYPE_WORDS);
  const typed = albums.filter((album) => album.albumType !== "other");
  if (typed.length < 20) return words;
  const allDocs = new Map<string, number>();
  const unclassifiedDocs = new Map<string, number>();
  for (const album of albums) {
    for (const token of new Set(keyTokens(album.title))) {
      allDocs.set(token, (allDocs.get(token) ?? 0) + 1);
      if (album.albumType === "other") unclassifiedDocs.set(token, (unclassifiedDocs.get(token) ?? 0) + 1);
    }
  }
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
      const docs = allDocs.get(token) ?? count;
      if (count >= 5 && share >= 0.7 && lift >= 4 && (artistsPerToken.get(token)?.size ?? 0) >= 5 && count / docs >= 0.25
        && (unclassifiedDocs.get(token) ?? 0) / docs <= MAX_UNCLASSIFIED_SHARE
        && !VOLUME_TOKENS.has(token) && !descriptors.has(token)
        && token.length >= 2 && !/^\d+$/u.test(token) && !words.has(token)) words.set(token, type);
    }
  }
  return words;
}

/**
 * Primeras palabras de los nombres de persona de dos o más palabras que se
 * repiten en varias personas. Fuera artículos, rótulos («DJ», «Grupo») y las
 * palabras propias de organizaciones («Estudio X» también empieza igual).
 */
function learnGivenNames(snapshot: CatalogSnapshot, organizationMarkers: Set<string>, roleTokens: Set<string>): Set<string> {
  const counts = new Map<string, number>();
  const later = new Map<string, number>();
  for (const person of snapshot.persons) {
    if (looksLikeOrganization(person.name)) continue;
    const tokens = keyTokens(person.name);
    if (tokens.length < 2) continue;
    counts.set(tokens[0]!, (counts.get(tokens[0]!) ?? 0) + 1);
    for (const token of new Set(tokens.slice(1))) later.set(token, (later.get(token) ?? 0) + 1);
  }
  const names = new Set<string>();
  for (const [token, count] of counts) {
    // Un nombre de pila va sobre todo delante: «Version» empieza cuatro fichas
    // basura («Version A. Mattey») y cierra muchas más («Radio Version»). Los
    // compuestos («José Luis») dejan margen: basta la mitad.
    if (count >= GIVEN_NAME_MIN_PERSONS && count * 2 >= (later.get(token) ?? 0) && token.length >= 2 && !/\d/u.test(token) && !NOT_GIVEN_NAMES.has(token)
      && !organizationMarkers.has(token) && !roleTokens.has(token)) names.add(token);
  }
  return names;
}

/**
 * Palabras de los nombres de persona que empiezan por un nombre de pila
 * conocido y no son todo minúsculas. Las fichas basura («Skacustic Version by
 * DP Midnite Combo», «plus bonus tracks…») no empiezan así y no enseñan nada.
 */
function learnPersonNameTokens(
  snapshot: CatalogSnapshot, givenNames: Set<string>, organizationMarkers: Set<string>, roleTokens: Set<string>,
): { tokens: Set<string>; surnames: Set<string> } {
  const names = snapshot.persons
    .filter((person) => /\p{Lu}/u.test(person.name) && !looksLikeOrganization(person.name) && givenNames.has(keyTokens(person.name)[0] ?? ""))
    .map((person) => keyTokens(person.name));
  const docs = new Map<string, number>();
  const laterDocs = new Map<string, number>();
  for (const name of names) {
    for (const token of new Set(name)) docs.set(token, (docs.get(token) ?? 0) + 1);
    for (const token of new Set(name.slice(1))) laterDocs.set(token, (laterDocs.get(token) ?? 0) + 1);
  }
  const usable = (token: string, count: number): boolean => count >= PERSON_TOKEN_MIN_PERSONS && token.length >= 2 && !/\d/u.test(token)
    && !NOT_GIVEN_NAMES.has(token) && !organizationMarkers.has(token) && !roleTokens.has(token);
  return {
    tokens: new Set([...docs].filter(([token, count]) => usable(token, count)).map(([token]) => token)),
    surnames: new Set([...laterDocs].filter(([token, count]) => usable(token, count)).map(([token]) => token)),
  };
}

/**
 * Género o serie: en nombres de varios artistas, en títulos de disco de muchos
 * y más en títulos de disco que de pista; nunca un lugar ni una palabra de
 * nombre de persona.
 */
function learnDescriptorTokens(snapshot: CatalogSnapshot, givenNames: Set<string>, personNameTokens: Set<string>, placeTokens: Set<string>): Set<string> {
  const artistNames = new Map<string, Set<number>>();
  for (const artist of snapshot.artists) for (const token of new Set(keyTokens(artist.name))) artistNames.set(token, (artistNames.get(token) ?? new Set<number>()).add(artist.id));
  const titleArtists = new Map<string, Set<number>>();
  for (const album of snapshot.albums) for (const token of new Set(keyTokens(album.title))) titleArtists.set(token, (titleArtists.get(token) ?? new Set<number>()).add(album.artistId));
  const albumDocs = docFrequency(snapshot.albums.map((album) => album.title));
  const trackDocs = docFrequency(snapshot.tracks.map((track) => track.title));
  const albums = Math.max(snapshot.albums.length, 1);
  const tracks = Math.max(snapshot.tracks.length, 1);
  const describesAlbums = (token: string): boolean =>
    (albumDocs.get(token) ?? 0) / albums >= DESCRIPTOR_ALBUM_TITLE_LIFT * (((trackDocs.get(token) ?? 0) + 0.5) / tracks);
  const descriptors = new Set<string>();
  for (const [token, artists] of artistNames) {
    if (artists.size >= DESCRIPTOR_MIN_ARTIST_NAMES && (titleArtists.get(token)?.size ?? 0) >= DESCRIPTOR_MIN_TITLE_ARTISTS && describesAlbums(token)
      && token.length >= 3 && !/\d/u.test(token) && !NOT_GIVEN_NAMES.has(token) && !givenNames.has(token) && !personNameTokens.has(token)
      && !placeTokens.has(token) && !TRIVIAL_PLACE_TOKENS.has(token)) descriptors.add(token);
  }
  for (const token of VOLUME_TOKENS) descriptors.add(token);
  return descriptors;
}

/**
 * Palabras de título cuyas pistas son casi siempre cortas, en varios discos:
 * «Entrevista a …» dura medio minuto en cualquier recopilatorio que la tenga.
 */
function learnBriefPieceTokens(snapshot: CatalogSnapshot): Set<string> {
  const tokens = new Set(SEED_BRIEF_PIECE_TOKENS);
  const timed = snapshot.tracks.filter((track) => track.durationSeconds !== null && track.durationSeconds > 0);
  if (timed.length < 30) return tokens;
  const catalogMedian = median(timed.map((track) => track.durationSeconds!).sort((a, b) => a - b));
  const byToken = new Map<string, { durations: number[]; albums: Set<number> }>();
  for (const track of timed) {
    for (const token of new Set(keyTokens(track.title))) {
      if (token.length < 4 || /\d/u.test(token)) continue;
      const entry = byToken.get(token) ?? { durations: [], albums: new Set<number>() };
      entry.durations.push(track.durationSeconds!);
      entry.albums.add(track.albumId);
      byToken.set(token, entry);
    }
  }
  for (const [token, entry] of byToken) {
    if (entry.durations.length < BRIEF_PIECE_MIN_TRACKS || entry.albums.size < BRIEF_PIECE_MIN_ALBUMS) continue;
    if (median(entry.durations.sort((a, b) => a - b)) <= catalogMedian * BRIEF_PIECE_MEDIAN_RATIO) tokens.add(token);
  }
  return tokens;
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

/** Duraciones mínimas para que la comparación signifique algo. */
const DURATION_MIN_TRACKS = 30;

/**
 * Mediana y desviación robusta del logaritmo de las duraciones conocidas: la
 * referencia contra la que `duracion_atipica` decide si una pista se sale de
 * lo habitual en este catálogo.
 */
function learnDurations(snapshot: CatalogSnapshot): { median: number; mad: number } | null {
  const logs: number[] = [];
  for (const track of snapshot.tracks) if (track.durationSeconds !== null && track.durationSeconds > 0) logs.push(Math.log(track.durationSeconds));
  if (logs.length < DURATION_MIN_TRACKS) return null;
  // Mediana baja (el elemento central, sin promediar el par central) y su
  // desviación absoluta mediana, igual que se calculaba dentro del detector:
  // mover el cálculo no cambia ni un hallazgo.
  logs.sort((a, b) => a - b);
  const middle = Math.floor(logs.length / 2);
  const med = logs[middle]!;
  const mad = logs.map((value) => Math.abs(value - med)).sort((a, b) => a - b)[middle]!;
  return { median: med, mad: mad || 0.1 };
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

  const roleTokens = learnRoleTokens(snapshot);
  const organizationMarkers = learnOrganizationMarkers(snapshot);
  const givenNames = learnGivenNames(snapshot, organizationMarkers, roleTokens);
  const { tokens: personNameTokens, surnames } = learnPersonNameTokens(snapshot, givenNames, organizationMarkers, roleTokens);
  const descriptorTokens = learnDescriptorTokens(snapshot, givenNames, personNameTokens, placeTokens);
  return {
    places,
    placeTokens,
    roleTokens,
    organizationMarkers,
    albumTypeWords: learnAlbumTypeWords(snapshot.albums, descriptorTokens),
    givenNames,
    personNameTokens,
    surnames,
    descriptorTokens,
    briefPieceTokens: learnBriefPieceTokens(snapshot),
    durations: learnDurations(snapshot),
    vocabulary,
    artistsByKey: group(snapshot.artists, (artist) => nameKey(artist.name)),
    personsByKey: new Map([...group(snapshot.persons, (person) => nameKey(person.name))].map(([key, list]) => [key, list.map((person) => person.id)])),
    organizationsByKey: new Map([...group(snapshot.organizations, (org) => nameKey(org.name))].map(([key, list]) => [key, list.map((org) => org.id)])),
    profiles,
  };
}

/**
 * ¿Tiene forma de nombre de persona? Hasta cuatro palabras que empiezan por un
 * nombre de pila que el catálogo conoce («Dan Warner», «Angel Rada», «Eduardo»),
 * o de dos a cuatro que terminan en un apellido conocido («Pachi Jiménez»).
 */
export function isPersonShaped(lexicon: Lexicon, value: string): boolean {
  const tokens = keyTokens(value);
  if (!tokens.length || tokens.length > 4 || looksLikeOrganization(value)) return false;
  return lexicon.givenNames.has(tokens[0]!) || (tokens.length >= 2 && lexicon.surnames.has(tokens.at(-1)!) && !NOT_GIVEN_NAMES.has(tokens[0]!));
}

/** ¿El texto nombra un lugar que el catálogo conoce como origen? */
export function isKnownPlace(lexicon: Lexicon, text: string): boolean {
  const key = nameKey(text);
  if (!key) return false;
  if (lexicon.places.has(key)) return true;
  const tokens = key.split(" ").filter((token) => !TRIVIAL_PLACE_TOKENS.has(token));
  return tokens.length > 0 && tokens.length <= 3 && tokens.every((token) => lexicon.placeTokens.has(token));
}
