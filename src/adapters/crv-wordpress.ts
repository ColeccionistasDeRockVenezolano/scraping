import { load, type CheerioAPI } from "cheerio";
import type { RawRecord, StoredPage } from "./contracts.js";
import { ADAPTER_VERSION, clean, contentImages } from "./shared.js";

// El blog del propio proyecto es la ÚNICA fuente con las artes internas de un
// disco: contraportada, galleta del CD, libreto y digipack. Ninguna de las
// otras diez publica nada más que la portada.
//
// La semántica no está en el título del post —que casi siempre es solo el
// nombre de la banda— sino en el ATRIBUTO `alt` de cada imagen, con una
// convención fija:
//
//     <banda> <álbum> <tipo>            Billy Se Fue Todo No Es Suficiente Cd
//     <año> <banda> <álbum>             1995 Dermis Tatu La Violó La Mató…
//
// El post da la banda, así que quitando ese prefijo y la palabra de tipo del
// final, lo que queda en medio es el título del disco. Es el mismo caso que
// el directorio de Sincopa: un canal que no es prosa y que dice qué
// representa cada imagen.
//
// DÓNDE ATERRIZA CADA COSA:
//   · `Portada`  → `albums.cover_url`, la columna del core. Es LA imagen
//     canónica del disco y ya existía.
//   · el resto   → `media.media_links` como `scan` (migración 0008). Un disco
//     trae hasta siete artes y `cover_url` es una sola columna: escribirlas
//     ahí obligaría a elegir una y tirar seis.

/**
 * Vocabulario de tipo dentro del `alt`. Aparece al final —"… Todo No Es
 * Suficiente Cd"— pero también al principio —"Contraportada Parte Interna
 * Misión Fantasma La Puta Eléctrica"—, así que se recorta por los dos lados.
 * Se incluyen las variantes mal escritas que están en el archivo real
 * ("Contraporta"), porque el dato es el que hay.
 */
const ART_TYPES: ReadonlyArray<readonly [RegExp, "cover" | "scan"]> = [
  [/^contraporta(?:da)?(?:\s+parte)?(?:\s+interna)?$/u, "scan"],
  [/^(?:parte\s+)?interna(?:\s+digipack)?$/u, "scan"],
  [/^portada(?:\s+interna)?$/u, "cover"],
  // "disco" y "label" NO están aquí: no aparecen en el archivo medido y son
  // ambiguas — "Disco Fixture" o "Disco Duro" empiezan un título, no lo
  // clasifican. Sólo entra la jerga que la fuente usa de verdad.
  [/^(?:cd|dvd|galleta|vinilo|cassette|casete|k7)$/u, "scan"],
  [/^lado\s+[ab]$/u, "scan"],
  [/^(?:libreto|inserto|encarte|booklet|digipack|sticker|poster|afiche|caja|lomo|sobre|solapa)$/u, "scan"],
];

/** Índice de repetición: "Parte Interna 3" es la tercera página del libreto. */
const ORDINAL = /^\d{1,2}$/u;

/**
 * Frases de tipo completas, para reconocerlas cuando el `alt` viene CORTADO,
 * que en este archivo pasa ("Contraportada Pa", "Parte Interna Digip"). Se
 * comparan sin espacios: el blog también las escribe pegadas
 * ("ContraportadaParte").
 */
const TYPE_PHRASES: ReadonlyArray<readonly [string, "cover" | "scan"]> = [
  ["contraportadaparteinterna", "scan"], ["contraportada", "scan"], ["contraporta", "scan"],
  ["parteinternadigipack", "scan"], ["parteinterna", "scan"], ["interna", "scan"],
  ["portadainterna", "cover"], ["portada", "cover"],
];
/** Un prefijo corto coincidiría con demasiado; ocho caracteres ya identifican la palabra. */
const MIN_TRUNCATED = 8;

function typeOfSlice(slice: readonly string[]): "cover" | "scan" | undefined {
  const phrase = slice.join(" ");
  const exact = ART_TYPES.find(([pattern]) => pattern.test(phrase));
  if (exact) return exact[1];
  const compact = phrase.replace(/\s+/gu, "");
  if (compact.length < MIN_TRUNCATED) return undefined;
  return TYPE_PHRASES.find(([full]) => full.startsWith(compact))?.[1];
}

