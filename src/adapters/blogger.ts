import { load, type CheerioAPI } from "cheerio";
import type { PageRef, RawRecord, SourceAdapter, StoredPage } from "./contracts.js";
import { ADAPTER_VERSION, absoluteUrl, extractNarrativeHtml } from "./shared.js";

type BloggerEntry = { title?: { $t?: string }; content?: { $t?: string }; summary?: { $t?: string }; link?: Array<{ rel?: string; href?: string }> };
type BloggerFeed = { feed?: { entry?: BloggerEntry[] } };

abstract class BloggerAdapter implements SourceAdapter {
  readonly requiresBrowser = false as const;
  readonly crawlLimit = 100;
  abstract readonly slug: string;
  async *listPages(rootUrl: string): AsyncIterable<PageRef> {
    const root = absoluteUrl(rootUrl).replace(/\/+$/, "");
    yield { url: `${root}/feeds/posts/default?alt=json&max-results=25&start-index=1`, kind: "json" };
  }
  extract(page: CheerioAPI, url: string): RawRecord[] { return extractNarrativeHtml(page.html(), url, this.slug); }
  extractSnapshot(page: StoredPage): RawRecord[] {
    let parsed: BloggerFeed;
    try { parsed = JSON.parse(page.body) as BloggerFeed; } catch { return []; }
    const records: RawRecord[] = [];
    for (const entry of parsed.feed?.entry ?? []) {
      const url = entry.link?.find((link) => link.rel === "alternate")?.href ?? page.url;
      const html = entry.content?.$t ?? entry.summary?.$t;
      if (html) records.push(...extractNarrativeHtml(html, url, this.slug));
    }
    return records;
  }
}

export class DescargasMetalVenezolanoAdapter extends BloggerAdapter { readonly slug = "descargas-metal-venezolano"; }
export class RockzuelaAdapter extends BloggerAdapter { readonly slug = "rockzuela"; }
export class RockDeVzlaAdapter extends BloggerAdapter { readonly slug = "rock-de-vzla"; }
export class HippitoYSusChatarritasAdapter extends BloggerAdapter { readonly slug = "hippito-y-sus-chatarritas"; }
export class RhvBlogspotAdapter extends BloggerAdapter { readonly slug = "rhv-blogspot"; }

export const bloggerAdapterVersion = ADAPTER_VERSION;
