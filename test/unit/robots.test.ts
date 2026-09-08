// CRV · Unit: src/fetcher/robots.ts contra un servidor HTTP local (sin red
// real), cubriendo el algoritmo de "regla más específica gana" y el
// fail-open cuando robots.txt no existe (caso real: sincopa.com, 404).
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { getRobotsCrawlDelay, getRobotsSitemaps, isAllowedByRobots } from "../../src/fetcher/robots.js";

let server: Server;
let baseUrl: string;
let responder: (path: string) => { status: number; body: string };

beforeEach(async () => {
  server = createServer((req, res) => {
    const { status, body } = responder(req.url ?? "/");
    res.writeHead(status, { "content-type": "text/plain" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address !== "object" || address === null) throw new Error("sin dirección de servidor");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("isAllowedByRobots", () => {
  it("permite todo cuando robots.txt responde 404 (caso real: sincopa.com)", async () => {
    responder = (path) => (path === "/robots.txt" ? { status: 404, body: "" } : { status: 200, body: "ok" });
    await expect(isAllowedByRobots(`${baseUrl}/cualquier-cosa`)).resolves.toBe(true);
  });

  it("bloquea por seguridad si robots.txt falla temporalmente", async () => {
    responder = (path) => path === "/robots.txt"
      ? { status: 503, body: "temporal" }
      : { status: 200, body: "ok" };
    await expect(isAllowedByRobots(`${baseUrl}/cualquier-cosa`)).resolves.toBe(false);
  });

  it("bloquea un path bajo Disallow para *", async () => {
    responder = (path) =>
      path === "/robots.txt"
        ? { status: 200, body: "User-agent: *\nDisallow: /privado/\n" }
        : { status: 200, body: "ok" };
    await expect(isAllowedByRobots(`${baseUrl}/privado/x`)).resolves.toBe(false);
    await expect(isAllowedByRobots(`${baseUrl}/publico/x`)).resolves.toBe(true);
  });

  it("una regla Allow más específica gana sobre un Disallow más general", async () => {
    responder = (path) =>
      path === "/robots.txt"
        ? { status: 200, body: "User-agent: *\nDisallow: /feeds/\nAllow: /feeds/posts/default\n" }
        : { status: 200, body: "ok" };
    await expect(isAllowedByRobots(`${baseUrl}/feeds/posts/default`)).resolves.toBe(true);
    await expect(isAllowedByRobots(`${baseUrl}/feeds/otra-cosa`)).resolves.toBe(false);
  });

  it("ignora comentarios y líneas vacías", async () => {
    responder = (path) =>
      path === "/robots.txt"
        ? { status: 200, body: "# comentario\n\nUser-agent: *\n# otro comentario\nDisallow: /x\n" }
        : { status: 200, body: "ok" };
    await expect(isAllowedByRobots(`${baseUrl}/x`)).resolves.toBe(false);
    await expect(isAllowedByRobots(`${baseUrl}/y`)).resolves.toBe(true);
  });

  it("interpreta comodines y el ancla $ sobre path + query", async () => {
    responder = (path) =>
      path === "/robots.txt"
        ? { status: 200, body: "User-agent: *\nDisallow: /*?preview=true$\nDisallow: /tmp/*.pdf$\n" }
        : { status: 200, body: "ok" };
    await expect(isAllowedByRobots(`${baseUrl}/post?preview=true`)).resolves.toBe(false);
    await expect(isAllowedByRobots(`${baseUrl}/post?preview=true&x=1`)).resolves.toBe(true);
    await expect(isAllowedByRobots(`${baseUrl}/tmp/catalogo.pdf`)).resolves.toBe(false);
    await expect(isAllowedByRobots(`${baseUrl}/tmp/catalogo.pdf?download=1`)).resolves.toBe(true);
  });

  it("expone Crawl-delay y Sitemap de la política seleccionada", async () => {
    responder = (path) =>
      path === "/robots.txt"
        ? { status: 200, body: `Sitemap: ${baseUrl}/sitemap.xml\nUser-agent: *\nCrawl-delay: 1.5\n` }
        : { status: 200, body: "ok" };
    await expect(getRobotsCrawlDelay(`${baseUrl}/x`)).resolves.toBe(1500);
    await expect(getRobotsSitemaps(`${baseUrl}/x`)).resolves.toEqual([`${baseUrl}/sitemap.xml`]);
  });
});
