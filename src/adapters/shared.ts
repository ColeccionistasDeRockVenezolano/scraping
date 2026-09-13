// Utilidades conservadoras compartidas. Estas funciones no infieren datos a
// partir de títulos o prosa: sólo consumen etiquetas, tablas o listas que la
// página presenta expresamente como metadatos/créditos.
import { load, type CheerioAPI } from "cheerio";
import type { RawRecord, Evidence } from "./contracts.js";

export const ADAPTER_VERSION = "1.0.0";

/**
 * Entidad marcador para los recopilatorios, aprobada como decisión de modelo
 * (C3, 2026-09-08). `albums.artist_id` es NOT NULL y un recopilatorio no
 * tiene un artista único, así que necesita ALGO en esa columna.
 *
 * Qué NO significa: no afirma que las bandas del disco sean "Various
 * Artists". Quién toca cada pista se afirma donde el modelo lo pide, en
 * `track_credits.artist_id`, una fila por pista y con su evidencia. El
 * marcador solo ocupa la columna que la tabla exige.
 */
export const VARIOUS_ARTISTS = "Various Artists";

export function absoluteUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value.replace(/^\/+/, "")}`;
}

export function clean(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function excerpt(value: string): string {
  return clean(value).slice(0, 2_000);
}

/**
 * Divide el HTML de un bloque por <br> y devuelve el texto de cada tramo.
 * Sin esto, un post cuyas líneas están separadas solo por <br> se lee como
 * una única cadena y la primera etiqueta se traga el resto del post entero.
 */
function linesOf($: CheerioAPI, html: string): string[] {
  return html
    .split(/<br\s*\/?>/i)
    .map((chunk) => clean($(`<div>${chunk}</div>`).text()))
    .filter(Boolean);
}

function evidence(url: string, selector: string, text: string, position?: number): Evidence {
  return { url, selector, excerpt: excerpt(text), ...(position === undefined ? {} : { position }) };
}

type Found = { value: string; selector: string; text: string; position: number };

const labels: Array<[RegExp, string]> = [
  [/^(?:artista|artist|banda|band|grupo)\s*:/i, "artist_name"],
  [/^(?:tipo de artista|artist type)\s*:/i, "artist_type"],
  [/^(?:biograf[ií]a|biography)\s*:/i, "biography"],
  [/^(?:origen|origin|lugar|procedencia)\s*:/i, "origin"],
  [/^(?:ciudad de origen|origin city)\s*:/i, "origin_city"],
  [/^(?:pa[ií]s de origen|origin country)\s*:/i, "origin_country"],
  [/^(?:formad[oa]|formed)\s*:/i, "formed_date"],
  [/^(?:disuelt[oa]|separad[oa]|disbanded)\s*:/i, "disbanded_date"],
  [/^(?:g[eé]nero(?:s)?|genre(?:s)?)\s*:/i, "genres"],
  [/^(?:alias|nombre(?:s)? anterior(?:es)?)\s*:/i, "aliases"],
  [/^(?:[áa]lbum|album|disco|release)\s*:/i, "album_title"],
  [/^(?:tipo de [áa]lbum|album type|formato)\s*:/i, "album_type"],
  [/^(?:a[nñ]o|lanzamiento|publicaci[oó]n|fecha de lanzamiento|release (?:year|date))\s*:/i, "release_date"],
  [/^(?:sello|label)\s*:/i, "label"],
  [/^(?:cat[áa]logo|catalog(?:ue)?(?: no\.?)?)\s*:/i, "catalog_number"],
  [/^(?:estudio(?: de grabaci[oó]n)?|recording studio)\s*:/i, "recording_studio"],
  [/^(?:localizaci[oó]n|location)\s*:/i, "location"],
  [/^(?:compa[nñ][ií]a de producci[oó]n|production company)\s*:/i, "production_company"],
  [/^(?:web|sitio(?: web)?|enlaces?|links?)\s*:/i, "web"],
];

function labelledValues($: CheerioAPI): Map<string, Found[]> {
  const result = new Map<string, Found[]>();
  let position = 0;
  const add = (field: string, value: string, selector: string, text: string) => {
    const cleanValue = clean(value);
    if (!cleanValue) return;
    const values = result.get(field) ?? [];
    if (!values.some((entry) => entry.value === cleanValue)) values.push({ value: cleanValue, selector, text, position });
    result.set(field, values);
    position += 1;
  };
  $("p, li, td, div").each((_, node) => {
    // Solo el bloque hoja: un contenedor padre repite el texto de todos sus
    // hijos, y su primera etiqueta se llevaría el post completo como valor.
    if ($(node).find("p, li, td, div").length > 0) return;
    for (const line of linesOf($, $(node).html() ?? "")) {
      if (line.length > 1_500) continue;
      for (const [pattern, field] of labels) {
        const match = pattern.exec(line);
        if (!match) continue;
        // "web" se resuelve aparte, por href: el texto visible del enlace
        // ("Facebook") es la etiqueta, no la dirección.
        if (field !== "web") add(field, line.slice(match[0].length), node.tagName.toLowerCase(), line);
        break;
      }
    }
  });
  // "Web:" apunta a Bandcamp/Facebook: lo que vale es el href, no el texto
  // del enlace ("Facebook"), que es solo la etiqueta visible.
  $("p, li, td, div").each((_, node) => {
    const el = $(node);
    if (el.find("p, li, td, div").length > 0) return;
    // Se busca tramo a tramo: la línea "Web:" suele compartir bloque con
    // "Banda:" y "Álbum:", separadas solo por <br>.
    for (const chunk of (el.html() ?? "").split(/<br\s*\/?>/i)) {
      const fragment = $(`<div>${chunk}</div>`);
      const text = clean(fragment.text());
      if (!/^(?:web|sitio(?: web)?|enlaces?|links?)\s*:/i.test(text)) continue;
      const href = fragment.find("a[href]").first().attr("href");
      if (href) add("web", href, node.tagName.toLowerCase(), text);
    }
  });

  // Sincopa y algunas páginas WordPress usan tablas de dos columnas. Una
  // celda de etiqueta y una celda de valor es evidencia estructurada, no una
  // inferencia desde el texto corrido.
  $("tr").each((_, row) => {
    const cells = $(row).find("th,td").map((__, cell) => clean($(cell).text())).get().filter(Boolean);
    const label = cells[0]; const value = cells[1];
    if (!label || !value) return;
    const field = labels.find(([pattern]) => pattern.test(`${label}:`))?.[1];
    if (field) add(field, value, "tr", cells.join(" | "));
  });
  return result;
}

function fieldsFor(url: string, entries: Array<[string, Found]>): RawRecord["fields"] {
  return entries.map(([field, item]) => ({ field, value: item.value, evidence: evidence(url, item.selector, item.text, item.position) }));
}

function splitExplicitList(value: string): string[] {
  return value.split(/(?:\s*[;,]\s*|\s*\/\s*)/).map(clean).filter(Boolean);
}

/** Todas las líneas visuales del documento, en orden de lectura. */
function documentLines($: CheerioAPI): Array<{ text: string; tag: string }> {
  const out: Array<{ text: string; tag: string }> = [];
  $("p, li, td, div, h1, h2, h3, h4").each((_, node) => {
    const el = $(node);
    if (el.find("p, li, td, div, h1, h2, h3, h4").length > 0) return;
    for (const text of linesOf($, el.html() ?? "")) out.push({ text, tag: node.tagName.toLowerCase() });
  });
  return out;
}

const TRACKLIST_MARKER = /^(?:tracklist|lista de temas|temas|canciones|track ?list)\s*:?\s*$/i;
const NUMBERED = /^(\d{1,3})\s*[.\-–)]\s*(.+)$/u;

/**
 * Muchos blogs no usan <ol>: escriben "Tracklist:" y debajo una línea por
 * pista. Es una lista explícita igual que la otra, solo que sin marcado, y
 * exigir <ol> dejaba fuera el tracklist entero.
 */
function extractNumberedTracks($: CheerioAPI, url: string, artist: string | undefined, album: string | undefined, extractor: string): RawRecord[] {
  if (!album) return [];
  const lines = documentLines($);
  const start = lines.findIndex((line) => TRACKLIST_MARKER.test(line.text));
  if (start < 0) return [];
  const records: RawRecord[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    const match = NUMBERED.exec(line.text);
    if (!match) { if (records.length > 0) break; continue; }
    const title = clean(match[2] ?? "");
    if (!title) continue;
    const number = match[1]!;
    const where = evidence(url, line.tag, line.text, records.length);
    records.push({
      entityKind: "track",
      // La posición forma parte de la identidad de una pista dentro de un
      // disco. Un álbum puede repetir legítimamente el mismo título (p. ej.
      // pistas 02/06); usar solo el nombre fusionaba ambas y fabricaba una
      // contradicción 2 vs 6.
      identity: `${artist ?? "unknown artist"}::${album}::${number}`.slice(0, 250),
      extractor, extractorVersion: ADAPTER_VERSION,
      fields: [
        { field: "title", value: title, evidence: where },
        { field: "track_number", value: number, evidence: where },
        { field: "album_title", value: album, evidence: where },
        ...(artist ? [{ field: "artist_name", value: artist, evidence: where }] : []),
      ],
    });
  }
  return records;
}

function extractTracks($: CheerioAPI, url: string, artist: string | undefined, album: string | undefined, extractor: string): RawRecord[] {
  if (!album) return [];
  const records: RawRecord[] = [];
  $("h1,h2,h3,h4,strong,b").each((_, heading) => {
    if (!/^(?:tracklist|lista de temas|temas|canciones)$/i.test(clean($(heading).text()))) return;
    const list = $(heading).nextAll("ol,ul").first();
    list.find("li").each((index, item) => {
      const text = clean($(item).text());
      const match = /^(?:(\d{1,3})\s*[.\-:)]\s*)?(.+)$/.exec(text);
      const title = clean(match?.[2] ?? "");
      if (!title) return;
      const number = match?.[1] ?? String(index + 1);
      records.push({
        entityKind: "track",
        identity: `${artist ?? "unknown artist"}::${album}::${number}`.slice(0, 250),
        extractor, extractorVersion: ADAPTER_VERSION,
        fields: [
          { field: "title", value: title, evidence: evidence(url, "li", text, index) },
          { field: "track_number", value: number, evidence: evidence(url, "li", text, index) },
          { field: "album_title", value: album, evidence: evidence(url, "li", text, index) },
          ...(artist ? [{ field: "artist_name", value: artist, evidence: evidence(url, "li", text, index) }] : []),
        ],
      });
    });
  });
  return records;
}

const creditRoles: Array<[RegExp, string]> = [
  [/^m[uú]sicos?$/i, "musician"], [/^instruments?$/i, "instrument"], [/^invitados?|^guests?$/i, "guest"],
  [/^(?:autor(?:es)?|writer(?:s)?)$/i, "writer"], [/^compositor(?:es)?|composer(?:s)?$/i, "composer"],
  [/^producci[oó]n|^producer(?:s)?$/i, "producer"], [/^ingenier[oi] de grabaci[oó]n|^recording engineers?$/i, "recording_engineer"],
  [/^mezcla|^mixing engineers?$/i, "mixing_engineer"], [/^master(?:ing)?$/i, "mastering_engineer"],
  [/^(?:arte|dise[nñ]o|artwork)$/i, "artwork"], [/^fotograf[ií]a|^photography$/i, "photography"],
];

function roleFor(label: string): string | undefined {
  return creditRoles.find(([pattern]) => pattern.test(clean(label)))?.[1];
}

/** Only explicit credit lines become credit candidates; free prose never does. */
function extractCredits($: CheerioAPI, url: string, artist: string | undefined, album: string | undefined, extractor: string): RawRecord[] {
  const records: RawRecord[] = [];
  let position = 0;
  $("[data-credit-scope], p, li, td").each((_, node) => {
    const text = clean($(node).text());
    const attrScope = clean($(node).attr("data-credit-scope") ?? "").toLowerCase();
    const attrTrack = clean($(node).attr("data-track") ?? "");
    const match = /^([^:]{2,80})\s*:\s*(.+)$/.exec(text);
    const role = clean($(node).attr("data-credit-role") ?? "") || (match ? roleFor(match[1] ?? "") : undefined);
    if (!role) return;
    const names = splitExplicitList(clean($(node).attr("data-credit-name") ?? match?.[2] ?? ""));
    if (!names.length) return;
    const scope = attrScope === "track" || attrTrack ? "track" : "album";
    for (const name of names) {
      const entityKind = scope === "track" ? "track_credit" : "album_credit";
      const parent = scope === "track" ? attrTrack : album;
      if (!parent) continue; // No adivinamos a qué obra aplica un crédito.
      records.push({
        entityKind,
        identity: `${artist ?? "unknown artist"}::${parent}::${role}::${name}`.slice(0, 250),
        extractor, extractorVersion: ADAPTER_VERSION,
        fields: [
          { field: "credited_name", value: name, evidence: evidence(url, node.tagName.toLowerCase(), text, position) },
          { field: "credit_role", value: role, evidence: evidence(url, node.tagName.toLowerCase(), text, position) },
          { field: "credit_scope", value: scope, evidence: evidence(url, node.tagName.toLowerCase(), text, position) },
          ...(scope === "track" ? [{ field: "track_title", value: parent, evidence: evidence(url, node.tagName.toLowerCase(), text, position) }] : [{ field: "album_title", value: parent, evidence: evidence(url, node.tagName.toLowerCase(), text, position) }]),
          ...(artist ? [{ field: "artist_name", value: artist, evidence: evidence(url, node.tagName.toLowerCase(), text, position) }] : []),
        ],
      });
    }
    position += 1;
  });
  return records;
}

// Países que aparecen en estas fuentes. Sirve para decidir si "Lugar: Zulia"
// es ciudad o país; lo que no está en la lista se trata como ciudad, que es
// lo que el core asume por defecto (origin_country = 'Venezuela').
const COUNTRY = /^(?:venezuela|colombia|chile|per[uú]|ecuador|argentina|brasil|m[eé]xico|espa[nñ]a|estados unidos|ee\.?uu\.?|usa|panam[aá]|costa rica|uruguay|bolivia|paraguay|rep[uú]blica dominicana|canad[aá]|italia|alemania|francia|portugal|inglaterra|reino unido)$/iu;
// "Yaracuy - Actualmente Peru (Lima)", "Zulia/Ahora Colombia"
const RELOCATED = /^(.*?)\s*[/\-–,]?\s*(?:ahora|actualmente(?:\s+en)?|radicad[oa]s?\s+en|now)\s+(.+)$/iu;

export interface OriginFacts { city?: string; country?: string; current?: string; }

/**
 * "Lugar" es de dónde ES la banda. Cuando la fuente añade dónde está AHORA,
 * eso no es su origen y no puede escribirse en `origin_country`: se conserva
 * aparte como contexto. Sin marcador explícito no se interpreta el resto.
 */
export function parseOrigin(raw: string): OriginFacts {
  const value = clean(raw);
  if (!value) return {};
  const facts: OriginFacts = {};
  let origin = value;
  const moved = RELOCATED.exec(value);
  if (moved) { origin = clean(moved[1] ?? ""); facts.current = clean(moved[2] ?? ""); }
  else if (value.includes("/")) {
    const parts = value.split("/").map(clean).filter(Boolean);
    // Sin marcador no se afirma que el segundo sea "actual": solo que el
    // primero es el origen y lo demás queda como contexto sin interpretar.
    origin = parts[0] ?? value;
    if (parts.length > 1) facts.current = parts.slice(1).join(" / ");
  }
  // "Caracas, Venezuela" y "Caracas - Venezuela" son la misma forma. Solo se
  // separa cuando la última pieza es un país: "Valencia - Carabobo" es
  // ciudad y estado, y partirlo obligaría a decidir cuál es cuál.
  const pieces = origin.split(/\s*[,]\s*|\s+[-–]\s+/u).map(clean).filter(Boolean);
  const last = pieces[pieces.length - 1];
  if (pieces.length >= 2 && last && COUNTRY.test(last)) {
    facts.city = pieces.slice(0, -1).join(", ");
    facts.country = last;
  } else if (pieces.length >= 2) facts.city = origin;
  else if (origin && COUNTRY.test(origin)) facts.country = origin;
  else if (origin) facts.city = origin;
  return facts;
}

/**
 * Imágenes de CONTENIDO de una página. No decide qué representa cada una —eso
 * depende de la fuente: Sincopa lo dice en la ruta, un blog en el orden— sólo
 * separa la imagen de la decoración.
 *
 * El filtro es por descarte explícito, no por lista blanca: cualquier cosa que
 * no sea un icono social, un adorno de plantilla o una miniatura de interfaz
 * cuenta como contenido, porque perderse una portada es peor que arrastrar un
 * banner que la revisión humana descartará.
 */
export interface ContentImage {
  /** Absoluta contra la página que la contiene. */
  url: string;
  alt: string;
  width: number | null;
  position: number;
}

/**
 * Servidores que sólo sirven adorno: iconos sociales, plantilla de Blogger y
 * Gravatar, que por definición devuelve el avatar de quien comenta — 488 de
 * las 1.730 imágenes de CRV WordPress son eso.
 */
const JUNK_HOST = /photobucket|myspace|facebook|twitter|instagram|pinterest|whatsapp|telegram|blogblog\.com|blogger\.com\/img|gravatar\.com/i;

/**
 * Palabras que delatan un adorno. Se comparan contra el NOMBRE DE ARCHIVO
 * troceado y contra segmentos de directorio COMPLETOS — nunca troceando la
 * ruta entera. La distinción no es cosmética: el id de contenido de Blogger
 * es opaco (`/img/b/R29vZ2xl/AVvXsEigIrEURf3B8imIQtyilC3QBrCjuHSkBzJ…`) y
 * partirlo por `-`/`_` produce trozos como "avatars", "logo2" o "s0" por pura
 * coincidencia de letras, que descartaban portadas buenas.
 */
const JUNK_WORD = /^(?:icons?|buttons?|banners?|avatars?|profile|pixel|spacer|blank|1x1|logos?\d*|emoticons?|smiley|thumb|thumbnail)$/i;

/** Por debajo de esto es un icono de plantilla, no una portada ni una foto. */
const MIN_IMAGE_WIDTH = 100;

/**
 * Blogger sirve el ancho en un segmento propio: `/s72-c/`, `/s320/`. `s0` es
 * su marca de TAMAÑO ORIGINAL, no de cero píxeles: filtrarla tiraba portadas
 * a máxima resolución, que es justo lo contrario de lo que se busca.
 */
const BLOGGER_SIZE = /^s(\d{1,4})(?:-[a-z]+)?$/i;

function isDecoration(absolute: string): boolean {
  if (JUNK_HOST.test(absolute)) return true;
  let pathname: string;
  try { pathname = new URL(absolute).pathname; } catch { return false; }
  const segments = pathname.split("/").filter(Boolean);
  const filename = segments.pop() ?? "";
  // Directorios: se comparan enteros, así `/icons/` cae y el id opaco no.
  let servedWidth: number | null = null;
  for (const segment of segments) {
    if (JUNK_WORD.test(segment)) return true;
    const size = BLOGGER_SIZE.exec(segment);
    if (size) servedWidth = Number(size[1]);
  }
  // Cuando el servidor declara a qué tamaño sirve la imagen, eso decide: pesa
  // más que adivinar por el nombre del archivo, que en un blog es el que
  // tuviera quien la subió. "avatars-000188282602-…-t500x500.jpg" servido en
  // /s400/ es una carátula de SoundCloud rebotada, no un avatar.
  if (servedWidth !== null) return servedWidth > 0 && servedWidth < MIN_IMAGE_WIDTH;
  // Sin esa declaración vale el nombre, y sólo si tiene extensión: el id de
  // contenido de Blogger no tiene punto, y trocearlo era el error que
  // inventaba "avatars" y "logo" dentro de una cadena opaca.
  if (!filename.includes(".")) return false;
  return filename.split(/[._-]/).some((token) => token !== "" && JUNK_WORD.test(token));
}

export function contentImages($: CheerioAPI, baseUrl: string): ContentImage[] {
  const images: ContentImage[] = [];
  const seen = new Set<string>();
  $("img[src]").each((index, node) => {
    const raw = ($(node).attr("src") ?? "").trim();
    if (!raw || raw.startsWith("data:")) return;
    const declared = Number.parseInt($(node).attr("width") ?? "", 10);
    if (Number.isInteger(declared) && declared < MIN_IMAGE_WIDTH) return;
    let absolute: string;
    try { absolute = new URL(raw, baseUrl).toString(); } catch { return; }
    if (isDecoration(absolute)) return;
    if (seen.has(absolute)) return;
    seen.add(absolute);
    images.push({
      url: absolute,
      alt: clean($(node).attr("alt") ?? ""),
      width: Number.isInteger(declared) ? declared : null,
      position: index,
    });
  });
  return images;
}

/**
 * Los tres blogs discográficos mezclan en el mismo cuerpo dos clases de
 * enlace: la presencia pública del artista y el alojamiento donde colgaron el
 * disco. La primera es un dato del artista; la segunda no se extrae —sólo se
 * reconoce para no confundirla con prosa cuando delimita un bloque.
 */
const PRESENCE_HOST = /^(?:myspace\.com|facebook\.com|twitter\.com|x\.com|soundcloud\.com|bandcamp\.com|youtube\.com|instagram\.com|reverbnation\.com|last\.fm)$/i;
export const DOWNLOAD_LINK = /descargar|mediafire|megaupload|rapidshare|4shared|badongo|depositfiles|sendspace|zippyshare|divshare|mega\.(?:nz|co)/i;

export function isPresenceLink(href: string, baseUrl: string): boolean {
  try { return PRESENCE_HOST.test(new URL(href, baseUrl).hostname.replace(/^(?:www|es-es|es-la|m)\./i, "")); }
  catch { return false; }
}

/**
 * Gramática de ficha que comparten los blogs discográficos en español:
 *
 *   Título (Tipo Año)   ·   Título (Año)
 *
 * La usan tres fuentes por canales distintos —Rock De Vzla en una línea
 * rotulada por tamaño de fuente, Rockzuela y RHV en el título de la entrada—
 * y el vocabulario del paréntesis es el mismo en las tres, así que vive aquí
 * y no duplicado en cada adapter.
 */
export interface ReleaseHead {
  title: string;
  year: string;
  /** Valor del enum `album_type` del core; ausente cuando el paréntesis solo trae año. */
  albumType?: string;
  /** Soporte declarado ("Lp", "Cassette"), que no es lo mismo que el tipo. */
  format?: string;
}

/** "Título (…)": exige título delante, o "(En Vivo 1996)" sería un disco. */
const HEAD_LINE = /^(.{1,120}?)\s*\(([^()]{1,60})\)\s*$/u;
const HEAD_YEAR = /\b(?:19|20)\d{2}\b/u;

/**
 * Vocabulario de estos blogs: español y abreviado. No se reutiliza el de la
 * hoja de YouTube, donde escribe un curador en inglés ("Studio Album");
 * unificarlos daría por hecho que ambos quieren decir lo mismo con la misma
 * palabra.
 */
const RELEASE_TYPES: ReadonlyArray<[RegExp, string]> = [
  [/^demos?$/iu, "demo"],
  [/^e\.?p\.?$/iu, "ep"],
  [/^singles?$/iu, "single"],
  [/^(?:compilation|recopilatorio|compilado)$/iu, "compilation"],
  [/^(?:en vivo|live|directo)$/iu, "live_album"],
];
/**
 * Estas nombran el SOPORTE, no la clase de publicación. Un "Lp" dice en qué
 * se editó, no si es un álbum de estudio; mapearlo a `studio_album` afirmaría
 * algo que la fuente no dice, así que se conserva como `format`.
 */
const FORMATS = /^(?:lp|cd|cassette|casete|k7|vinilo|vinyl|maxi(?:\s*single)?)$/iu;

/** "Hambre (Demo 2010)" -> {title:"Hambre", year:"2010", albumType:"demo"} */
export function parseReleaseHead(rawLine: string): ReleaseHead | undefined {
  const match = HEAD_LINE.exec(clean(rawLine));
  if (!match) return undefined;
  const title = clean(match[1] ?? "");
  const inside = clean(match[2] ?? "");
  const year = HEAD_YEAR.exec(inside)?.[0];
  if (!title || !year) return undefined;
  const head: ReleaseHead = { title, year };
  // Lo que queda al quitar el año es la palabra de tipo, si la hay. Un resto
  // que no se reconoce ("Bootleg Maracay", "Pre-Gillman San Francisco") no se
  // fuerza a ningún valor del enum: se deja sin tipo y sigue en la evidencia.
  const rest = clean(inside.replace(HEAD_YEAR, "").replace(/[-–,]/gu, " "));
  if (rest) {
    const kind = RELEASE_TYPES.find(([pattern]) => pattern.test(rest))?.[1];
    if (kind) head.albumType = kind;
    else if (FORMATS.test(rest)) head.format = rest;
  }
  return head;
}

export interface ExplicitCatalogOptions { fallbackArtist?: string; fallbackAlbum?: string; }

export function extractExplicitCatalog($: CheerioAPI, url: string, extractor: string, options: ExplicitCatalogOptions = {}): RawRecord[] {
  const found = labelledValues($);
  const artist = found.get("artist_name")?.[0]?.value ?? options.fallbackArtist;
  const album = found.get("album_title")?.[0]?.value ?? options.fallbackAlbum;
  const records: RawRecord[] = [];
  if (artist) {
    const artistFields: Array<[string, Found]> = [];
    const artistEvidence = found.get("artist_name")?.[0] ?? { value: artist, selector: "h1", text: artist, position: 0 };
    artistFields.push(["name", artistEvidence]);
    for (const key of ["artist_type", "biography", "origin_city", "origin_country", "formed_date", "disbanded_date"] as const) {
      const item = found.get(key)?.[0]; if (item) artistFields.push([key, item]);
    }
    // "Lugar:" se descompone en columnas del core; el traslado posterior se
    // conserva como contexto, nunca como origen.
    const origin = found.get("origin")?.[0];
    if (origin) {
      const parsed = parseOrigin(origin.value);
      if (parsed.city && !found.has("origin_city")) artistFields.push(["origin_city", { ...origin, value: parsed.city }]);
      if (parsed.country && !found.has("origin_country")) artistFields.push(["origin_country", { ...origin, value: parsed.country }]);
      if (parsed.current) artistFields.push(["location", { ...origin, value: parsed.current }]);
    }
    for (const link of found.get("web") ?? []) artistFields.push(["web_url", link]);
    for (const alias of found.get("aliases") ?? []) artistFields.push(["alias", alias]);
    artistFields.push(["source_url", { value: url, selector: "document", text: url, position: 0 }]);
    records.push({ entityKind: "artist", identity: artist.slice(0, 250), extractor, extractorVersion: ADAPTER_VERSION, fields: fieldsFor(url, artistFields) });
  }
  if (album) {
    const titleEvidence = found.get("album_title")?.[0] ?? { value: album, selector: "h1", text: album, position: 0 };
    const albumFields: Array<[string, Found]> = [["title", titleEvidence]];
    if (artist) albumFields.push(["artist_name", found.get("artist_name")?.[0] ?? { value: artist, selector: "h1", text: artist, position: 0 }]);
    for (const key of ["album_type", "release_date", "label", "catalog_number", "recording_studio", "location", "production_company"] as const) {
      const item = found.get(key)?.[0];
      if (item) albumFields.push([key === "release_date" && /^\d{4}$/.test(item.value) ? "release_year" : key, item]);
    }
    // El género es columna de `albums`, no de `artists`: es el único lugar
    // del core donde puede aterrizar. Se conserva tal como lo escribió la
    // fuente ("Heavy/Power Metal Sinfónico"), sin partirlo: la columna es una
    // sola y elegir un trozo sería descartar lo que la fuente afirma.
    const genre = found.get("genres")?.[0];
    if (genre) albumFields.push(["genre", genre]);
    // La primera imagen de contenido de una ficha de disco es su portada: el
    // post es sobre ese disco y la imagen encabeza la entrada. No se afirma
    // nada sobre el resto (contraportadas, fotos de la banda, scans), que
    // necesitan un canal que diga qué son.
    const cover = contentImages($, url)[0];
    if (cover) albumFields.push(["cover_url", { value: cover.url, selector: "img", text: cover.alt || cover.url, position: cover.position }]);
    albumFields.push(["source_url", { value: url, selector: "document", text: url, position: 0 }]);
    records.push({ entityKind: "album", identity: `${artist ?? "unknown artist"}::${album}`.slice(0, 250), extractor, extractorVersion: ADAPTER_VERSION, fields: fieldsFor(url, albumFields) });
  }
  const listed = extractTracks($, url, artist, album, extractor);
  const tracks = listed.length > 0 ? listed : extractNumberedTracks($, url, artist, album, extractor);
  return [...records, ...tracks, ...extractCredits($, url, artist, album, extractor)];
}

export function extractNarrativeHtml(html: string, url: string, extractor: string): RawRecord[] {
  return extractExplicitCatalog(load(html), url, extractor);
}
