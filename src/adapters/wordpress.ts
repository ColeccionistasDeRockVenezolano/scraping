import { load, type CheerioAPI } from "cheerio";
import type { PageRef, RawRecord, SourceAdapter, StoredPage } from "./contracts.js";
import { ADAPTER_VERSION, absoluteUrl, clean, extractNarrativeHtml } from "./shared.js";
import { CrvWordpressArtsExtractor } from "./crv-wordpress.js";
import { ElPunkBandcampExtractor } from "./el-punk.js";

type WordPressItem = {
  link?: string;
  slug?: string;
  title?: { rendered?: string };
  content?: { rendered?: string };
};

abstract class WordPressAdapter implements SourceAdapter {
  readonly requiresBrowser = false as const;
  readonly crawlLimit: number = 5;
  abstract readonly slug: string;
  protected abstract targets(rootUrl: string): PageRef[];
  async *listPages(rootUrl: string): AsyncIterable<PageRef> {
    for (const target of this.targets(rootUrl)) yield target;
  }
  extract(page: CheerioAPI, url: string): RawRecord[] { return extractNarrativeHtml(page.html(), url, this.slug); }
  protected extractItem(item: WordPressItem, pageUrl: string): RawRecord[] {
    return item.content?.rendered ? extractNarrativeHtml(item.content.rendered, item.link ?? pageUrl, this.slug) : [];
  }
  extractSnapshot(page: StoredPage): RawRecord[] {
    if (page.kind === "html") return extractNarrativeHtml(page.body, page.url, this.slug);
    let items: WordPressItem[];
    try { items = JSON.parse(page.body) as WordPressItem[]; } catch { return []; }
    if (!Array.isArray(items)) return [];
    return items.flatMap((item) => this.extractItem(item, page.url));
  }
}

