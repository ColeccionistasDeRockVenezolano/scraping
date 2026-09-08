// Utilidades conservadoras compartidas. Estas funciones no infieren datos a
// partir de títulos o prosa: sólo consumen etiquetas, tablas o listas que la
// página presenta expresamente como metadatos/créditos.
import { load, type CheerioAPI } from "cheerio";
import type { RawRecord, Evidence } from "./contracts.js";

export const ADAPTER_VERSION = "1.0.0";

export function absoluteUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value.replace(/^\/+/, "")}`;
}

export function clean(value: string): string {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

export function excerpt(value: string): string {
  return clean(value).slice(0, 2_000);
}

function evidence(url: string, selector: string, text: string, position?: number): Evidence {
  return { url, selector, excerpt: excerpt(text), ...(position === undefined ? {} : { position }) };
}

type Found = { value: string; selector: string; text: string; position: number };

const labels: Array<[RegExp, string]> = [
  [/^(?:artista|artist|banda|band|grupo)\s*:/i, "artist_name"],
  [/^(?:tipo de artista|artist type)\s*:/i, "artist_type"],
  [/^(?:biograf[ií]a|biography)\s*:/i, "biography"],
  [/^(?:origen|origin)\s*:/i, "origin"],
  [/^(?:ciudad de origen|origin city)\s*:/i, "origin_city"],
  [/^(?:pa[ií]s de origen|origin country)\s*:/i, "origin_country"],
  [/^(?:formad[oa]|formed)\s*:/i, "formed_date"],
  [/^(?:disuelt[oa]|separad[oa]|disbanded)\s*:/i, "disbanded_date"],
  [/^(?:g[eé]nero(?:s)?|genre(?:s)?)\s*:/i, "genres"],
  [/^(?:alias|nombre(?:s)? anterior(?:es)?)\s*:/i, "aliases"],
  [/^(?:[áa]lbum|album|disco|release)\s*:/i, "album_title"],
  [/^(?:tipo de [áa]lbum|album type|formato)\s*:/i, "album_type"],
  [/^(?:a[nñ]o|fecha de lanzamiento|release (?:year|date))\s*:/i, "release_date"],
  [/^(?:sello|label)\s*:/i, "label"],
  [/^(?:cat[áa]logo|catalog(?:ue)?(?: no\.?)?)\s*:/i, "catalog_number"],
  [/^(?:estudio(?: de grabaci[oó]n)?|recording studio)\s*:/i, "recording_studio"],
  [/^(?:localizaci[oó]n|location)\s*:/i, "location"],
  [/^(?:compa[nñ][ií]a de producci[oó]n|production company)\s*:/i, "production_company"],
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
    const text = clean($(node).text());
    // Evita volver a procesar el texto concatenado de un contenedor padre.
    if (!text || text.length > 1_500) return;
    for (const [pattern, field] of labels) {
      const match = pattern.exec(text);
      if (!match) continue;
      add(field, text.slice(match[0].length), node.tagName.toLowerCase(), text);
      break;
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
    for (const key of ["artist_type", "biography", "origin", "origin_city", "origin_country", "formed_date", "disbanded_date"] as const) {
      const item = found.get(key)?.[0]; if (item) artistFields.push([key, item]);
    }
    for (const alias of found.get("aliases") ?? []) artistFields.push(["alias", alias]);
    for (const genre of found.get("genres") ?? []) for (const value of splitExplicitList(genre.value)) artistFields.push(["genre", { ...genre, value }]);
    artistFields.push(["source_url", { value: url, selector: "document", text: url, position: 0 }]);
    records.push({ entityKind: "artist", identity: artist.slice(0, 250), extractor, extractorVersion: ADAPTER_VERSION, fields: fieldsFor(url, artistFields) });
  }
  if (album) {
    const titleEvidence = found.get("album_title")?.[0] ?? { value: album, selector: "h1", text: album, position: 0 };
    const albumFields: Array<[string, Found]> = [["title", titleEvidence]];
    if (artist) albumFields.push(["artist_name", found.get("artist_name")?.[0] ?? { value: artist, selector: "h1", text: artist, position: 0 }]);
    for (const key of ["album_type", "release_date", "label", "catalog_number", "recording_studio", "location", "production_company"] as const) {
      const item = found.get(key)?.[0]; if (item) albumFields.push([key === "release_date" && /^\d{4}$/.test(item.value) ? "release_year" : key, item]);
    }
    albumFields.push(["source_url", { value: url, selector: "document", text: url, position: 0 }]);
    records.push({ entityKind: "album", identity: `${artist ?? "unknown artist"}::${album}`.slice(0, 250), extractor, extractorVersion: ADAPTER_VERSION, fields: fieldsFor(url, albumFields) });
  }
  return [...records, ...extractTracks($, url, artist, album, extractor), ...extractCredits($, url, artist, album, extractor)];
}

export function extractNarrativeHtml(html: string, url: string, extractor: string): RawRecord[] {
  return extractExplicitCatalog(load(html), url, extractor);
}
