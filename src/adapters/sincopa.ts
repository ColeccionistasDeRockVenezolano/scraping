import { load, type CheerioAPI } from "cheerio";
import type { PageRef, RawRecord, SourceAdapter, StoredPage } from "./contracts.js";
import { absoluteUrl, clean, extractExplicitCatalog } from "./shared.js";

function pageTitle($: CheerioAPI): string | undefined {
  const title = clean($("h1,h2,title").first().text());
  return title && title.length <= 250 ? title : undefined;
}

export class SincopaAdapter implements SourceAdapter {
  readonly slug = "sincopa";
  readonly requiresBrowser = false as const;
  // 1 vertical + índices de género + 667 fichas confirmadas: margen pequeño,
  // pero una frontera finita aunque el sitio añada enlaces inesperados.
  readonly crawlLimit = 700;

  async *listPages(rootUrl: string): AsyncIterable<PageRef> {
    const root = absoluteUrl(rootUrl).replace(/\/+$/, "");
    yield { url: `${root}/vertical.htm`, kind: "html" };
  }

  decodeBody(body: Buffer): string { return new TextDecoder("windows-1252").decode(body); }

  isAllowedUrl(url: string, rootUrl: string): boolean {
    const candidate = new URL(url); const root = new URL(absoluteUrl(rootUrl));
    if (candidate.origin !== root.origin) return false;
    return /\/(?:vertical\.htm|(?:rock_pop|classic|new_age|jazz|latin_pop|traditional|ethnic|musicians)\/[^?#]*|artist_rock\/[^?#]+\.htm|cdinfo_rock\/[^?#]+\.htm)$/i.test(candidate.pathname);
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
    const isArtist = /\/artist_rock\//i.test(new URL(url).pathname);
    const isAlbum = /\/cdinfo_rock\//i.test(new URL(url).pathname);
    const fallbackArtist = isArtist ? pageTitle(page) : undefined;
    const fallbackAlbum = isAlbum ? pageTitle(page) : undefined;
    const records = extractExplicitCatalog(page, url, this.slug, { ...(fallbackArtist ? { fallbackArtist } : {}), ...(fallbackAlbum ? { fallbackAlbum } : {}) });
    const artist = records.find((record) => record.entityKind === "artist")?.identity;
    if (!artist) return records;

    // La ficha de Sincopa expresa membresía en su tabla de formación; sólo
    // leemos filas dentro de una tabla titulada Members/Miembros/Formación.
    // Un músico acreditado en un disco jamás pasa por esta ruta.
    page("table").each((_, table) => {
      const heading = clean(page(table).prevAll("h1,h2,h3,h4,b,strong,font").first().text());
      if (!/(?:members?|miembros|formaci[oó]n|ex members?)/i.test(heading)) return;
      const exMember = /ex members?|ex miembros?/i.test(heading);
      page(table).find("tr").each((rowIndex, row) => {
        const cells = page(row).find("td,th").map((__, cell) => clean(page(cell).text())).get().filter(Boolean);
        if (cells.length < 2 || /^(?:nombre|name|miembro)$/i.test(cells[0] ?? "")) return;
        const person = cells[0]; const role = cells[1]; const period = cells[2];
        if (!person || !role) return;
        const text = cells.join(" | ");
        const baseEvidence = { url, selector: "table tr", excerpt: text, position: rowIndex };
        const fields: RawRecord["fields"] = [
          { field: "artist_name", value: artist, evidence: baseEvidence },
          { field: "person_name", value: person, evidence: baseEvidence },
          { field: "role", value: role, evidence: baseEvidence },
          { field: "membership_status", value: exMember ? "former" : "current", evidence: baseEvidence },
        ];
        const range = /(?:^|\D)(\d{4})\s*[-–]\s*(\d{4}|present(?:e)?|actualidad)(?:\D|$)/i.exec(period ?? "");
        if (range?.[1]) fields.push({ field: "from_year", value: range[1], evidence: baseEvidence });
        if (range?.[2] && /^\d{4}$/.test(range[2])) fields.push({ field: "to_year", value: range[2], evidence: baseEvidence });
        records.push({ entityKind: "person", identity: person.slice(0, 250), extractor: this.slug, extractorVersion: "1.0.0", fields: [{ field: "name", value: person, evidence: baseEvidence }] });
        records.push({ entityKind: "artist_membership", identity: `${artist}::${person}::${role}`.slice(0, 250), extractor: this.slug, extractorVersion: "1.0.0", fields });
      });
    });
    return records;
  }
}
