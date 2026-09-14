// CRV · gateway de producción mínimo para publicar la SPA bajo un prefijo
// Tailscale Funnel. Mantiene Fastify y PostgreSQL en loopback: solamente
// reenvía /crv/api/* al API local y sirve el build de Vite en /crv/*.
import http from "node:http";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const directory = path.dirname(fileURLToPath(import.meta.url));
const dist = path.join(directory, "dist");
const host = process.env.CRV_WEB_HOST ?? "127.0.0.1";
const port = Number(process.env.CRV_WEB_PORT ?? "3120");
const apiHost = process.env.CRV_API_HOST ?? "127.0.0.1";
const apiPort = Number(process.env.CRV_API_PORT ?? "8080");
const basePath = `/${(process.env.CRV_PUBLIC_PATH ?? "crv").replace(/^\/+|\/+$/g, "")}`;
const apiPath = `${basePath}/api`;

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon", ".jpeg": "image/jpeg", ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".png": "image/png", ".svg": "image/svg+xml", ".webp": "image/webp",
  ".woff2": "font/woff2",
};

function reply(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "x-content-type-options": "nosniff" });
  res.end(text);
}

function proxyApi(req, res, requestUrl) {
  const upstreamPath = `${requestUrl.pathname.slice(apiPath.length) || "/"}${requestUrl.search}`;
  const upstream = http.request({
    host: apiHost,
    port: apiPort,
    method: req.method,
    path: upstreamPath,
    headers: { ...req.headers, host: `${apiHost}:${apiPort}`, "x-forwarded-proto": "https" },
  }, (upstreamResponse) => {
    res.writeHead(upstreamResponse.statusCode ?? 502, { ...upstreamResponse.headers, "x-content-type-options": "nosniff" });
    upstreamResponse.pipe(res);
  });
  upstream.on("error", () => reply(res, 502, "La API CRV no está disponible."));
  req.pipe(upstream);
}

async function serveFile(req, res, pathname) {
  if (req.method !== "GET" && req.method !== "HEAD") return reply(res, 405, "Método no permitido.");
  let relativePath;
  try { relativePath = decodeURIComponent(pathname.slice(basePath.length)).replace(/^\/+/, ""); }
  catch { return reply(res, 400, "Ruta inválida."); }
  if (relativePath.split("/").includes("..")) return reply(res, 403, "Ruta no permitida.");

  const requested = path.join(dist, relativePath || "index.html");
  let file = requested;
  try {
    if (!(await stat(file)).isFile()) throw new Error("not-a-file");
  } catch {
    // Las rutas del router de React no son archivos: devuelven la SPA.
    if (path.extname(relativePath)) return reply(res, 404, "Archivo no encontrado.");
    file = path.join(dist, "index.html");
  }

  const ext = path.extname(file).toLowerCase();
  const headers = {
    "content-type": MIME_TYPES[ext] ?? "application/octet-stream",
    "x-content-type-options": "nosniff",
    ...(file.includes(`${path.sep}assets${path.sep}`) ? { "cache-control": "public, max-age=31536000, immutable" } : { "cache-control": "no-cache" }),
  };
  res.writeHead(200, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? host}`);
  // Funnel elimina el prefijo configurado antes de enviar la petición al
  // destino local. Para pruebas directas también aceptamos la ruta completa.
  const virtualPath = requestUrl.pathname === basePath || requestUrl.pathname.startsWith(`${basePath}/`)
    ? requestUrl.pathname
    : `${basePath}${requestUrl.pathname}`;
  const virtualUrl = new URL(requestUrl);
  virtualUrl.pathname = virtualPath;
  if (virtualUrl.pathname === apiPath || virtualUrl.pathname.startsWith(`${apiPath}/`)) return proxyApi(req, res, virtualUrl);
  return serveFile(req, res, virtualUrl.pathname);
});

server.listen(port, host, () => console.log(`CRV público local: http://${host}:${port}${basePath}/`));
server.on("error", (error) => { console.error(error); process.exitCode = 1; });
