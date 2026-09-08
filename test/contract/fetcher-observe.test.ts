// CRV · Test de contrato F1: fetcher + cache + storage + observe, contra
// un servidor Blogger simulado (sin depender del sitio real; sincopa.com/
// blogspot en vivo se validaron manualmente, ver docs/PHASES.md F1) y un
// PostgreSQL desechable. Cubre los dos criterios de salida de F1:
//   1. barrido de observación completo sobre una fuente (paginación real
//      del feed hasta agotar openSearch$totalResults);
//   2. re-descarga dentro del TTL = 0 peticiones nuevas (cache verificada).
// Además ejercita el dedupe por contenido documentado en
// src/cache/raw-pages.ts (misma URL, mismo contenido -> no inserta fila
// nueva, actualiza fetched_at) y el respeto de robots.txt (Disallow real).
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { startPgContainer, type PgContainer } from "../support/pg-container.js";
import { applyCore } from "../support/apply-core.js";
import { resetEnvCache } from "../../src/config/env.js";
import { closeDb, getDb } from "../../src/db/client.js";
import { migrateUp } from "../../src/db/migrate.js";
import { sources, rawPages } from "../../src/db/schema/ingest.js";
import { fetchAndCache } from "../../src/cache/raw-pages.js";
import { runObserve } from "../../src/fetcher/observe.js";
import { RobotsDisallowedError, politeFetch } from "../../src/fetcher/http.js";

const TOTAL_ENTRIES = 30; // 2 páginas con max-results=25 (25 + 5)

function feedPage(startIndex: number, total: number) {
  const remaining = Math.max(0, total - (startIndex - 1));
  const count = Math.min(25, remaining);
  return JSON.stringify({
    feed: {
      "openSearch$totalResults": { $t: String(total) },
      entry: Array.from({ length: count }, (_, i) => ({ title: { $t: `post-${startIndex + i}` } })),
    },
  });
}

describe("fetcher + cache + observe (F1)", () => {
  let container: PgContainer;
  let server: Server;
  let baseUrl: string;
  let requestLog: string[];
  let dataDir: string;
  let sameContentEachTime: boolean;

  beforeAll(async () => {
    requestLog = [];
    sameContentEachTime = false;
    container = await startPgContainer();

    server = createServer((req, res) => {
      const url = req.url ?? "/";
      requestLog.push(url);
      if (url === "/robots.txt") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("User-agent: *\nDisallow: /prohibido/\n");
        return;
      }
      if (url === "/prohibido/pagina") {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("no debería llegar aquí");
        return;
      }
      const m = /start-index=(\d+)/.exec(url);
      const startIndex = m ? Number(m[1]) : 1;
      res.writeHead(200, { "content-type": "application/json" });
      // Para el test de dedupe por contenido: si sameContentEachTime está
      // activo, la página 1 siempre devuelve el mismo cuerpo exacto.
      res.end(sameContentEachTime ? feedPage(1, TOTAL_ENTRIES) : feedPage(startIndex, TOTAL_ENTRIES));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("sin dirección de servidor");
    baseUrl = `http://127.0.0.1:${address.port}`;

    dataDir = await mkdtemp(path.join(tmpdir(), "crv-data-"));
    process.env["DATABASE_URL"] = container.databaseUrl;
    process.env["DATA_DIR"] = dataDir;
    process.env["CRAWL_DELAY_MS"] = "0"; // sin demora artificial en el test
    resetEnvCache();

    await applyCore(container.name);
    await migrateUp();
  }, 120_000);

  afterAll(async () => {
    await closeDb();
    await container.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  }, 60_000);

  afterEach(() => {
    requestLog = [];
    sameContentEachTime = false;
  });

  it("robots.txt real: bloquea la ruta con Disallow, permite el resto", async () => {
    await expect(politeFetch(`${baseUrl}/prohibido/pagina`)).rejects.toThrow(RobotsDisallowedError);
    const res = await politeFetch(`${baseUrl}/feeds/posts/default?alt=json&max-results=25&start-index=1`);
    expect(res.status).toBe(200);
  });

  it("registra la fuente de prueba (blogspot) en ingest.sources", async () => {
    const db = getDb();
    await db.insert(sources).values({
      slug: "mock-blogspot",
      name: "Mock Blogger",
      url: baseUrl,
      siteType: "blogspot",
      trustLevel: "low",
      enabled: true,
    });
    const [row] = await db.select().from(sources).where(eq(sources.slug, "mock-blogspot"));
    expect(row?.enabled).toBe(true);
  });

  it("barrido de observación completo: pagina hasta agotar openSearch$totalResults", async () => {
    requestLog = [];
    const result = await runObserve("mock-blogspot");
    expect(result.totalEntries).toBe(TOTAL_ENTRIES);
    expect(result.pagesSwept).toBe(2); // 25 + 5
    expect(result.fetched).toBe(2);
    expect(result.cached).toBe(0);
    expect(result.errors).toBe(0);
    // Ninguna petición al path prohibido durante el barrido normal.
    expect(requestLog.some((u) => u.includes("/prohibido/"))).toBe(false);
  });

  it("re-descarga dentro del TTL: 0 peticiones nuevas al servidor", async () => {
    requestLog = [];
    const result = await runObserve("mock-blogspot");
    expect(result.fetched).toBe(0);
    expect(result.cached).toBe(2);
    // La prueba definitiva de "0 peticiones nuevas": el servidor no recibió
    // NINGÚN request HTTP (ni siquiera para las páginas ya conocidas).
    expect(requestLog).toEqual([]);
  });

  it("dedupe por contenido: misma URL + mismo contenido tras vencer el TTL -> no inserta fila nueva", async () => {
    const db = getDb();
    const [source] = await db.select().from(sources).where(eq(sources.slug, "mock-blogspot"));
    if (!source) throw new Error("fuente de prueba no encontrada");

    const url = `${baseUrl}/feeds/posts/default?alt=json&max-results=25&start-index=1`;
    const before = await db.select().from(rawPages).where(eq(rawPages.sourceId, source.id));
    const countBefore = before.length;

    sameContentEachTime = true;
    // ttlDays=0 fuerza a tratar cualquier fila existente como vencida.
    const result = await fetchAndCache("mock-blogspot", url, 0);
    expect(result.cached).toBe(false); // hubo petición de red (TTL vencido)

    const after = await db.select().from(rawPages).where(eq(rawPages.sourceId, source.id));
    expect(after.length).toBe(countBefore); // sin fila nueva: mismo contenido -> mismo sha256
  });
});
