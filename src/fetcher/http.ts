// CRV · fetcher HTTP (ARCHITECTURE.md §4.1). GET con User-Agent
// identificable, timeout, reintento con backoff exponencial, respeto de
// robots.txt, y cortesía: concurrencia=1 por dominio + demora mínima entre
// peticiones (por defecto 1 s, configurable por CRAWL_DELAY_MS).
import { moduleLogger } from "../logger/index.js";
import { getEnv } from "../config/env.js";
import { getRobotsCrawlDelay, isAllowedByRobots } from "./robots.js";

const log = moduleLogger("fetcher:http");

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string | null;
  body: Buffer;
  headers: Record<string, string>;
  fetchedAt: Date;
}

export class RobotsDisallowedError extends Error {
  constructor(url: string) {
    super(`robots.txt prohíbe el acceso a ${url}`);
    this.name = "RobotsDisallowedError";
  }
}

/** Error terminal después de agotar los reintentos configurados. */
export class FetchFailedError extends Error {
  readonly retryCount: number;
  readonly url: string;

  constructor(url: string, retryCount: number, cause: unknown) {
    super(
      `falló GET ${url} después de ${retryCount} reintento(s): ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
    this.name = "FetchFailedError";
    this.url = url;
    this.retryCount = retryCount;
  }
}

// Cortesía por fuente (y, por tanto, también por dominio cuando una fuente
// tiene un solo host): 1 petición concurrente + demora mínima. La clave
// explícita evita que una fuente monopolice otra si comparten CDN/dominio.
const domainQueues = new Map<string, Promise<unknown>>();
const lastRequestAt = new Map<string, number>();

async function withDomainThrottle<T>(hostname: string, delayMs: number, fn: () => Promise<T>): Promise<T> {
  const previous = domainQueues.get(hostname) ?? Promise.resolve();

  const run = previous.then(async () => {
    const last = lastRequestAt.get(hostname) ?? 0;
    const wait = last + delayMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt.set(hostname, Date.now());
    return fn();
  });

  // Encadena aunque falle, para no romper la cola del dominio.
  domainQueues.set(hostname, run.catch(() => undefined));
  return run;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * GET cortés y resiliente. Lanza RobotsDisallowedError si robots.txt lo
 * prohíbe (nunca se hace la petición en ese caso). Reintenta con backoff
 * exponencial (1s, 2s, 4s, ...) sobre errores de red, 5xx y 429; no
 * reintenta 4xx (salvo 429).
 */
export async function politeFetch(url: string, sourceRateLimitKey?: string): Promise<FetchResult> {
  if (!(await isAllowedByRobots(url))) {
    throw new RobotsDisallowedError(url);
  }

  const env = getEnv();
  const hostname = new URL(url).hostname;
  const delayMs = Math.max(env.CRAWL_DELAY_MS, await getRobotsCrawlDelay(url));
  const rateKey = sourceRateLimitKey ? `${sourceRateLimitKey}:${hostname}` : hostname;

  return withDomainThrottle(rateKey, delayMs, async () => {
    let lastError: unknown;
    for (let attempt = 0; attempt <= env.CRAWL_MAX_RETRIES; attempt += 1) {
      if (attempt > 0) {
        const backoff = 1000 * 2 ** (attempt - 1);
        log.info({ url, attempt, backoff }, "reintentando");
        await sleep(backoff);
      }
      try {
        const res = await fetch(url, {
          headers: { "user-agent": env.CRAWL_USER_AGENT },
          redirect: "follow",
          signal: AbortSignal.timeout(env.CRAWL_TIMEOUT_MS),
        });

        if (!res.ok && res.status >= 400 && res.status < 500 && res.status !== 429) {
          // 4xx (salvo 429): no reintentar, es un error del recurso, no transitorio.
          const body = Buffer.from(await res.arrayBuffer());
          return toResult(url, res, body);
        }
        if (!res.ok && (res.status >= 500 || res.status === 429)) {
          lastError = new Error(`HTTP ${res.status} en ${url}`);
          continue; // reintentable
        }

        const body = Buffer.from(await res.arrayBuffer());
        return toResult(url, res, body);
      } catch (err) {
        lastError = err;
      }
    }
    throw new FetchFailedError(url, env.CRAWL_MAX_RETRIES, lastError);
  });
}

function toResult(requestedUrl: string, res: Response, body: Buffer): FetchResult {
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => { headers[key] = value; });
  return {
    url: requestedUrl,
    finalUrl: res.url || requestedUrl,
    status: res.status,
    contentType: res.headers.get("content-type"),
    body,
    headers,
    fetchedAt: new Date(),
  };
}