function isSitemapUrl(url: string): boolean {
  try {
    return /\/[^/]*sitemap[^/]*\.xml$/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function decodeXmlText(value: string): string {
  return value.trim()
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&"); // último: evita re-decodificar lo ya sustituido
}

/**
 * WordPress.com enruta su REST por public-api.wordpress.com, cuyo robots.txt
 * declara `Disallow: /`, y el blog no expone /wp-json/ en su propio origen
 * (404). El canal autorizado es el sitemap que su propio robots.txt publica
 * para crawlers, seguido del HTML de cada entrada.
 */
export class ColeccionistasWordpressAdapter extends WordPressAdapter {
  readonly slug = "coleccionistas-de-rock-venezolano";
  // 1 sitemap + 94 URLs publicadas; margen finito si el blog crece.
  override readonly crawlLimit = 150;

  protected targets(rootUrl: string): PageRef[] {
    return [{ url: new URL("/sitemap.xml", absoluteUrl(rootUrl)).toString(), kind: "xml" }];
  }

  isAllowedUrl(url: string, rootUrl: string): boolean {
    try {
      const candidate = new URL(url);
      if (candidate.origin !== new URL(absoluteUrl(rootUrl)).origin) return false;
      // Las rutas que el propio robots.txt del blog excluye.
      return !/^\/(?:wp-admin|wp-login\.php|wp-signup\.php|press-this\.php|remote-login\.php|activate|cgi-bin|mshots|next|public\.api)\b/i
        .test(candidate.pathname);
    } catch {
      return false;
    }
  }

  discover(page: StoredPage): PageRef[] {
    if (!isSitemapUrl(page.url)) return []; // solo el índice expande la frontera
    const urls = [...page.body.matchAll(/<url>\s*<loc>([^<]+)<\/loc>/gi)]
      .map((match) => decodeXmlText(match[1] ?? ""))
      .filter((url) => url && this.isAllowedUrl(url, page.url));
    return [...new Set(urls)].map((url) => ({ url, kind: "html" as const }));
  }

  /**
   * Las artes viven en el `alt` de cada imagen, no en el texto del post: ver
   * crv-wordpress.ts. Es la única fuente del archivo con contraportadas,
   * galletas de CD y libretos.
   */
  private readonly arts = new CrvWordpressArtsExtractor(this.slug);

  override extractSnapshot(page: StoredPage): RawRecord[] {
    if (isSitemapUrl(page.url)) return []; // el sitemap es índice, no contenido
    if (page.kind !== "html") return super.extractSnapshot(page);
    return this.arts.extract(page);
  }
}

/**
 * Sitio-libro WP: usa pages; posts fue confirmado vacío. Sus escaneos de
 * página son obra protegida y no se ingieren — ver el-punk.ts. Lo extraíble
 * son los discos que el sello incrustó desde Bandcamp.
 */
export class ElPunkEnVenezuelaAdapter extends WordPressAdapter {
  readonly slug = "el-punk-en-venezuela";
  private readonly bandcamp = new ElPunkBandcampExtractor(this.slug);

  protected targets(rootUrl: string): PageRef[] {
    return [{ url: new URL("/wp-json/wp/v2/pages?per_page=100&page=1", absoluteUrl(rootUrl)).toString(), kind: "json" }];
  }

  protected override extractItem(item: WordPressItem, pageUrl: string): RawRecord[] {
    return item.content?.rendered ? this.bandcamp.extract(item.content.rendered, item.link ?? pageUrl) : [];
  }
}

/**
 * Sitio WordPress público de RHV. Conserva la portada HTML autorizada por el
 * XLSX y usa sus dos colecciones REST públicas y finitas (posts + pages).
 */
export class RockHechoEnVenezuelaAdapter extends WordPressAdapter {
  readonly slug = "rock-hecho-en-venezuela";
  override readonly crawlLimit = 3;

  protected targets(rootUrl: string): PageRef[] {
    const root = new URL(absoluteUrl(rootUrl));
    return [
      { url: root.toString(), kind: "html" },
      { url: new URL("/wp-json/wp/v2/posts?per_page=100&page=1", root).toString(), kind: "json" },
      { url: new URL("/wp-json/wp/v2/pages?per_page=100&page=1", root).toString(), kind: "json" },
    ];
  }

  isAllowedUrl(url: string, rootUrl: string): boolean {
    try {
      const candidate = new URL(url);
      const root = new URL(absoluteUrl(rootUrl));
      return candidate.origin === root.origin && this.targets(rootUrl).some((target) => target.url === candidate.toString());
    } catch {
      return false;
    }
  }

  protected override extractItem(item: WordPressItem, pageUrl: string): RawRecord[] {
    const itemUrl = item.link ?? pageUrl;
    try {
      if (new URL(itemUrl).origin !== new URL(pageUrl).origin) return [];
    } catch {
      return [];
    }
    const records = super.extractItem(item, pageUrl);
    if (!item.content?.rendered || (item.slug !== "leyendas" && !/\/leyendas\/?$/i.test(itemUrl))) return records;

    // La página "Leyendas" presenta una lista explícita de perfiles. Solo
    // esa estructura curada produce personas; un título de post aislado no.
    const $ = load(item.content.rendered);
    const seen = new Set<string>();
    $(".ha-pg-title > a").each((position, element) => {
      const name = clean($(element).text());
      const href = $(element).attr("href");
      if (!name || !href || seen.has(name)) return;
      let profileUrl: string;
      try {
        profileUrl = new URL(href, itemUrl).toString();
        if (new URL(profileUrl).origin !== new URL(pageUrl).origin) return;
      } catch {
        return;
      }
      seen.add(name);
      const evidence = { url: itemUrl, selector: ".ha-pg-title > a", excerpt: name, position };
      records.push({
        entityKind: "person",
        identity: name,
        extractor: this.slug,
        extractorVersion: ADAPTER_VERSION,
        fields: [
          { field: "name", value: name, evidence },
          { field: "source_url", value: profileUrl, evidence },
        ],
      });
    });
    return records;
  }
}
