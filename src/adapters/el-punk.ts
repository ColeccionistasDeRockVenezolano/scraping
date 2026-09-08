import { load } from "cheerio";
import type { RawRecord } from "./contracts.js";
import { ADAPTER_VERSION, clean, parseReleaseHead } from "./shared.js";

// "El Punk En Venezuela" es el sitio de un LIBRO (© Rafael Uzcátegui, ©
// Provea), no un archivo discográfico. Sus 1.705 escaneos de página son obra
// protegida y NO se ingieren: de esta fuente se extraen hechos, nunca
// imágenes. Ni una sola.
//
// Lo que sí es estructura son los reproductores de Bandcamp incrustados en
// los capítulos. Cada uno lleva dentro un enlace de respaldo con la
// convención propia de Bandcamp:
//
//     <Título del disco> by <Artista>
//
// 28 reproductores, 14 discos distintos, todos del sello Humano Derecho
// Records — que es la organización que los editó y entra como tal.
//
// Fuera de alcance deliberado: seis de los catorce dicen "by Recopilatorio",
// "by Recopilación" o "by Humano Derecho Records". Un recopilatorio no tiene
// un artista único y `albums.artist_id` es NOT NULL; inventar una entidad
// para ellos es una decisión de modelo, no de parsing, igual que con los VA
// de Hippito. Se emite el disco solo cuando el `by` nombra a un grupo.

export const HUMANO_DERECHO = "Humano Derecho Records";

/** El `by` de Bandcamp no siempre nombra a un grupo. */
const NOT_AN_ARTIST = /^(?:recopilatorios?|recopilaci[oó]n|compilaci[oó]n|various\s+artists?|v\.?\s*a\.?|humano\s+derecho\s+records?)$/iu;
/** "Título by Artista": el separador es " by " y el último manda. */
const BANDCAMP_BY = /^(.+)\s+by\s+([^:]{1,120})$/iu;

export interface BandcampRelease { album: string; artist: string; url: string; year?: string }

export function parseBandcampLabel(text: string, href: string): BandcampRelease | undefined {
  const match = BANDCAMP_BY.exec(clean(text));
  if (!match) return undefined;
  const album = clean(match[1] ?? "");
  // Bandcamp anexa a veces una coletilla entre paréntesis al nombre del
  // artista; el nombre es lo que va delante.
  const artist = clean((match[2] ?? "").replace(/\s*\(.*$/u, ""));
  if (!album || !artist || NOT_AN_ARTIST.test(artist)) return undefined;
  const release: BandcampRelease = { album, artist, url: href };
  // Solo un año entre paréntesis al final cuenta. "86-96" y "Demo 1985" son
  // el título tal cual lo publicó el sello, no una fecha que podamos afirmar.
  const head = parseReleaseHead(album);
  if (head) { release.album = head.title; release.year = head.year; }
  return release;
}

export class ElPunkBandcampExtractor {
  constructor(private readonly slug: string) {}

  private record(entityKind: RawRecord["entityKind"], identity: string, fields: RawRecord["fields"]): RawRecord {
    return { entityKind, identity: identity.slice(0, 250), extractor: this.slug, extractorVersion: ADAPTER_VERSION, fields };
  }

  extract(html: string, url: string): RawRecord[] {
    const page = load(html);
    const evidence = (selector: string, text: string) => ({ url, selector, excerpt: clean(text).slice(0, 2_000) });
    const records: RawRecord[] = [];
    const seen = new Set<string>();

    page("iframe[src*='bandcamp'], a[href*='bandcamp']").each((_, node) => {
      const element = page(node);
      // El <a> de respaldo vive DENTRO del iframe: es el que trae el título.
      const anchor = element.is("a") ? element : load(`<div>${element.html() ?? ""}</div>`)("a[href*='bandcamp']").first();
      const href = (anchor.attr("href") ?? "").trim();
      const release = href ? parseBandcampLabel(anchor.text(), href) : undefined;
      if (!release || seen.has(href)) return;
      seen.add(href);
      const where = evidence("a[href*='bandcamp']", anchor.text());

      records.push(this.record("artist", release.artist, [
        { field: "name", value: release.artist, evidence: where },
        { field: "source_url", value: url, evidence: evidence("link", url) },
      ]));
      records.push(this.record("album", `${release.artist}::${release.album}`, [
        { field: "title", value: release.album, evidence: where },
        { field: "artist_name", value: release.artist, evidence: where },
        ...(release.year ? [{ field: "release_year", value: release.year, evidence: where }] : []),
        { field: "label", value: HUMANO_DERECHO, evidence: where },
        { field: "web_url", value: release.url, evidence: where },
        { field: "source_url", value: url, evidence: evidence("link", url) },
      ]));
      records.push(this.record("organization", HUMANO_DERECHO, [
        { field: "name", value: HUMANO_DERECHO, evidence: where },
        { field: "organization_type", value: "record_label", evidence: where },
      ]));
    });
    return records;
  }
}
