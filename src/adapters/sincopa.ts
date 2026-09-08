import { load, type CheerioAPI } from "cheerio";
import type { AnyNode } from "domhandler";
import type { PageRef, RawRecord, SourceAdapter, StoredPage } from "./contracts.js";
import { ADAPTER_VERSION, absoluteUrl, clean, excerpt } from "./shared.js";

// Sincopa es HTML de FrontPage: tablas anidadas, sin clases ni encabezados
// semánticos. Toda su semántica está codificada en el color de fuente:
//   #FFCC00 dorado -> la entidad (nombre de persona, título de pista) y, como
//                     fondo de celda, el encabezado de sección
//   #FFFFFF blanco -> etiquetas y valores
//   size="1"       -> el período entre paréntesis que sigue a cada persona
// Las etiquetas y sus valores viven en CELDAS DISTINTAS y se aparean por
// posición de <br>, no por proximidad en el texto: leerlas como un bloque
// plano produce cadenas del tipo "Formed: Based: Genre: 1967 in Caracas...".
const GOLD = "#FFCC00";

function pageTitle($: CheerioAPI): string | undefined {
  const title = clean($("h1,h2,title").first().text());
  return title && title.length <= 250 ? title : undefined;
}

/** Divide el HTML de una celda por <br> y devuelve el texto de cada tramo. */
function splitByBr($: CheerioAPI, html: string): string[] {
  return html
    .split(/<br\s*\/?>/i)
    .map((chunk) => clean($(`<div>${chunk}</div>`).text()))
    .filter(Boolean);
}

/**
 * Empareja la celda de etiquetas ("Formed:<br>Based:<br>Genre:") con la celda
 * de valores contigua, tramo a tramo. Devuelve las claves en minúscula y sin
 * los dos puntos finales.
 */
function labelledPairs($: CheerioAPI): Map<string, string> {
  const pairs = new Map<string, string>();
  $("tr").each((_, row) => {
    if (pairs.size > 0) return;
    const cells = $(row).children("td").toArray();
    for (let index = 0; index < cells.length - 1; index += 1) {
      const labels = splitByBr($, $(cells[index]!).html() ?? "").filter((text) => text.endsWith(":"));
      if (labels.length === 0) continue;
      const values = splitByBr($, $(cells[index + 1]!).html() ?? "");
      labels.forEach((label, position) => {
        const value = values[position];
        if (value) pairs.set(label.replace(/:$/, "").trim().toLowerCase(), value);
      });
      if (pairs.size > 0) return;
    }
  });
  return pairs;
}

/** Filas que siguen a un encabezado de sección (td dorado) hasta el siguiente. */
function rowsUnderSection($: CheerioAPI, pattern: RegExp): AnyNode[] {
  const rows: AnyNode[] = [];
  let active = false;
  $("tr").each((_, row) => {
    const header = $(row).find(`td[bgcolor="${GOLD}"]`).first();
    if (header.length > 0) {
      active = pattern.test(clean(header.text()));
      return;
    }
    if (active) rows.push(row);
  });
  return rows;
}

interface Member { role: string; name: string; from?: string; to?: string; }

/** "(1970-76)" -> {from:"1970", to:"1976"}; "(1977)" -> {from:"1977"}. */
function parsePeriod(raw: string): { from?: string; to?: string } {
  const range = /(\d{4})\s*[-–—]\s*(\d{2,4})/.exec(raw);
  if (range?.[1] && range[2]) {
    const from = range[1];
    const tail = range[2];
    const to = tail.length === 2 ? `${from.slice(0, 2)}${tail}` : tail;
    return { from, to };
  }
  const single = /(\d{4})/.exec(raw);
  return single?.[1] ? { from: single[1] } : {};
}

/**
 * Una fila de miembros trae el rol una sola vez, seguido de pares
 * (nombre dorado, período en size="1"). Se recorren los <font> en orden de
 * documento y solo se toma el dorado más interno, para no contar dos veces
 * un nombre envuelto en otro font dorado.
 */
