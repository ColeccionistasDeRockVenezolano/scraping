import { load } from "cheerio";
import type { RawRecord } from "./contracts.js";
import { BloggerAdapter } from "./blogger.js";
import { ADAPTER_VERSION, clean, excerpt } from "./shared.js";

// "Hippito y sus Chatarritas" es un archivo discográfico de vinilo, no un
// blog de reseñas: 973 de sus 1.063 entradas llevan la ficha completa en el
// TÍTULO de la entrada, con una convención fija:
//
//   Artista - Título (Sello CATÁLOGO / País Año)
//
// y el cuerpo lista las pistas, una por línea, con el compositor entre
// paréntesis en gris. Es la misma situación que Sincopa: la semántica está
// codificada en un canal que no es texto corrido —allá el color de fuente,
// aquí el título y el gris de los créditos—, y leer solo el cuerpo como
// prosa daba cero registros.
//
// Fuera de alcance deliberado: las 350 entradas "VA - ..." (recopilatorios).
// El core exige `albums.artist_id NOT NULL` y un recopilatorio no tiene un
// artista; inventar una entidad "Various Artists" es una decisión de modelo,
// no de parsing, y no se toma dentro de un adapter.

/** Toma el último grupo de paréntesis balanceado de una cadena. */
function lastParenthetical(value: string): { before: string; inside: string } | undefined {
  let depth = 0; let end = -1;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const char = value[index];
    if (char === ")") { if (depth === 0) end = index; depth += 1; }
    else if (char === "(") {
      depth -= 1;
      if (depth === 0 && end !== -1) return { before: value.slice(0, index), inside: value.slice(index + 1, end) };
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

/** "1.984" es 1984 con separador de miles; "40.390" es un catálogo. */
function normalizeThousands(value: string): string {
  return value.replace(/\b(\d)\.(\d{3})\b/gu, "$1$2");
}

interface TitleFacts {
  artist: string;
  album: string;
  year?: string;
  label?: string;
  catalog?: string;
}

const VARIOUS = /^(?:v\.?\s*a\.?|various(?:\s+artists?)?)$/iu;
// Códigos de catálogo: con prefijo de letras ("LPS-99516", "SN 021") o solo
// numéricos ("30.353", "45-642", "172"). Se exige que quede nombre de sello
// delante, para no convertir un sello entero en número de catálogo.
const CATALOG = /\s([A-Z][A-Z0-9]{0,7}[-\s]?\d{2,7}(?:[-.][A-Z0-9]+)?|\d{2,4}(?:[.\-][A-Z0-9]{1,6})*)$/u;

export function parseHippitoTitle(rawTitle: string): TitleFacts | undefined {
  const title = clean(rawTitle);
  if (!title) return undefined;
  const dash = /^(.+?)\s*-\s+(.+)$/u.exec(title);
  if (!dash) return undefined;
  const artist = clean(dash[1] ?? "");
  const rest = clean(dash[2] ?? "");
  if (!artist || !rest || VARIOUS.test(artist)) return undefined;

  // La ficha entre paréntesis es lo que distingue una entrada discográfica de
  // un título cualquiera; sin ella no se asume que el post sea una ficha.
  const block = lastParenthetical(rest);
  if (!block) return undefined;
  const album = clean(block.before);
  if (!album) return undefined;

  const segments = normalizeThousands(block.inside).split("/").map(clean).filter(Boolean);
  if (segments.length === 0) return undefined;
  const facts: TitleFacts = { artist, album };

  // Último segmento: país y año. Solo se conserva el año — el país aquí es el
  // de la EDICIÓN, no el origen del artista, y confundirlos sería inventar.
  const year = /\b(19|20)\d{2}\b/u.exec(segments[segments.length - 1] ?? "")?.[0];
  if (year) facts.year = year;

  // Primer segmento: sello y, si termina en código, número de catálogo.
  if (segments.length >= 2) {
    const first = segments[0] ?? "";
    const catalog = CATALOG.exec(first);
    const withoutCatalog = catalog ? clean(first.slice(0, catalog.index)) : "";
    if (catalog?.[1] && withoutCatalog) { facts.catalog = clean(catalog[1]); facts.label = withoutCatalog; }
    else facts.label = first;
    if (!facts.label) delete facts.label;
  }
  return facts;
}

/** Un gris (R=G=B) es la marca con la que el blog distingue al compositor. */
function isGrey(style: string): boolean {
  const hex = /color:\s*#([0-9a-f]{3}|[0-9a-f]{6})\b/iu.exec(style)?.[1];
  if (!hex) return false;
  const full = hex.length === 3 ? hex.split("").map((char) => char + char).join("") : hex;
  const [red, green, blue] = [full.slice(0, 2), full.slice(2, 4), full.slice(4, 6)];
  return red === green && green === blue && full !== "000000" && full !== "ffffff";
}

const TRACK_LINE = /^(\d{1,3})\s*[.\-)]\s+(.+)$/u;

export class HippitoYSusChatarritasAdapter extends BloggerAdapter {
  readonly slug = "hippito-y-sus-chatarritas";

  private record(entityKind: RawRecord["entityKind"], identity: string, fields: RawRecord["fields"]): RawRecord {
    return { entityKind, identity: identity.slice(0, 250), extractor: this.slug, extractorVersion: ADAPTER_VERSION, fields };
  }

  protected override extractEntry(html: string, title: string, url: string): RawRecord[] {
    const facts = parseHippitoTitle(title);
    if (!facts) return [];
    const page = load(html);
    const records: RawRecord[] = [];
    const evidence = (selector: string, text: string, position?: number) => ({
      url, selector, excerpt: excerpt(text), ...(position === undefined ? {} : { position }),
    });
    const fromTitle = evidence("entry:title", title);

    records.push(this.record("artist", facts.artist, [
      { field: "name", value: facts.artist, evidence: fromTitle },
      { field: "source_url", value: url, evidence: evidence("link", url) },
    ]));

    const albumFields: RawRecord["fields"] = [
      { field: "title", value: facts.album, evidence: fromTitle },
      { field: "artist_name", value: facts.artist, evidence: fromTitle },
      { field: "source_url", value: url, evidence: evidence("link", url) },
    ];
    if (facts.year) albumFields.push({ field: "release_year", value: facts.year, evidence: fromTitle });
    if (facts.catalog) albumFields.push({ field: "catalog_number", value: facts.catalog, evidence: fromTitle });
    if (facts.label) albumFields.push({ field: "label", value: facts.label, evidence: fromTitle });
    records.push(this.record("album", `${facts.artist}::${facts.album}`, albumFields));

    if (facts.label) {
      records.push(this.record("organization", facts.label, [
        { field: "name", value: facts.label, evidence: fromTitle },
        { field: "organization_type", value: "record_label", evidence: fromTitle },
      ]));
    }

    // Cada pista es una línea del cuerpo que empieza por su número. Las
    // líneas indentadas sin número son movimientos de un popurrí, no pistas.
    let position = 0;
    page("div, p, li").each((_, node) => {
      const line = page(node);
      if (line.find("div, p, li").length > 0) return; // solo el bloque hoja
      const text = clean(line.text());
      const match = TRACK_LINE.exec(text);
      if (!match) return;
      const number = match[1]!;

      // El compositor va en gris: es la marca explícita del blog. Un
      // paréntesis fuera del gris es la traducción del título, no un crédito.
      const grey = line.find("span[style]").filter((__, span) => isGrey(page(span).attr("style") ?? ""));
      const greyText = clean(grey.text());
      const titleText = clean((match[2] ?? "").replace(greyText, "")).replace(/[\s:;,-]+$/u, "");
      if (!titleText) return;

      const where = evidence("div", text, position);
      records.push(this.record("track", `${facts.artist}::${facts.album}::${titleText}`, [
        { field: "title", value: titleText, evidence: where },
        { field: "track_number", value: number, evidence: where },
        { field: "album_title", value: facts.album, evidence: where },
        { field: "artist_name", value: facts.artist, evidence: where },
      ]));

      for (const credit of composers(greyText)) {
        records.push(this.record("person", credit.name, [{ field: "name", value: credit.name, evidence: where }]));
        records.push(this.record("track_credit", `${facts.album}::${titleText}::${credit.name}`, [
          { field: "album_title", value: facts.album, evidence: where },
          { field: "track_title", value: titleText, evidence: where },
          { field: "artist_name", value: facts.artist, evidence: where },
          { field: "credited_name", value: credit.name, evidence: where },
          { field: "credit_role", value: credit.role, evidence: where },
          { field: "credit_scope", value: "track", evidence: where },
        ]));
      }
      position += 1;
    });

    return records;
  }
}

// El paréntesis gris no siempre trae un nombre pelado: a veces trae una
// función etiquetada ("Arreglos y Dirección: Isaías Urbina", "Adaptación y
// Arreglo de Edwin R. Hawkins"). Emitir eso como nombre de persona con rol
// "composer" sería falso en los dos campos.
const ROLE_WORDS = "adaptaci[oó]n|arreglos?|versi[oó]n|direcci[oó]n|traducci[oó]n|letra|m[uú]sica|orquestaci[oó]n|canta[n]?|interpreta|coros?";
const ROLE_PREFIX = new RegExp(`^((?:${ROLE_WORDS})\\b[^:]{0,40}?)(?:\\s*:\\s*|\\s+de\\s+)(.+)$`, "iu");

export interface Credit { name: string; role: string; }

/** "(Bert Russell - Phil Medley / Francisco Belisario)" -> cuatro personas. */
export function composers(greyText: string): Credit[] {
  const inside = /\(([^()]*)\)\s*$/u.exec(greyText)?.[1] ?? "";
  const credits = new Map<string, Credit>();
  for (const raw of inside.split(/\s*[/;,]\s*|\s+-\s+/u)) {
    const segment = clean(raw);
    if (!segment || !/\p{L}/u.test(segment)) continue;
    const labelled = ROLE_PREFIX.exec(segment);
    if (labelled) {
      const name = clean(labelled[2] ?? "");
      if (name && name.length <= 120) credits.set(name.toLowerCase(), { name, role: clean(labelled[1] ?? "") });
      continue;
    }
    // Una función sin nombre separable no se convierte en persona: se omite
    // en vez de inventar a alguien llamado "Arreglos y Dirección".
    if (new RegExp(`\\b(?:${ROLE_WORDS})\\b`, "iu").test(segment)) continue;
    if (segment.length <= 120) credits.set(segment.toLowerCase(), { name: segment, role: "composer" });
  }
  return [...credits.values()];
}
