// CRV · Autenticación de colaboradores.
//
// La SPA nunca recibe contraseñas, hashes ni una credencial reutilizable. El
// servidor verifica scrypt y entrega una sesión aleatoria en una cookie
// HttpOnly. Cada sesión queda ligada a una cuenta y las escrituras usan ese
// nombre para la auditoría. El bearer histórico se conserva exclusivamente
// para automatizaciones existentes y puede desactivarse quitándolo del .env.
//
// ROLES. Leer el catálogo es público. Todo lo demás —crear, editar, borrar,
// fusionar, comparar (previsualización de fusión), la cola de revisión y los
// posibles duplicados— exige una cuenta `admin`. Una cuenta `reader` inicia
// sesión pero ve lo mismo que un visitante anónimo. Son admin: los
// administradores y el superadministrador de herra, las cuentas del .env (salvo
// que declaren `"role":"reader"`) y el bearer de automatizaciones.
import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import { getEnv } from "../config/env.js";
import { HERRA_DUMMY_HASH, HerraAccounts, herraPasswordMatches, type HerraSessionRef } from "./herra-accounts.js";
import { ApiError } from "./http-errors.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Nombre de la cuenta autenticada con que se firma esta petición. */
    operator: string;
  }
}

export type AccountRole = "admin" | "reader";

export const OPERATOR_SECURITY = [{ collaboratorSession: [] }, { operatorToken: [] }];

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/**
 * Lecturas que no son catálogo público sino trabajo de curaduría: la cola de
 * revisión, los candidatos a duplicado y la comparación previa a fusionar.
 */
