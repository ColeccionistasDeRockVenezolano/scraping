// CRV · Caché de páginas crudas sobre ingest.raw_pages (ARCHITECTURE.md
// §4.2). Dos invariantes reales de la tabla (migrations/0001) que este
// módulo respeta:
//   - UNIQUE(source_id, canonical_url) NO existe: la unicidad real es
//     UNIQUE(source_id, sha256) — dedupe por CONTENIDO, no por URL.
//   - Por eso, si una URL ya fetched produce el MISMO contenido de una fila
//     existente (misma fuente), no se inserta una fila nueva: se actualiza
//     `fetched_at` de la fila existente. Si la misma URL cambia de
//     contenido, se inserta una fila nueva (histórico append-only) y la
//     comprobación de frescura (por url/canonical_url, ORDER BY fetched_at
//     DESC) recoge la más reciente.
//   - Límite documentado: si una URL distinta produce bytes idénticos a los
//     de otra URL ya almacenada, la fila existente (con la URL original) es
//     la que se actualiza; la nueva URL no queda con fila propia hasta que
//     produzca contenido distinto. No hay pérdida de datos ni fallo, solo
//     una re-descarga redundante ocasional — trade-off aceptado.
import { createHash } from "node:crypto";
import { and, desc, eq, or } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { rawPages, sources } from "../db/schema/ingest.js";
import { politeFetch, type FetchResult } from "../fetcher/http.js";
import { storeRawPage } from "../storage/raw.js";
import { getEnv } from "../config/env.js";
import { moduleLogger } from "../logger/index.js";

const log = moduleLogger("cache:raw-pages");

export interface CachedFetch {
  cached: boolean;
  rawPageId: number;
  storedPath: string;
  status: number;
  sha256: string;
}

async function findFreshRow(sourceId: number, url: string, ttlMs: number) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(rawPages)
    .where(and(eq(rawPages.sourceId, sourceId), or(eq(rawPages.url, url), eq(rawPages.canonicalUrl, url))))
    .orderBy(desc(rawPages.fetchedAt))
    .limit(1);
  if (!row) return null;
  const age = Date.now() - row.fetchedAt.getTime();
  return age < ttlMs ? row : null;
}

/**
 * Descarga (respetando robots/cortesía/reintentos) o reutiliza del caché.
 * `ttlDays` por defecto viene de CRAWL_CACHE_TTL_DAYS (7 días, páginas
 * estáticas). No hace ninguna extracción: solo garantiza que el crudo esté
 * en disco y registrado en ingest.raw_pages.
 */
export async function fetchAndCache(sourceSlug: string, url: string, ttlDays?: number): Promise<CachedFetch> {
  const db = getDb();
  const [source] = await db.select().from(sources).where(eq(sources.slug, sourceSlug));
  if (!source) throw new Error(`fuente desconocida: ${sourceSlug}`);
  if (!source.enabled) throw new Error(`fuente deshabilitada: ${sourceSlug} (enabled=false)`);

  const ttlMs = (ttlDays ?? getEnv().CRAWL_CACHE_TTL_DAYS) * 24 * 60 * 60 * 1000;

  const fresh = await findFreshRow(source.id, url, ttlMs);
  if (fresh) {
    log.info({ sourceSlug, url }, "cache hit (dentro de TTL, sin petición de red)");
    return { cached: true, rawPageId: fresh.id, storedPath: fresh.storedPath, status: fresh.httpStatus ?? 0, sha256: fresh.sha256 };
  }

  const result: FetchResult = await politeFetch(url);
  const sha256 = createHash("sha256").update(result.body).digest("hex");
  const stored = await storeRawPage(sourceSlug, sha256, result.body, result.headers, result.contentType);

  const [byContent] = await db
    .select()
    .from(rawPages)
    .where(and(eq(rawPages.sourceId, source.id), eq(rawPages.sha256, sha256)));

  if (byContent) {
    await db.update(rawPages).set({ fetchedAt: result.fetchedAt }).where(eq(rawPages.id, byContent.id));
    log.info({ sourceSlug, url, sha256 }, "contenido ya almacenado (dedupe por hash); fetched_at actualizado");
    return { cached: false, rawPageId: byContent.id, storedPath: byContent.storedPath, status: result.status, sha256 };
  }

  const [inserted] = await db.insert(rawPages).values({
    sourceId: source.id,
    url,
    canonicalUrl: result.finalUrl,
    httpStatus: result.status,
    contentType: result.contentType,
    sha256,
    byteSize: result.body.byteLength,
    storedPath: stored.storedPath,
    fetchedAt: result.fetchedAt,
    headers: result.headers,
  }).returning();
  if (!inserted) throw new Error("no se pudo registrar ingest.raw_pages");

  log.info({ sourceSlug, url, status: result.status, bytes: result.body.byteLength }, "descargado y almacenado");
  return { cached: false, rawPageId: inserted.id, storedPath: inserted.storedPath, status: result.status, sha256 };
}