function membersInRow($: CheerioAPI, row: AnyNode): Member[] {
  const cell = $(row).find("td").first();
  const html = cell.html() ?? "";
  const goldAt = html.search(new RegExp(`<font[^>]*color="${GOLD}"`, "i"));
  const role = goldAt > 0
    ? clean($(`<div>${html.slice(0, goldAt)}</div>`).text()).replace(/:\s*$/, "").trim()
    : "";
  if (!role) return [];

  const members: Member[] = [];
  let pending: Member | null = null;
  const flush = () => { if (pending) { members.push(pending); pending = null; } };

  for (const node of cell.find("font").toArray()) {
    const element = $(node);
    const isGold = (element.attr("color") ?? "").toUpperCase() === GOLD;
    if (isGold && element.find(`font[color="${GOLD}"]`).length === 0) {
      const name = clean(element.text());
      if (!name || !named(name)) continue;
      flush();
      pending = { role, name };
      continue;
    }
    if (pending && element.attr("size") === "1") {
      const { from, to } = parsePeriod(clean(element.text()));
      if (from) pending.from = from;
      if (to) pending.to = to;
      flush();
    }
  }
  flush();
  return members;
}

interface Credit { role: string; name: string; tracks?: string; }

/**
 * Sincopa marca "sin dato" con guiones ("---", "----") y deja paréntesis
 * sueltos en algunas fichas. Una identidad sin letras ni dígitos no nombra a
 * nadie: normaliza a cadena vacía y el esquema de claims la rechaza, tumbando
 * la ingesta completa por seis filas de basura.
 */
function named(value: string): boolean {
  return /[\p{L}\p{N}]/u.test(value);
}

/** Solo coma y "&": partir por " y " rompería nombres propios en español. */
function splitNames(value: string): string[] {
  return value
    .split(/\s*(?:,|&|\+)\s*/)
    .map((part) => clean(part))
    .filter((part) => part.length > 1 && part.length <= 200 && named(part));
}

/**
 * Fila de créditos: "Rol: Nombre, Nombre & Nombre", con un alcance opcional
 * "(tracks 01, 02)" tras cada grupo. Una fila sin dorado es una sub-cabecera
 * ("Guest Musicians:") o el nombre del grupo, y no aporta crédito alguno.
 */
function creditsInRow($: CheerioAPI, row: AnyNode): Credit[] {
  const cell = $(row).find("td").first();
  const html = cell.html() ?? "";
  const goldAt = html.search(new RegExp(`<font[^>]*color="${GOLD}"`, "i"));
  if (goldAt < 0) return [];
  const role = clean($(`<div>${html.slice(0, goldAt)}</div>`).text()).replace(/:\s*$/, "").trim();
  if (!role) return [];

  const credits: Credit[] = [];
  for (const node of cell.find(`font[color="${GOLD}"]`).toArray()) {
    const element = $(node);
    if (element.find(`font[color="${GOLD}"]`).length > 0) continue;
    // El listado "(tracks 01, 02, 03)" suele venir partido en varios <font>:
    // se reúne todo lo que sigue hasta el próximo nombre dorado.
    const between = element.nextUntil(`font[color="${GOLD}"]`).toArray()
      .map((sibling) => clean($(sibling).text()))
      .join(" ");
    const scoped = /\(?\s*(tracks?\b[^)]*)\)?/i.exec(clean(between));
    const scope = /^\(?\s*tracks?\b/i.test(clean(between)) && scoped?.[1] ? clean(scoped[1]) : "";
    for (const name of splitNames(clean(element.text()))) {
      credits.push({ role, name, ...(scope ? { tracks: scope } : {}) });
    }
  }
  return credits;
}

