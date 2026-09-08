// CRV · Barrido de OBSERVACIÓN (PHASES F1): descarga + cachea el crudo de
// una fuente habilitada, SIN extracción (eso es F4: cheerio + adapter por
// fuente). Por ahora cubre el canal ya confirmado para Blogspot (SOURCES.md
// §3.2): el feed nativo /feeds/posts/default?alt=json, paginado con
// openSearch$totalResults. El resto de site_type quedan pendientes de F4.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { sources, scrapeRuns } from "../db/schema/ingest.js";
import { fetchAndCache } from "../cache/raw-pages.js";
import { getEnv } from "../config/env.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("fetcher:observe");

const BLOGGER_PAGE_SIZE = 25;

interface BloggerFeedPage {
  feed?: {
    openSearch$totalResults?: { $t?: string };
    entry?: unknown[];
  };
}

export interface ObserveResult {
  fetched: number;
  cached: number;
  errors: number;
  totalEntries: number | null;
  pagesSwept: number;
}

async function sweepBlogger(sourceSlug: string, baseUrl: string): Promise<ObserveResult> {
  const dataDir = getEnv().DATA_DIR;
  const origin = baseUrl.replace(/\/+$/, "");
  let startIndex = 1;
  let totalEntries: number | null = null;
  let fetched = 0;
  let cached = 0;
  let errors = 0;
  let pagesSwept = 0;

  for (;;) {
    const feedUrl = `${origin}/feeds/posts/default?alt=json&max-results=${BLOGGER_PAGE_SIZE}&start-index=${startIndex}`;
    let result;
    try {
      result = await fetchAndCache(sourceSlug, feedUrl);
    } catch (err) {
      errors += 1;
      log.error({ sourceSlug, feedUrl, err }, "fallo al descargar página del feed");
      break;
    }
    pagesSwept += 1;
    if (result.cached) cached += 1; else fetched += 1;

    const raw = await readFile(path.join(dataDir, result.storedPath), "utf8");
    const page = JSON.parse(raw) as BloggerFeedPage;
    const entryCount = page.feed?.entry?.length ?? 0;
    const total = page.feed?.openSearch$totalResults?.$t;
    if (total !== undefined) totalEntries = Number(total);

    if (entryCount === 0) break;
    startIndex += entryCount;
    if (totalEntries !== null && startIndex > totalEntries) break;
  }

  return { fetched, cached, errors, totalEntries, pagesSwept };
}

/** Ejecuta el barrido de observación para una fuente habilitada, por slug. */
export async function runObserve(sourceSlug: string): Promise<ObserveResult> {
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.slug, sourceSlug));
  if (!source) throw new Error(`fuente desconocida: ${sourceSlug}`);
  if (!source.enabled) throw new Error(`fuente deshabilitada: ${sourceSlug} (enabled=false; requiere aprobación)`);
  if (!source.url) throw new Error(`fuente sin url: ${sourceSlug}`);

  const [run] = await db.insert(scrapeRuns).values({
    kind: "scrape_source",
    sourceId: source.id,
    status: "running",
    params: { mode: "observe", siteType: source.siteType },
  }).returning();

  let result: ObserveResult;
  try {
    switch (source.siteType) {
      case "blogspot":
        result = await sweepBlogger(sourceSlug, source.url);
        break;
      default:
        throw new Error(
          `scrape --observe para site_type="${source.siteType}" no está implementado todavía ` +
          `(SOURCES.md §3 documenta el canal; el adapter llega en F4).`,
        );
    }
  } catch (err) {
    if (run) {
      await db.update(scrapeRuns)
        .set({ status: "failed", finishedAt: new Date(), errorLog: String(err) })
        .where(eq(scrapeRuns.id, run.id));
    }
    throw err;
  }

  if (run) {
    await db.update(scrapeRuns)
      .set({
        status: result.errors > 0 ? "partial" : "ok",
        finishedAt: new Date(),
        counters: { ...result },
      })
      .where(eq(scrapeRuns.id, run.id));
  }

  log.info({ sourceSlug, ...result }, "barrido de observación completo");
  return result;
}
