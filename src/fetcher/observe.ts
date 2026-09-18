// CRV · Barrido de OBSERVACIÓN (F1): descarga + cachea crudo, sin extraer
// entidades. Los adapters semánticos siguen perteneciendo a F4.
import path from "node:path";
import { readFile } from "node:fs/promises";
import { and, desc, eq, sql } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { scrapeErrors, scrapeRuns, sources } from "../db/schema/ingest.js";
import { fetchAndCache, type CachedFetch } from "../cache/raw-pages.js";
import { getEnv } from "../config/env.js";
import { FetchFailedError, RobotsDisallowedError } from "./http.js";
import { moduleLogger } from "../logger/index.js";
import { adapterFor, adapterRegistrationFor } from "../adapters/registry.js";
import type { SourceAdapter, StoredPage } from "../adapters/contracts.js";

const log = moduleLogger("fetcher:observe");
const BLOGGER_PAGE_SIZE = 25;
const MAX_CONSECUTIVE_PAGE_ERRORS = 2;

interface BloggerFeedPage {
  feed?: {
    openSearch$totalResults?: { $t?: string };
    entry?: unknown[];
  };
}

interface ObserveCheckpoint {
  nextStartIndex?: number;
  frontierComplete?: boolean;
  pendingUrls?: string[];
}

export interface ObserveResult {
  fetched: number;
  cached: number;
  errors: number;
  totalEntries: number | null;
  pagesSwept: number;
  resumed: boolean;
  limited: boolean;
}

function emptyResult(resumed = false): ObserveResult {
  return { fetched: 0, cached: 0, errors: 0, totalEntries: null, pagesSwept: 0, resumed, limited: false };
}

function classifyError(err: unknown): { kind: "http_error" | "network" | "validation" | "other"; retries: number } {
  if (err instanceof RobotsDisallowedError) return { kind: "validation", retries: 0 };
  if (err instanceof FetchFailedError) {
    const causedByHttp = err.message.includes("HTTP ");
    return { kind: causedByHttp ? "http_error" : "network", retries: err.retryCount };
  }
  return { kind: "other", retries: 0 };
}

async function recordError(
  runId: number,
  url: string,
  err: unknown,
  rawPageId?: number,
  kindOverride?: "http_error" | "parse",
): Promise<void> {
  const classified = classifyError(err);
  await getDb().insert(scrapeErrors).values({
    runId,
    rawPageId,
    url,
    errorKind: kindOverride ?? classified.kind,
    message: err instanceof Error ? err.message : String(err),
    retryCount: classified.retries,
  });
}

async function observeOne(runId: number, sourceSlug: string, url: string, result: ObserveResult): Promise<CachedFetch | null> {
  try {
    const page = await fetchAndCache(sourceSlug, url, undefined, runId);
    result.pagesSwept += 1;
    if (page.cached) result.cached += 1;
    else result.fetched += 1;

    if (page.status >= 400) {
      result.errors += 1;
      await recordError(runId, url, new Error(`HTTP ${page.status}`), page.rawPageId, "http_error");
      return null;
    }
    return page;
  } catch (err) {
    result.errors += 1;
    await recordError(runId, url, err);
    log.error({ sourceSlug, url, err }, "fallo al observar recurso; el barrido continúa");
    return null;
  }
}

