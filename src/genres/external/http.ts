// CRV · Acceso a las fuentes externas de géneros: caché, límites y
// trazabilidad (PLAN_GENEROS etapa 4, entregable «adaptador con caché,
// límites y trazabilidad»).
//
//  * SOLO APIS DOCUMENTADAS. Aquí no se raspa nada ni se elude ningún control
//    de acceso: cada fuente entra por el mecanismo que su ficha declara
//    (`access_mode`, `access_note`) y con la identificación que exige.
//    `politeFetch` (robots.txt, cortesía por dominio) es para el rastreo del
//    catálogo; una API con su propia política de uso se atiende aquí, con su
//    límite por minuto y su User-Agent identificable con contacto.
//  * TODA RESPUESTA QUEDA GUARDADA. `ingest.genre_external_cache` conserva la
//    URL, el código y el cuerpo con su fecha: una sugerencia siempre puede
//    volver a la respuesta exacta que la originó, y repetir una importación no
//    vuelve a pedir lo mismo.
import type { PoolClient } from "pg";
import { getEnv } from "../../config/env.js";
import { moduleLogger } from "../../logger/index.js";

const log = moduleLogger("genres:external:http");

export interface JsonResponse {
  url: string;
  status: number;
  payload: unknown;
  fetchedAt: Date;
  /** La respuesta salió de la caché: no se tocó la red. */
  cached: boolean;
}

/** Lo único que la capa de red necesita exponer (y lo único que se sustituye en pruebas). */
export type JsonFetcher = (url: string, headers: Record<string, string>) => Promise<{ status: number; payload: unknown }>;

export class ExternalFetchError extends Error {
  constructor(readonly url: string, readonly status: number, message: string) {
    super(message);
    this.name = "ExternalFetchError";
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Fetcher con el límite de la fuente: nunca más de `perMinute` peticiones por
 * minuto, en serie. Reintenta 429 y 5xx respetando `Retry-After`; un 4xx
 * distinto de 429 no se reintenta (es la respuesta del recurso).
 */
export function createRateLimitedFetcher(perMinute: number, options: { maxRetries?: number; timeoutMs?: number } = {}): JsonFetcher {
  const minimumGapMs = Math.ceil(60_000 / Math.max(1, perMinute));
  const maxRetries = options.maxRetries ?? 3;
  const timeoutMs = options.timeoutMs ?? getEnv().CRAWL_TIMEOUT_MS;
  let queue: Promise<unknown> = Promise.resolve();
  let lastAt = 0;

  return (url, headers) => {
    const run = queue.then(async () => {
      const wait = lastAt + minimumGapMs - Date.now();
      if (wait > 0) await sleep(wait);
      for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
        lastAt = Date.now();
        let response: Response;
        try {
          response = await fetch(url, { headers, redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
          if (attempt === maxRetries) throw new ExternalFetchError(url, 0, `falló GET ${url}: ${String(error)}`);
          await sleep(1000 * 2 ** attempt);
          continue;
        }
        if (response.status === 429 || response.status >= 500) {
          if (attempt === maxRetries) throw new ExternalFetchError(url, response.status, `HTTP ${response.status} en ${url}`);
          const retryAfter = Number(response.headers.get("retry-after"));
          const backoff = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1000 * 2 ** attempt;
          log.warn({ url, status: response.status, backoff }, "la fuente externa pide esperar");
          await sleep(backoff);
          continue;
        }
        const text = await response.text();
        try {
          return { status: response.status, payload: text ? JSON.parse(text) : null };
        } catch {
          throw new ExternalFetchError(url, response.status, `respuesta no JSON en ${url}`);
        }
      }
      throw new ExternalFetchError(url, 0, `falló GET ${url}`);
    });
    queue = run.catch(() => undefined);
    return run;
  };
}

export interface FetchContext {
  client: PoolClient;
  sourceId: number;
  fetcher: JsonFetcher;
  headers: Record<string, string>;
  ttlDays: number;
  /** Solo caché: si la respuesta no está guardada, no se sale a la red. */
  offline?: boolean;
  stats?: { requests: number; cacheHits: number };
}

/**
 * Respuesta de la fuente, de la caché si sigue fresca. `requestKey` identifica
 * la petición dentro de la fuente (por ejemplo `artist:search:sentimiento-muerto`).
 */
export async function fetchCachedJson(context: FetchContext, requestKey: string, url: string): Promise<JsonResponse> {
  const { rows } = await context.client.query<{ url: string; status_code: number; payload: unknown; fetched_at: Date }>(`
    SELECT url, status_code, payload, fetched_at FROM ingest.genre_external_cache
     WHERE source_id = $1 AND request_key = $2`, [context.sourceId, requestKey]);
  const cached = rows[0];
  const ttlMs = context.ttlDays * 24 * 60 * 60 * 1000;
  if (cached && Date.now() - cached.fetched_at.getTime() < ttlMs) {
    if (context.stats) context.stats.cacheHits += 1;
    return { url: cached.url, status: cached.status_code, payload: cached.payload, fetchedAt: cached.fetched_at, cached: true };
  }
  if (context.offline) {
    if (cached) {
      // Vencida pero guardada: en modo sin red se usa igual y se dice.
      return { url: cached.url, status: cached.status_code, payload: cached.payload, fetchedAt: cached.fetched_at, cached: true };
    }
    throw new ExternalFetchError(url, 0, `sin caché para ${requestKey} y la importación va en modo solo caché`);
  }

  const response = await context.fetcher(url, context.headers);
  if (context.stats) context.stats.requests += 1;
  if (response.status >= 400) throw new ExternalFetchError(url, response.status, `HTTP ${response.status} en ${url}`);
  const saved = await context.client.query<{ fetched_at: Date }>(`
    INSERT INTO ingest.genre_external_cache(source_id, request_key, url, status_code, payload)
    VALUES($1,$2,$3,$4,$5::jsonb)
    ON CONFLICT (source_id, request_key) DO UPDATE
      SET url = EXCLUDED.url, status_code = EXCLUDED.status_code, payload = EXCLUDED.payload, fetched_at = now()
    RETURNING fetched_at`, [context.sourceId, requestKey, url, response.status, JSON.stringify(response.payload ?? null)]);
  return { url, status: response.status, payload: response.payload, fetchedAt: saved.rows[0]!.fetched_at, cached: false };
}