export class SincopaAdapter implements SourceAdapter {
  readonly slug = "sincopa";
  readonly requiresBrowser = false as const;
  // 1 vertical + índices rock_pop + 627 fichas confirmadas + árbol musicians.
  // Frontera finita, con margen para que el techo no vuelva a truncar el
  // corpus: el primer barrido se cortó en 700 con rock/pop al 44%.
  readonly crawlLimit = 1200;

  async *listPages(rootUrl: string): AsyncIterable<PageRef> {
    const root = absoluteUrl(rootUrl).replace(/\/+$/, "");
    yield { url: `${root}/vertical.htm`, kind: "html" };
  }

  decodeBody(body: Buffer): string { return new TextDecoder("windows-1252").decode(body); }

  isAllowedUrl(url: string, rootUrl: string): boolean {
    const candidate = new URL(url); const root = new URL(absoluteUrl(rootUrl));
    if (candidate.origin !== root.origin) return false;
    // Alcance documentado en SOURCES.md §3: rock/pop más el árbol `musicians`
    // (páginas de persona por instrumento, la única vía de esta fuente hacia
    // `persons`). Los demás géneros del sitio —jazz, classic, new_age,
    // latin_pop, traditional, ethnic— quedan fuera: en el primer barrido se
    // llevaron 369 de las 700 páginas del presupuesto sin aportar al foco.
    return /\/(?:vertical\.htm|(?:rock_pop|musicians)\/[^?#]*|artist_rock\/[^?#]+\.htm|cdinfo_rock\/[^?#]+\.htm)$/i.test(candidate.pathname);
  }

  discover(page: StoredPage): PageRef[] {
    const $ = load(page.body);
    const discovered = new Map<string, PageRef>();
    $("a[href], frame[src]").each((_, node) => {
      const ref = $(node).attr("href") ?? $(node).attr("src");
      if (!ref) return;
      const url = new URL(ref, page.url).toString();
      if (this.isAllowedUrl(url, page.url)) discovered.set(url, { url, kind: "html" });
    });
    return [...discovered.values()].slice(0, this.crawlLimit);
  }

  extractSnapshot(page: StoredPage): RawRecord[] { return this.extract(load(page.body), page.url); }

  extract(page: CheerioAPI, url: string): RawRecord[] {
    const pathname = new URL(url).pathname;
    const records = /\/artist_rock\//i.test(pathname) ? this.extractArtist(page, url)
      : /\/cdinfo_rock\//i.test(pathname) ? this.extractAlbum(page, url)
      : [];
    // Red de seguridad: ninguna identidad sin letras ni dígitos sale de aquí.
    return records.filter((record) => named(record.identity));
  }

  private record(entityKind: RawRecord["entityKind"], identity: string, fields: RawRecord["fields"]): RawRecord {
    return { entityKind, identity: identity.slice(0, 250), extractor: this.slug, extractorVersion: ADAPTER_VERSION, fields };
  }

  private extractArtist(page: CheerioAPI, url: string): RawRecord[] {
    // El nombre vive en la banda superior granate, no en <title>: el título
    // arrastra el sufijo " - Bio & Discography" y ensuciaría la identidad.
    const banner = clean(page('td[bgcolor="#6A152F"]').first().text());
    const name = banner || pageTitle(page)?.replace(/\s*-\s*Bio\s*&\s*Discography\s*$/i, "").trim();
    if (!name) return [];

    const records: RawRecord[] = [];
    const pairs = labelledPairs(page);
    const evidence = (selector: string, text: string, position?: number) => ({
      url, selector, excerpt: excerpt(text), ...(position === undefined ? {} : { position }),
    });

    const artistFields: RawRecord["fields"] = [
      { field: "name", value: name, evidence: evidence('td[bgcolor="#6A152F"]', name) },
      { field: "source_url", value: url, evidence: evidence("link", url) },
    ];
    const formed = pairs.get("formed");
    if (formed) {
      const year = /(\d{4})/.exec(formed)?.[1];
      const place = /\bin\s+(.+)$/i.exec(formed)?.[1];
      if (year) artistFields.push({ field: "formed_year", value: year, evidence: evidence("td", formed) });
      if (place) {
        const parts = place.split(",").map((part) => clean(part)).filter(Boolean);
        const city = parts[0]; const country = parts[parts.length - 1];
        if (city) artistFields.push({ field: "origin_city", value: city, evidence: evidence("td", formed) });
        if (country && country !== city) artistFields.push({ field: "origin_country", value: country, evidence: evidence("td", formed) });
      }
    }
    const genre = pairs.get("genre");
    if (genre) artistFields.push({ field: "genre", value: genre, evidence: evidence("td", genre) });
    records.push(this.record("artist", name, artistFields));

    // Miembros: rol + persona + años. Solo dentro de la sección "Members";
    // un músico acreditado en un disco jamás llega por esta ruta.
    rowsUnderSection(page, /members|miembros|formaci[oó]n/i).forEach((row, position) => {
      for (const member of membersInRow(page, row)) {
        const text = `${member.role}: ${member.name}${member.from ? ` (${member.from}${member.to ? `-${member.to}` : ""})` : ""}`;
        const where = evidence("tr td", text, position);
        records.push(this.record("person", member.name, [{ field: "name", value: member.name, evidence: where }]));
        const membership: RawRecord["fields"] = [
          { field: "artist_name", value: name, evidence: where },
          { field: "person_name", value: member.name, evidence: where },
          { field: "role", value: member.role, evidence: where },
        ];
        if (member.from) membership.push({ field: "from_year", value: member.from, evidence: where });
        if (member.to) membership.push({ field: "to_year", value: member.to, evidence: where });
        records.push(this.record("artist_membership", `${name}::${member.name}::${member.role}`, membership));
      }
    });

    // Discografía: año | título (enlace a la ficha de disco) | sello + catálogo.
    rowsUnderSection(page, /discograph|discograf/i).forEach((row, position) => {
      const cells = page(row).children("td").toArray();
      if (cells.length < 2) return;
      const year = clean(page(cells[0]!).text());
      const titleCell = page(cells[1]!);
      const title = clean(titleCell.text());
      if (!title) return;
      const text = `${year} ${title}`;
      const where = evidence("tr td", text, position);
      const albumFields: RawRecord["fields"] = [
        { field: "title", value: title, evidence: where },
        { field: "artist_name", value: name, evidence: where },
      ];
      if (/^\d{4}$/.test(year)) albumFields.push({ field: "release_year", value: year, evidence: where });
      const href = titleCell.find("a[href]").first().attr("href");
      if (href) albumFields.push({ field: "source_url", value: new URL(href, url).toString(), evidence: where });

      const labelCell = cells[2] ? page(cells[2]) : undefined;
      const label = labelCell ? clean(labelCell.find('font[size="2"]').first().text()) : "";
      const catalog = labelCell ? clean(labelCell.find('font[size="1"]').first().text()) : "";
      if (catalog) albumFields.push({ field: "catalog_number", value: catalog, evidence: where });
      records.push(this.record("album", title, albumFields));
      if (label && named(label)) {
        records.push(this.record("organization", label, [
          { field: "name", value: label, evidence: where },
          { field: "organization_type", value: "label", evidence: where },
        ]));
      }
    });

    return records;
  }

  private extractAlbum(page: CheerioAPI, url: string): RawRecord[] {
    const pairs = labelledPairs(page);
    const title = pairs.get("album title");
    const artist = pairs.get("artist");
    if (!title) return [];

    const records: RawRecord[] = [];
    const evidence = (selector: string, text: string, position?: number) => ({
      url, selector, excerpt: excerpt(text), ...(position === undefined ? {} : { position }),
    });

    const albumFields: RawRecord["fields"] = [
      { field: "title", value: title, evidence: evidence("td", title) },
      { field: "source_url", value: url, evidence: evidence("link", url) },
    ];
    if (artist) albumFields.push({ field: "artist_name", value: artist, evidence: evidence("td", artist) });
    const genre = pairs.get("genre");
    if (genre) albumFields.push({ field: "genre", value: genre, evidence: evidence("td", genre) });
    const release = pairs.get("release year");
    if (release) {
      const year = /(\d{4})/.exec(release)?.[1];
      // "1996  (CD)": el paréntesis trae el formato físico, no parte del año.
      const format = /\(([^)]+)\)/.exec(release)?.[1];
      if (year) albumFields.push({ field: "release_year", value: year, evidence: evidence("td", release) });
      if (format) albumFields.push({ field: "format", value: clean(format), evidence: evidence("td", release) });
    }
    records.push(this.record("album", title, albumFields));

    const company = pairs.get("company");
    if (company && named(company)) {
      records.push(this.record("organization", company, [
        { field: "name", value: company, evidence: evidence("td", company) },
        { field: "organization_type", value: "label", evidence: evidence("td", company) },
      ]));
    }

    // Pistas: "01- Título (Compositor)". El título va en dorado; el compositor
    // entre paréntesis es un crédito de la pista, nunca una membresía.
    rowsUnderSection(page, /tracks?|pistas?|temas?/i).forEach((row, position) => {
      const cell = page(row).find("td").first();
      const text = clean(cell.text());
      if (!text) return;
      const trackTitle = clean(cell.find(`font[color="${GOLD}"]`).first().text());
      if (!trackTitle) return;
      const number = /^(\d{1,3})\s*[-.]/.exec(text)?.[1];
      const where = evidence("tr td", text, position);
      const trackFields: RawRecord["fields"] = [
        { field: "title", value: trackTitle, evidence: where },
        { field: "album_title", value: title, evidence: where },
      ];
      if (artist) trackFields.push({ field: "artist_name", value: artist, evidence: where });
      if (number) trackFields.push({ field: "track_number", value: number, evidence: where });
      records.push(this.record("track", trackTitle, trackFields));

      const composer = /\(([^)]+)\)\s*$/.exec(text)?.[1];
      const credited = composer ? clean(composer) : "";
      if (credited && named(credited)) {
        records.push(this.record("person", credited, [{ field: "name", value: credited, evidence: where }]));
        records.push(this.record("track_credit", `${title}::${trackTitle}::${credited}`, [
          { field: "album_title", value: title, evidence: where },
          { field: "track_title", value: trackTitle, evidence: where },
          { field: "credited_name", value: credited, evidence: where },
          { field: "credit_role", value: "composer", evidence: where },
          { field: "credit_scope", value: "track", evidence: where },
        ]));
      }
    });

    // Créditos del disco. Un crédito acotado con "(tracks NN)" es de pista;
    // el resto es de álbum. Ninguno se convierte jamás en membresía de banda:
    // tocar en un disco no es pertenecer al grupo (CONTRACT, regla dura).
    rowsUnderSection(page, /musicians?|credits?|personnel/i).forEach((row, position) => {
      for (const credit of creditsInRow(page, row)) {
        const text = `${credit.role}: ${credit.name}${credit.tracks ? ` (${credit.tracks})` : ""}`;
        const where = evidence("tr td", text, position);
        const scope = credit.tracks ? "track" : "album";
        records.push(this.record("person", credit.name, [{ field: "name", value: credit.name, evidence: where }]));
        const fields: RawRecord["fields"] = [
          { field: "album_title", value: title, evidence: where },
          { field: "credited_name", value: credit.name, evidence: where },
          { field: "credit_role", value: credit.role, evidence: where },
          { field: "credit_scope", value: scope, evidence: where },
        ];
        if (credit.tracks) fields.push({ field: "track_numbers", value: credit.tracks, evidence: where });
        records.push(this.record(
          scope === "track" ? "track_credit" : "album_credit",
          `${title}::${credit.name}::${credit.role}`,
          fields,
        ));
      }
    });

    return records;
  }
}