async function readJsonPage<T>(runId: number, url: string, page: CachedFetch, result: ObserveResult): Promise<T | null> {
  try {
    const raw = await readFile(path.join(getEnv().DATA_DIR, page.storedPath), "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    result.errors += 1;
    await recordError(runId, url, err, page.rawPageId, "parse");
    log.error({ url, rawPageId: page.rawPageId, err }, "snapshot inválido; el barrido continúa");
    return null;
  }
}

async function saveCheckpoint(runId: number, siteType: string, checkpoint: ObserveCheckpoint): Promise<void> {
  await getDb().update(scrapeRuns)
    .set({ params: { mode: "observe", siteType, checkpoint } })
    .where(eq(scrapeRuns.id, runId));
}

async function previousCheckpoint(sourceId: number): Promise<ObserveCheckpoint | null> {
  const [previous] = await getDb()
    .select({ params: scrapeRuns.params, status: scrapeRuns.status })
    .from(scrapeRuns)
    .where(and(eq(scrapeRuns.sourceId, sourceId), eq(scrapeRuns.kind, "scrape_source")))
    .orderBy(desc(scrapeRuns.startedAt))
    .limit(1);
  if (previous?.status !== "partial" && previous?.status !== "failed") return null;
  const params = previous?.params as { checkpoint?: ObserveCheckpoint } | null | undefined;
  return params?.checkpoint ?? null;
}

async function sweepBlogger(
  runId: number,
  sourceSlug: string,
  baseUrl: string,
  prior: ObserveCheckpoint | null,
): Promise<ObserveResult> {
  const result = emptyResult(prior !== null);
  const origin = baseUrl.replace(/\/+$/, "");
  let startIndex = prior?.frontierComplete ? Number.POSITIVE_INFINITY : (prior?.nextStartIndex ?? 1);
  let totalEntries: number | null = null;
  let consecutiveErrors = 0;
  const pending = new Set(prior?.pendingUrls ?? []);

  // Primero recupera páginas fallidas de un run anterior; luego continúa
  // desde el checkpoint. Así no repite la parte ya barrida y no pierde huecos.
  for (const url of [...pending]) {
    const fetched = await observeOne(runId, sourceSlug, url, result);
    if (!fetched) continue;
    const parsed = await readJsonPage<BloggerFeedPage>(runId, url, fetched, result);
    if (!parsed) continue;
    pending.delete(url);
    const total = parsed.feed?.openSearch$totalResults?.$t;
    if (total !== undefined && Number.isFinite(Number(total))) totalEntries = Number(total);
  }
  if (prior) {
    await saveCheckpoint(runId, "blogspot", {
      ...(prior.nextStartIndex === undefined ? {} : { nextStartIndex: prior.nextStartIndex }),
      ...(prior.frontierComplete === undefined ? {} : { frontierComplete: prior.frontierComplete }),
      pendingUrls: [...pending],
    });
  }

  while (Number.isFinite(startIndex)) {
    if (result.pagesSwept >= 100) { result.limited = true; break; }
    const feedUrl = `${origin}/feeds/posts/default?alt=json&max-results=${BLOGGER_PAGE_SIZE}&start-index=${startIndex}`;
    const page = await observeOne(runId, sourceSlug, feedUrl, result);
    if (!page) {
      pending.add(feedUrl);
      consecutiveErrors += 1;
      startIndex += BLOGGER_PAGE_SIZE;
      await saveCheckpoint(runId, "blogspot", { nextStartIndex: startIndex, frontierComplete: false, pendingUrls: [...pending] });
      // Un error aislado jamás aborta el run. Dos páginas consecutivas sin
      // respuesta frenan el frontier sin convertir un fallo en bucle infinito.
      if (consecutiveErrors >= MAX_CONSECUTIVE_PAGE_ERRORS) break;
      continue;
    }

    const parsed = await readJsonPage<BloggerFeedPage>(runId, feedUrl, page, result);
    if (!parsed) {
      pending.add(feedUrl);
      consecutiveErrors += 1;
      startIndex += BLOGGER_PAGE_SIZE;
      await saveCheckpoint(runId, "blogspot", { nextStartIndex: startIndex, frontierComplete: false, pendingUrls: [...pending] });
      if (consecutiveErrors >= MAX_CONSECUTIVE_PAGE_ERRORS) break;
      continue;
    }

    pending.delete(feedUrl);
    consecutiveErrors = 0;
    const entryCount = parsed.feed?.entry?.length ?? 0;
    const total = parsed.feed?.openSearch$totalResults?.$t;
    if (total !== undefined && Number.isFinite(Number(total))) totalEntries = Number(total);

    const next = startIndex + (entryCount > 0 ? entryCount : BLOGGER_PAGE_SIZE);
    const complete = entryCount === 0 || (totalEntries !== null && next > totalEntries);
    await saveCheckpoint(runId, "blogspot", { nextStartIndex: next, frontierComplete: complete, pendingUrls: [...pending] });
    if (complete) break;
    startIndex = next;
  }

  result.totalEntries = totalEntries;
  return result;
}

/** URLs estructurales conocidas que se pueden conservar sin interpretar su contenido. */
function observationTargets(slug: string, siteType: string, baseUrl: string): string[] {
  const targets = [baseUrl];
  if (slug === "coleccionistas-de-rock-venezolano") {
    // public-api.wordpress.com declara Disallow: / y el blog no expone
    // /wp-json/ en su propio origen; el sitemap es el canal que su robots.txt
    // publica para crawlers.
    targets.push(new URL("/sitemap.xml", baseUrl).toString());
  } else if (slug === "el-punk-en-venezuela") {
    targets.push(new URL("/wp-json/wp/v2/pages?per_page=100&page=1", baseUrl).toString());
  } else if (slug === "rock-hecho-en-venezuela") {
    targets.push(
      new URL("/wp-json/wp/v2/posts?per_page=100&page=1", baseUrl).toString(),
      new URL("/wp-json/wp/v2/pages?per_page=100&page=1", baseUrl).toString(),
    );
  } else if (siteType === "wordpress") {
    targets.push(new URL("/wp-json/wp/v2/posts?per_page=100&page=1", baseUrl).toString());
  } else if (slug === "sincopa") {
    targets.push(new URL("vertical.htm", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString());
  }
  return [...new Set(targets)];
}

async function adapterInitialTargets(adapter: SourceAdapter | undefined, baseUrl: string, fallback: string[]): Promise<string[]> {
  if (!adapter) return fallback;
  const pages: string[] = [];
  for await (const ref of adapter.listPages(baseUrl)) pages.push(ref.url);
  return pages.length > 0 ? pages : fallback;
}

async function readSnapshot(page: CachedFetch, url: string, adapter: SourceAdapter | undefined): Promise<StoredPage | null> {
  try {
    const bytes = await readFile(path.join(getEnv().DATA_DIR, page.storedPath));
    const kind: StoredPage["kind"] = /[?&]alt=json\b|\/wp\/v2\//.test(url) ? "json" : "html";
    return { url, kind, rawPageId: page.rawPageId, body: adapter?.decodeBody?.(bytes) ?? bytes.toString("utf8") };
  } catch {
    return null;
  }
}

async function sweepKnownHttpTargets(
  runId: number,
  sourceSlug: string,
  siteType: string,
  baseUrl: string,
  prior: ObserveCheckpoint | null,
): Promise<ObserveResult> {
  const result = emptyResult(prior !== null);
  const adapter = adapterFor({ slug: sourceSlug, siteType });
  const initial = await adapterInitialTargets(adapter, baseUrl, observationTargets(sourceSlug, siteType, baseUrl));
  // Una pendiente que el adapter ya no considera en alcance quedó obsoleta al
  // cambiar su frontera; reintentarla revive un error resuelto en cada run.
  const carried = (prior?.pendingUrls ?? []).filter(
    (url) => !adapter?.isAllowedUrl || adapter.isAllowedUrl(url, baseUrl) || initial.includes(url),
  );
  const targets = [...new Set([...carried, ...initial])];
  const pending = new Set<string>();
  const seen = new Set<string>();
  const limit = adapter?.crawlLimit ?? 100;
  while (targets.length > 0) {
    if (seen.size >= limit) { result.limited = true; break; }
    const url = targets.shift();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const fetched = await observeOne(runId, sourceSlug, url, result);
    if (!fetched) {
      pending.add(url);
    } else if (adapter?.discover) {
      const snapshot = await readSnapshot(fetched, url, adapter);
      for (const ref of snapshot ? adapter.discover(snapshot) : []) {
        if ((!adapter.isAllowedUrl || adapter.isAllowedUrl(ref.url, baseUrl)) && !seen.has(ref.url) && !targets.includes(ref.url)) targets.push(ref.url);
      }
    }
    await saveCheckpoint(runId, siteType, { frontierComplete: true, pendingUrls: [...pending] });
  }
  return result;
}

/** Ejecuta el barrido de observación para una fuente HTTP habilitada. */
export async function runObserve(sourceSlug: string): Promise<ObserveResult> {
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.slug, sourceSlug));
  if (!source) throw new Error(`fuente desconocida: ${sourceSlug}`);
  const registration = adapterRegistrationFor(source);
  if (registration?.status === "limited") {
    throw new Error(
      `fuente limitada: ${sourceSlug} (modo=${registration.mode}, automatización=${registration.automation}): ${registration.reason}`,
    );
  }
  if (!source.enabled) throw new Error(`fuente deshabilitada: ${sourceSlug} (enabled=false; requiere aprobación)`);
  if (!source.url) throw new Error(`fuente sin url: ${sourceSlug}`);
  if (["spreadsheet", "youtube_api", "instagram"].includes(source.siteType)) {
    throw new Error(`site_type="${source.siteType}" no es una fuente HTTP scrapeable; usa su flujo dedicado`);
  }

  const prior = await previousCheckpoint(source.id);
  const [run] = await db.insert(scrapeRuns).values({
    kind: "scrape_source",
    sourceId: source.id,
    status: "running",
    params: { mode: "observe", siteType: source.siteType, checkpoint: prior ?? {} },
  }).returning();
  if (!run) throw new Error("no se pudo crear ingest.scrape_runs");

  try {
    const result = source.siteType === "blogspot"
      ? await sweepBlogger(run.id, sourceSlug, source.url, prior)
      : await sweepKnownHttpTargets(run.id, sourceSlug, source.siteType, source.url, prior);

    await db.update(scrapeRuns)
      .set({
        status: result.errors > 0 ? "partial" : "ok",
        // Reloj de la base, como el resto de los cierres de run: con fecha JS
        // un barrido instantáneo podía violar `scrape_runs_time_chk` (mismo
        // caso que finishRun, src/ingest/runs.ts).
        finishedAt: sql`now()`,
        counters: { ...result },
        errorLog: result.errors > 0 ? `${result.errors} recurso(s) con error; ver ingest.scrape_errors` : null,
      })
      .where(eq(scrapeRuns.id, run.id));
    log.info({ sourceSlug, runId: run.id, ...result }, "barrido de observación completo");
    return result;
  } catch (err) {
    await recordError(run.id, source.url, err);
    await db.update(scrapeRuns)
      .set({ status: "failed", finishedAt: new Date(), errorLog: String(err) })
      .where(eq(scrapeRuns.id, run.id));
    throw err;
  }
}
