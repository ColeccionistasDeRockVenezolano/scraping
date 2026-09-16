// CRV · Reintentos y cortesía del fetcher (ARCHITECTURE §4.1, auditoría E11).
// Contra un servidor HTTP local: backoff exponencial sobre 5xx/429, 4xx sin
// reintento, FetchFailedError al agotar los intentos, User-Agent propio, una
// petición a la vez por fuente y la demora mínima entre peticiones.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { resetEnvCache } from "../../src/config/env.js";
import { FetchFailedError, politeFetch } from "../../src/fetcher/http.js";

const ENV_KEYS = ["CRAWL_USER_AGENT", "CRAWL_DELAY_MS", "CRAWL_MAX_RETRIES"] as const;

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  Object.assign(process.env, values);
  resetEnvCache();
}

describe("politeFetch: reintentos y cortesía", () => {
  const original = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  // Respuestas programadas por ruta; la última se repite.
  const scripts: Record<string, number[]> = {
    "/flaky": [503, 429, 200],
    "/missing": [404],
    "/down": [500],
  };
  const hits = new Map<string, number>();
  const arrivals: { path: string; at: number; userAgent: string | undefined }[] = [];
  let inFlight = 0;
  let maxInFlight = 0;
  let server: Server;
  let baseUrl: string;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const path = (req.url ?? "/").split("?")[0] ?? "/";
      if (path === "/robots.txt") {
        res.writeHead(404);
        res.end();
        return;
      }
      const count = (hits.get(path) ?? 0) + 1;
      hits.set(path, count);
      arrivals.push({ path, at: Date.now(), userAgent: req.headers["user-agent"] });
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const script = scripts[path] ?? [200];
      const status = script[Math.min(count, script.length) - 1] ?? 200;
      // Respuesta lenta: si el fetcher solapara peticiones, se verían dos a la vez.
      setTimeout(() => {
        inFlight -= 1;
        res.writeHead(status, { "content-type": "text/plain" });
        res.end(`${path} #${count}`);
      }, 40);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("sin dirección de servidor");
    baseUrl = `http://127.0.0.1:${address.port}`;
    setEnv({ CRAWL_USER_AGENT: "CRV-test/11", CRAWL_DELAY_MS: "0" });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const [key, value] of original) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetEnvCache();
  });

  it("reintenta 503 y 429 con backoff exponencial y devuelve la respuesta buena", async () => {
    setEnv({ CRAWL_MAX_RETRIES: "3" });
    const started = Date.now();
    const result = await politeFetch(`${baseUrl}/flaky`, "e11-flaky");
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe("/flaky #3");
    expect(hits.get("/flaky")).toBe(3);
    // 1 s antes del segundo intento y 2 s antes del tercero.
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
  });

  it("un 404 no se reintenta: una sola petición y el status llega a quien llama", async () => {
    setEnv({ CRAWL_MAX_RETRIES: "3" });
    const result = await politeFetch(`${baseUrl}/missing`, "e11-missing");
    expect(result.status).toBe(404);
    expect(hits.get("/missing")).toBe(1);
  });

  it("agota los reintentos con FetchFailedError", async () => {
    setEnv({ CRAWL_MAX_RETRIES: "1" });
    const error: unknown = await politeFetch(`${baseUrl}/down`, "e11-down").catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FetchFailedError);
    expect((error as FetchFailedError).retryCount).toBe(1);
    expect(hits.get("/down")).toBe(2);
  });

  it("identifica al bot y nunca solapa dos peticiones de la misma fuente", async () => {
    setEnv({ CRAWL_MAX_RETRIES: "0", CRAWL_DELAY_MS: "0" });
    arrivals.length = 0;
    maxInFlight = 0;
    await Promise.all(["/serial-a", "/serial-b", "/serial-c"].map((path) => politeFetch(`${baseUrl}${path}`, "e11-serial")));
    expect(maxInFlight).toBe(1);
    expect(arrivals.map((arrival) => arrival.userAgent)).toEqual(["CRV-test/11", "CRV-test/11", "CRV-test/11"]);
  });

  it("respeta CRAWL_DELAY_MS entre peticiones consecutivas de la misma fuente", async () => {
    setEnv({ CRAWL_MAX_RETRIES: "0", CRAWL_DELAY_MS: "250" });
    arrivals.length = 0;
    await Promise.all(["/gap-a", "/gap-b", "/gap-c"].map((path) => politeFetch(`${baseUrl}${path}`, "e11-delay")));
    const gaps = arrivals.slice(1).map((arrival, index) => arrival.at - (arrivals[index]?.at ?? 0));
    expect(gaps).toHaveLength(2);
    // Margen para la resolución del temporizador; sin la demora serían ~40 ms.
    for (const gap of gaps) expect(gap).toBeGreaterThanOrEqual(230);
  });
});