const ADMIN_READS = [
  /^\/review-queue(\/|$)/u,
  /^\/persons\/duplicate-candidates$/u,
  /^\/curation(\/|$)/u,
  /^\/[a-z]+\/\d+\/merge-preview$/u,
];
const OPERATOR_NAME = /^[\p{L}\p{N} ._'-]{1,80}$/u;
const USERNAME = /^[a-z0-9][a-z0-9._-]{2,39}$/u;
const SESSION_COOKIE = "crv_session";
const SESSION_BYTES = 32;
const CSRF_BYTES = 24;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
// Límite aparte por IP sola (sin importar la cuenta probada): sin esto, cada
// usuario nuevo probado desde la misma IP arranca con su propio cupo de 5 y
// un ataque de "spray" (muchas cuentas, pocos intentos cada una) no lo nota.
// Como no se borra al acertar, tampoco resetea el contador de una IP que ya
// venía probando cuentas ajenas.
const LOGIN_IP_MAX_FAILURES = 20;
// Techo de memoria: entradas colgadas caducan solas en el barrido, pero un
// atacante que pruebe miles de cuentas o IPs falsas antes de que corra podría
// inflar los mapas; a partir de este tamaño se deja de registrar intentos
// nuevos (los ya trackeados se siguen limitando con normalidad).
const MAX_TRACKED_LOGIN_KEYS = 20_000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

interface Collaborator {
  username: string;
  name: string;
  passwordHash: string;
  role: AccountRole;
}

interface Session {
  username: string;
  name: string;
  role: AccountRole;
  csrf: string;
  expiresAt: number;
  /** Presente si la cuenta viene de herra: se revalida en cada uso. */
  herra?: HerraSessionRef;
}

interface LoginFailures {
  count: number;
  resetAt: number;
}

const sessions = new Map<string, Session>();
const loginFailures = new Map<string, LoginFailures>();

// Limpieza periódica: sin esto, cada IP/cuenta probada (o cada sesión que
// expira sin que nadie vuelva a pedir /auth/me) se queda en memoria para
// siempre — una fuga lenta que además facilita agotar memoria a propósito.
setInterval(() => {
  const now = Date.now();
  for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
  for (const [key, failure] of loginFailures) if (failure.resetAt <= now) loginFailures.delete(key);
}, CLEANUP_INTERVAL_MS).unref();

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function bearer(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (typeof header !== "string") return undefined;
  return /^Bearer\s+(.+)$/iu.exec(header.trim())?.[1];
}

function cookies(request: FastifyRequest): Record<string, string> {
  const header = request.headers.cookie;
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    try {
      result[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      // Una cookie mal codificada no invalida las demás.
    }
  }
  return result;
}

function sessionFor(request: FastifyRequest): { key: string; value: Session } | undefined {
  const token = cookies(request)[SESSION_COOKIE];
  if (!token) return undefined;
  const key = digest(token).toString("base64url");
  const value = sessions.get(key);
  if (!value) return undefined;
  if (value.expiresAt <= Date.now()) {
    sessions.delete(key);
    return undefined;
  }
  return { key, value };
}

function cookieSecurity(request: FastifyRequest): string {
  const forwarded = request.headers["x-forwarded-proto"];
  return forwarded === "https" || request.protocol === "https" ? "; Secure" : "";
}

function setSessionCookie(reply: FastifyReply, request: FastifyRequest, token: string, maxAge: number): void {
  const path = getEnv().CRV_SESSION_COOKIE_PATH;
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${cookieSecurity(request)}`,
  );
}

function clearSessionCookie(reply: FastifyReply, request: FastifyRequest): void {
  const path = getEnv().CRV_SESSION_COOKIE_PATH;
  reply.header(
    "set-cookie",
    `${SESSION_COOKIE}=; Path=${path}; HttpOnly; SameSite=Strict; Max-Age=0${cookieSecurity(request)}`,
  );
}

/** Solo para tests: limpia sesiones y contadores entre casos (son estado de módulo). */
export function resetAuthStateForTests(): void {
  sessions.clear();
  loginFailures.clear();
}

function collaborators(): Map<string, Collaborator> {
  const raw = getEnv().CRV_COLLABORATORS_JSON;
  if (!raw) return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("CRV_COLLABORATORS_JSON no contiene JSON válido");
  }
  const schema = z.array(z.object({
    username: z.string().regex(USERNAME),
    name: z.string().trim().regex(OPERATOR_NAME),
    passwordHash: z.string().min(1),
    // Las cuentas del .env las crea quien opera el servidor: admin por defecto.
    role: z.enum(["admin", "reader"]).default("admin"),
  }).strict()).min(1).max(100);
  const accounts = schema.parse(parsed);
  const result = new Map<string, Collaborator>();
  for (const account of accounts) {
    const username = account.username.toLowerCase();
    if (result.has(username)) throw new Error(`cuenta colaboradora duplicada: ${username}`);
    result.set(username, { ...account, username });
  }
  return result;
}

async function passwordMatches(password: string, encoded: string): Promise<boolean> {
  const [algorithm, nRaw, rRaw, pRaw, saltRaw, expectedRaw, extra] = encoded.split("$");
  if (algorithm !== "scrypt" || extra !== undefined || !nRaw || !rRaw || !pRaw || !saltRaw || !expectedRaw) return false;
  const N = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(N) || N < 16_384 || N > 1_048_576 || (N & (N - 1)) !== 0) return false;
  if (!Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltRaw, "base64url");
    expected = Buffer.from(expectedRaw, "base64url");
  } catch {
    return false;
  }
  if (salt.length < 16 || expected.length < 32 || expected.length > 64) return false;
  const actual = await new Promise<Buffer>((resolve, reject) => {
    scryptCallback(password, salt, expected.length, { N, r, p, maxmem: Math.max(64 * 1024 * 1024, 256 * N * r) }, (error, derived) => {
      if (error) reject(error); else resolve(derived);
    });
  });
  return timingSafeEqual(actual, expected);
}

function assertBelowLimit(key: string, max: number): void {
  const failure = loginFailures.get(key);
  if (!failure) return;
  if (failure.resetAt <= Date.now()) {
    loginFailures.delete(key);
    return;
  }
  if (failure.count >= max) {
    throw new ApiError(429, "too_many_attempts", "Demasiados intentos. Espera 15 minutos antes de probar de nuevo.");
  }
}

/** Cuenta el intento como si fuera a fallar, antes de gastar tiempo en scrypt.
 * Si se comprobara solo al terminar, una ráfaga de peticiones en paralelo
 * pasaría el chequeo antes de que ninguna hubiera terminado de fallar. Un
 * login correcto revierte el cupo de esa cuenta con `forgiveLoginAttempt`. */
function chargeLoginAttempt(key: string): void {
  if (!loginFailures.has(key) && loginFailures.size >= MAX_TRACKED_LOGIN_KEYS) return;
  const now = Date.now();
  const current = loginFailures.get(key);
  loginFailures.set(key, current && current.resetAt > now
    ? { count: current.count + 1, resetAt: current.resetAt }
    : { count: 1, resetAt: now + LOGIN_WINDOW_MS });
}

function forgiveLoginAttempt(key: string): void {
  loginFailures.delete(key);
}

function isTrustedOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (getEnv().CRV_ALLOWED_ORIGINS.split(",").map((item) => item.trim()).filter(Boolean).includes(origin)) return true;
  try {
    const originUrl = new URL(origin);
    const forwardedHost = request.headers["x-forwarded-host"];
    const requestHost = typeof forwardedHost === "string" ? forwardedHost : request.headers.host;
    return originUrl.host === requestHost;
  } catch {
    return false;
  }
}

function assertTrustedOrigin(request: FastifyRequest): void {
  if (!isTrustedOrigin(request)) throw new ApiError(403, "untrusted_origin", "Origen no permitido.");
}

function noStore(reply: FastifyReply): void {
  reply.header("cache-control", "no-store");
}

const loginBody = z.object({
  username: z.string().trim().min(3).max(80),
  password: z.string().min(1).max(200),
}).strict();

export async function registerOperatorAuth(app: FastifyInstance): Promise<void> {
  const server = app.withTypeProvider<ZodTypeProvider>();
  const accounts = collaborators();
  const herraPath = getEnv().CRV_HERRA_DB_PATH;
  const herra = herraPath ? new HerraAccounts(herraPath, getEnv().CRV_HERRA_PROJECT_SLUG) : undefined;
  const loginEnabled = accounts.size > 0 || herra !== undefined;
  app.decorateRequest("operator", "");
  app.addHook("onClose", async () => herra?.close());

  /** Sesión activa, descartando las de cuentas que herra ya no habilita. */
  const activeSession = (request: FastifyRequest): { key: string; value: Session } | undefined => {
    const session = sessionFor(request);
    if (!session?.value.herra) return session;
    let valid: boolean;
    try {
      valid = herra?.stillValid(session.value.herra) ?? false;
    } catch (error) {
      request.log.error({ err: error }, "no se pudo consultar la base de herra");
      throw new ApiError(503, "accounts_unavailable", "Las cuentas no están disponibles en este momento. Inténtalo en unos minutos.");
    }
    if (valid) return session;
    sessions.delete(session.key);
    return undefined;
  };

  app.addHook("onRequest", async (request) => {
    const path = request.url.split("?", 1)[0]!;
    const isRead = READ_METHODS.has(request.method);
    if (path === "/auth/login" || (isRead && !ADMIN_READS.some((pattern) => pattern.test(path)))) return;
    if (!isRead) assertTrustedOrigin(request);

    const session = activeSession(request)?.value;
    if (session) {
      // Una lectura no lleva CSRF: la cookie SameSite=Strict ya la protege y
      // un GET no cambia nada.
      if (!isRead) {
        const csrf = request.headers["x-crv-csrf"];
        if (typeof csrf !== "string" || !safeEqual(csrf, session.csrf)) {
          throw new ApiError(403, "invalid_csrf", "La sesión no pudo validarse. Recarga la página e inténtalo de nuevo.");
        }
      }
      if (session.role !== "admin") {
        throw new ApiError(403, "admin_required", "Tu cuenta es de solo lectura. Editar, fusionar y revisar requiere una cuenta administradora.");
      }
      request.operator = session.name;
      return;
    }

    // Compatibilidad para scripts internos. La interfaz web no conoce ni
    // persiste este token; en producción se puede retirar tras la migración.
    const expected = getEnv().CRV_OPERATOR_TOKEN;
    const given = bearer(request);
    if (expected && given && safeEqual(given, expected)) {
      const declared = request.headers["x-crv-operator"];
      const name = typeof declared === "string" ? declared.trim() : "";
      if (name && !OPERATOR_NAME.test(name)) {
        throw new ApiError(400, "bad_request", "X-CRV-Operator admite letras, números, espacios y . _ ' - (máx. 80)");
      }
      request.operator = name || getEnv().CRV_OPERATOR_NAME;
      return;
    }

    if (!loginEnabled && !expected && !isRead) {
      throw new ApiError(403, "writes_disabled", "escritura deshabilitada: no hay cuentas de colaboradores configuradas");
    }
    throw new ApiError(401, "unauthorized", "Inicia sesión con una cuenta administradora.");
  });

  server.post("/auth/login", {
    schema: { tags: ["auth"], body: loginBody },
  }, async (request, reply) => {
    noStore(reply);
    assertTrustedOrigin(request);
    if (!loginEnabled) throw new ApiError(503, "accounts_disabled", "El servidor todavía no tiene cuentas de colaboradores configuradas.");
    const username = request.body.username.toLowerCase();
    const ipKey = request.ip;
    const accountKey = `${ipKey}:${username}`;
    assertBelowLimit(ipKey, LOGIN_IP_MAX_FAILURES);
    assertBelowLimit(accountKey, LOGIN_MAX_FAILURES);
    chargeLoginAttempt(ipKey);
    chargeLoginAttempt(accountKey);

    // Las cuentas del .env tienen prioridad; después se consulta herra.
    let account: { username: string; name: string; role: AccountRole } | undefined;
    let herraRef: HerraSessionRef | undefined;
    let valid: boolean;
    const local = accounts.get(username);
    if (local) {
      account = local;
      valid = await passwordMatches(request.body.password, local.passwordHash);
    } else {
      let candidates: ReturnType<HerraAccounts["findAll"]>;
      try {
        candidates = herra?.findAll(username) ?? [];
      } catch (error) {
        request.log.error({ err: error }, "no se pudo consultar la base de herra");
        throw new ApiError(503, "accounts_unavailable", "Las cuentas no están disponibles en este momento. Inténtalo en unos minutos.");
      }
      valid = false;
      if (candidates.length) {
        // En herra administra quien está en `admins`; un usuario aprobado solo
        // lee. La cuenta admin va primero: con su contraseña se entra como admin.
        for (const shared of candidates) {
          if (!await herraPasswordMatches(request.body.password, shared.passwordHash)) continue;
          account = { username: shared.username, name: shared.name, role: shared.kind === "admin" ? "admin" : "reader" };
          herraRef = { kind: shared.kind, id: shared.id, sessionVersion: shared.sessionVersion };
          valid = true;
          break;
        }
      } else {
        // Una cuenta inexistente hace el mismo trabajo scrypt que una existente:
        // el tiempo de respuesta no sirve para enumerar usuarios.
        await (herra
          ? herraPasswordMatches(request.body.password, HERRA_DUMMY_HASH)
          : passwordMatches(request.body.password, accounts.values().next().value!.passwordHash));
      }
    }
    if (!valid || !account) {
      // El intento ya quedó contado por chargeLoginAttempt; solo falta el
      // registro de auditoría (sin filtrar si la cuenta existe o no).
      request.log.warn({ ip: request.ip, username }, "login_failed");
      throw new ApiError(401, "invalid_credentials", "Usuario o contraseña incorrectos.");
    }
    // El acierto perdona el cupo de esa cuenta; el de la IP se deja intacto
    // para no premiar a quien ya venía probando cuentas ajenas desde ahí.
    forgiveLoginAttempt(accountKey);
    request.log.info({ ip: request.ip, username: account.username, source: herraRef ? "herra" : "local" }, "login_ok");
    const token = randomBytes(SESSION_BYTES).toString("base64url");
    const csrf = randomBytes(CSRF_BYTES).toString("base64url");
    const maxAge = getEnv().CRV_SESSION_TTL_HOURS * 60 * 60;
    sessions.set(digest(token).toString("base64url"), {
      username: account.username,
      name: account.name,
      role: account.role,
      csrf,
      expiresAt: Date.now() + maxAge * 1000,
      ...(herraRef ? { herra: herraRef } : {}),
    });
    setSessionCookie(reply, request, token, maxAge);
    return { user: { username: account.username, name: account.name, role: account.role }, csrf };
  });

  server.get("/auth/me", { schema: { tags: ["auth"] } }, async (request, reply) => {
    noStore(reply);
    const session = activeSession(request)?.value;
    if (!session) throw new ApiError(401, "unauthorized", "No hay una sesión activa.");
    return { user: { username: session.username, name: session.name, role: session.role }, csrf: session.csrf };
  });

  server.post("/auth/logout", { schema: { tags: ["auth"] } }, async (request, reply) => {
    noStore(reply);
    const session = sessionFor(request);
    if (session) sessions.delete(session.key);
    clearSessionCookie(reply, request);
    return reply.status(204).send();
  });

}