/**
 * Un `alt` que es el nombre de archivo que Facebook le puso a la imagen
 * ("417659_293684330760172_532462359_n") no dice nada de ningún disco.
 */
const NOT_A_TITLE = /\d{5,}/u;

function key(value: string): string {
  return clean(value).normalize("NFD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/gu, " ").trim();
}

export interface AltFacts {
  /**
   * Título del disco tal como lo escribió la fuente. Ausente cuando el `alt`
   * no lo nombra: ahí el arte se cuelga de la BANDA en vez de inventarle una
   * publicación al catálogo.
   */
  album?: string;
  mediaType: "cover" | "scan";
  /** Página dentro de una serie ("Parte Interna 2"). */
  ordinal?: number;
  year?: string;
}

/** ¿Lo que queda tras recortar banda y tipo puede ser el título de un disco? */
function isPlausibleTitle(value: string): boolean {
  if (!value || value.length > 60) return false;
  if (NOT_A_TITLE.test(value)) return false;
  // Sin una vocal no es un título en español ni en inglés: es un hash.
  return /[aeiou\u00e1\u00e9\u00ed\u00f3\u00fa\u00fc]/iu.test(value);
}

/**
 * "Billy Se Fue" + "Billy Se Fue Todo No Es Suficiente Cd"
 *   -> { album: "Todo No Es Suficiente", mediaType: "scan" }
 *
 * El emparejado se hace sobre la forma sin tildes y en minúsculas, pero el
 * título se recorta del `alt` ORIGINAL: normalizarlo perdería los acentos que
 * el propio archivo escribió bien.
 */
export function parseArtAlt(rawAlt: string, band: string): AltFacts | undefined {
  const original = clean(rawAlt).split(/\s+/u).filter(Boolean);
  if (original.length === 0) return undefined;
  const words = original.map((word) => key(word).trim());
  const facts: AltFacts = { mediaType: "scan" };
  let first = 0;
  let last = words.length;

  const leading = words[0] ?? "";
  if (/^(?:19|20)\d{2}$/u.test(leading)) { facts.year = leading; first = 1; }

  const bandWords = key(band).split(" ").filter(Boolean);
  const matchesAt = (at: number): boolean =>
    bandWords.length > 0 && bandWords.every((word, index) => words[at + index] === word);

  // Recorte iterativo por ambos extremos: la convención del blog no fija el
  // orden, y "Contraportada … Sentimiento Muerto" trae el tipo delante y la
  // banda detrás.
  let matched: "cover" | "scan" | undefined;
  for (let pass = 0; pass < 6; pass += 1) {
    const before = [first, last];
    if (matchesAt(first) && first + bandWords.length <= last) first += bandWords.length;
    if (last - bandWords.length >= first && matchesAt(last - bandWords.length)) last -= bandWords.length;
    // El índice va detrás ("Parte Interna 3") pero también delante ("2 El
    // Amor Ya No Existe"), y ahí un dígito suelto es la página, no el título.
    if (last - 1 >= first && ORDINAL.test(words[last - 1] ?? "")) {
      facts.ordinal = Number(words[last - 1]);
      last -= 1;
    }
    if (first < last - 1 && ORDINAL.test(words[first] ?? "")) {
      facts.ordinal = facts.ordinal ?? Number(words[first]);
      first += 1;
    }
    for (const fromEnd of [true, false]) {
      for (let size = 3; size >= 1; size -= 1) {
        if (last - size < first) continue;
        const slice = fromEnd ? words.slice(last - size, last) : words.slice(first, first + size);
        const kind = typeOfSlice(slice);
        if (!kind) continue;
        matched = matched ?? kind;
        if (fromEnd) last -= size; else first += size;
        break;
      }
    }
    if (before[0] === first && before[1] === last) break;
  }

  // Sin palabra de tipo, el `alt` es solo "<banda> <álbum>": la imagen es la
  // portada, que es lo que encabeza una ficha.
  facts.mediaType = matched ?? "cover";
  const album = clean(original.slice(first, last).join(" ")).replace(/^[-\u2013\u2014\s]+|[-\u2013\u2014\s]+$/gu, "");
  if (isPlausibleTitle(album)) facts.album = album;
  return facts;
}

export class CrvWordpressArtsExtractor {
  constructor(private readonly slug: string) {}

  private record(entityKind: RawRecord["entityKind"], identity: string, fields: RawRecord["fields"]): RawRecord {
    return { entityKind, identity: identity.slice(0, 250), extractor: this.slug, extractorVersion: ADAPTER_VERSION, fields };
  }

  /** Nombre de la banda: el título del post, hasta las comillas si las hay. */
  private band(page: CheerioAPI): string {
    const title = clean(page(".entry-title").first().text()) || clean(page("h1").first().text());
    return clean(title.split(/[«"“]/u)[0] ?? "");
  }

  extract(page: StoredPage): RawRecord[] {
    const document = load(page.body);
    const band = this.band(document);
    if (!band) return [];
    const url = page.url;
    const evidence = (selector: string, text: string, position?: number) => ({
      url, selector, excerpt: text.slice(0, 2_000), ...(position === undefined ? {} : { position }),
    });

    const records: RawRecord[] = [this.record("artist", band, [
      { field: "name", value: band, evidence: evidence("h1.entry-title", band) },
      { field: "source_url", value: url, evidence: evidence("link", url) },
    ])];

    // Se acota al cuerpo de la entrada: la barra lateral y el pie repiten
    // imágenes de plantilla que no son artes de ningún disco.
    const scope = document(".entry-content").first();
    if (scope.length === 0) return records;
    const images = contentImages(load(`<div>${scope.html() ?? ""}</div>`), url);

    const albums = new Map<string, { cover?: string; year?: string; alt: string; position: number }>();
    const links: RawRecord[] = [];
    for (const image of images) {
      const facts = parseArtAlt(image.alt, band);
      if (!facts) continue;
      const where = evidence("img[alt]", image.alt || image.url, image.position);
      // Sin título de disco el arte es de la BANDA, no de una publicación
      // concreta: se cuelga del artista en vez de inventarle un álbum.
      const target = facts.album ? "album" : "artist";
      if (facts.album) {
        const entry = albums.get(facts.album) ?? { alt: image.alt, position: image.position };
        if (facts.mediaType === "cover" && entry.cover === undefined) entry.cover = image.url;
        // "1995 Dermis Tatu La Violó…": el año que encabeza el `alt` es el de
        // edición del disco, y es el único que esta fuente declara.
        if (facts.year && entry.year === undefined) entry.year = facts.year;
        albums.set(facts.album, entry);
        // La portada ya viaja en `albums.cover_url`; duplicarla en
        // media_links sería la misma afirmación dos veces.
        if (facts.mediaType === "cover") continue;
      }
      links.push(this.record("media_link", `${band}::${facts.album ?? ""}::${image.url}`, [
        { field: "media_url", value: image.url, evidence: where },
        { field: "media_type", value: target === "artist" && facts.mediaType === "cover" ? "artist_photo" : facts.mediaType, evidence: where },
        { field: "media_target", value: target, evidence: where },
        { field: "artist_name", value: band, evidence: where },
        ...(facts.album ? [{ field: "album_title", value: facts.album, evidence: where }] : []),
        ...(image.alt ? [{ field: "media_caption", value: image.alt, evidence: where }] : []),
        ...(facts.ordinal === undefined ? [] : [{ field: "media_position", value: String(facts.ordinal), evidence: where }]),
      ]));
    }

    for (const [title, entry] of albums) {
      const where = evidence("img[alt]", entry.alt, entry.position);
      records.push(this.record("album", `${band}::${title}`, [
        { field: "title", value: title, evidence: where },
        { field: "artist_name", value: band, evidence: where },
        ...(entry.year ? [{ field: "release_year", value: entry.year, evidence: where }] : []),
        ...(entry.cover ? [{ field: "cover_url", value: entry.cover, evidence: where }] : []),
        { field: "source_url", value: url, evidence: evidence("link", url) },
      ]));
    }
    return [...records, ...links];
  }
}
