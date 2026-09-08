import { load, type CheerioAPI } from "cheerio";
import type { PageRef, RawRecord, SourceAdapter, StoredPage } from "./contracts.js";
import { ADAPTER_VERSION, absoluteUrl, extractNarrativeHtml } from "./shared.js";

type BloggerEntry = {
  title?: { $t?: string };
  content?: { $t?: string };
  summary?: { $t?: string };
  link?: Array<{ rel?: string; href?: string }>;
  category?: Array<{ term?: string }>;
};
type BloggerFeed = { feed?: { entry?: BloggerEntry[] } };

export abstract class BloggerAdapter implements SourceAdapter {
  readonly requiresBrowser = false as const;
  readonly crawlLimit = 100;
  abstract readonly slug: string;
  async *listPages(rootUrl: string): AsyncIterable<PageRef> {
    const root = absoluteUrl(rootUrl).replace(/\/+$/, "");
    yield { url: `${root}/feeds/posts/default?alt=json&max-results=25&start-index=1`, kind: "json" };
  }
  extract(page: CheerioAPI, url: string): RawRecord[] { return extractNarrativeHtml(page.html(), url, this.slug); }

  /**
   * Punto de extensión por blog. El título y las etiquetas de la entrada se
   * pasan aparte porque no todas las fuentes ponen sus metadatos en el
   * cuerpo: hay blogs discográficos que los codifican enteros en el título, y
   * hay otros —Rock De Vzla publica 1.110 de sus 1.113 entradas con el título
   * vacío— donde el nombre de la banda solo existe como etiqueta del feed.
   * Descartar cualquiera de los dos canales antes de parsear dejaba esas
   * fuentes en cero.
   */
  protected extractEntry(html: string, _title: string, url: string, _labels: readonly string[] = []): RawRecord[] {
    return extractNarrativeHtml(html, url, this.slug);
  }

  extractSnapshot(page: StoredPage): RawRecord[] {
    let parsed: BloggerFeed;
    try { parsed = JSON.parse(page.body) as BloggerFeed; } catch { return []; }
    const records: RawRecord[] = [];
    for (const entry of parsed.feed?.entry ?? []) {
      const url = entry.link?.find((link) => link.rel === "alternate")?.href ?? page.url;
      const html = entry.content?.$t ?? entry.summary?.$t;
      const labels = [...new Set((entry.category ?? []).map((item) => (item.term ?? "").trim()).filter(Boolean))];
      if (html) records.push(...this.extractEntry(html, (entry.title?.$t ?? "").trim(), url, labels));
    }
    return records;
  }
}

export class DescargasMetalVenezolanoAdapter extends BloggerAdapter { readonly slug = "descargas-metal-venezolano"; }
export class RhvBlogspotAdapter extends BloggerAdapter { readonly slug = "rhv-blogspot"; }

export const bloggerAdapterVersion = ADAPTER_VERSION;
