// CRV · Inicio de sesión de la Mesa de Cotejo con las cuentas de herra
// (PLAN_GENEROS etapa 3, punto 5).
//
// La Mesa usa la MISMA base de cuentas que CRV Catálogo: la SQLite de herra,
// abierta en solo lectura con la misma verificación scrypt y la misma
// `session_version` (src/api/herra-accounts.ts). No hay tabla propia de
// colaboradores ni copias de hashes: altas, bajas y contraseñas se gestionan
// en herra.
//
//  * LEER NO EXIGE SESIÓN. La Mesa sigue abierta en el tailnet para mirar.
//  * ESCRIBIR GÉNEROS SÍ. Sin sesión (o con una que herra invalidó) → 401; con
//    sesión de usuario aprobado pero sin rol de administrador → 403. Solo los
//    `admins` del proyecto y el superadministrador escriben.
//  * EL ACTOR ES LA SESIÓN. `herra:<usuario>`; el servidor ignora cualquier
//    nombre que mande el navegador. Las escrituras llevan el CSRF de la sesión
//    en `X-CRV-CSRF`, igual que el catálogo.
//  * Las demás escrituras de la Mesa (veredictos de careo) no cambian aquí:
//    extenderles este control queda fuera del alcance de la etapa 3.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { getEnv } from "../config/env.js";
import { HERRA_DUMMY_HASH, HerraAccounts, herraPasswordMatches, type HerraSessionRef } from "../api/herra-accounts.js";

export const COTEJO_SESSION_COOKIE = "crv_cotejo_session";
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 5;
const LOGIN_IP_MAX_FAILURES = 20;
const MAX_TRACKED = 20_000;

export interface CotejoUser {
  username: string;
  name: string;
  role: "admin" | "reader";
  /** Firma de las decisiones: `herra:<usuario>`. */
  actor: string;
}

interface Session extends CotejoUser {
  csrf: string;
  expiresAt: number;
  herra: HerraSessionRef;
}

export class CotejoAuthError extends Error {
  constructor(public readonly statusCode: 401 | 403 | 429 | 503, public readonly code: string, message: string) {
    super(message);
  }
}

function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(digest(left), digest(right));
}

function cookieValue(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function secure(request: FastifyRequest): string {
  return request.headers["x-forwarded-proto"] === "https" || request.protocol === "https" ? "; Secure" : "";
}

/** Mismo origen: la Mesa solo se llama desde su propia página. */
function trustedOrigin(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const forwarded = request.headers["x-forwarded-host"];
    return new URL(origin).host === (typeof forwarded === "string" ? forwarded : request.headers.host);
  } catch {
    return false;
  }
}

export interface CotejoAuth {
  /** Usuario de la sesión vigente, o `undefined`. Revalida contra herra en cada uso. */
  current(request: FastifyRequest): CotejoUser | undefined;
  /** Exige un administrador de herra con CSRF válido; lanza 401/403 si no. */
  requireAdmin(request: FastifyRequest): CotejoUser;
  /** Solo pruebas. */
  reset(): void;
}

export function registerCotejoAuth(app: FastifyInstance, options: { herra?: HerraAccounts } = {}): CotejoAuth {
  const env = getEnv();
  const herra = options.herra ?? (env.CRV_HERRA_DB_PATH ? new HerraAccounts(env.CRV_HERRA_DB_PATH, env.CRV_HERRA_PROJECT_SLUG) : undefined);
  const sessions = new Map<string, Session>();
  const failures = new Map<string, { count: number; resetAt: number }>();
  if (!options.herra) app.addHook("onClose", async () => herra?.close());

  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, session] of sessions) if (session.expiresAt <= now) sessions.delete(key);
    for (const [key, entry] of failures) if (entry.resetAt <= now) failures.delete(key);
  }, 5 * 60 * 1000);
  sweep.unref();
  app.addHook("onClose", async () => clearInterval(sweep));

  const limited = (key: string, max: number): boolean => {
    const entry = failures.get(key);
    if (!entry) return false;
    if (entry.resetAt <= Date.now()) {
      failures.delete(key);
      return false;
    }
    return entry.count >= max;
  };
  // Se cobra antes de gastar scrypt: una ráfaga en paralelo no se cuela.
  const charge = (key: string): void => {
    if (!failures.has(key) && failures.size >= MAX_TRACKED) return;
    const now = Date.now();
    const entry = failures.get(key);
    failures.set(key, entry && entry.resetAt > now ? { count: entry.count + 1, resetAt: entry.resetAt } : { count: 1, resetAt: now + LOGIN_WINDOW_MS });
  };

  const lookup = (request: FastifyRequest): { key: string; session: Session } | undefined => {
    const token = cookieValue(request, COTEJO_SESSION_COOKIE);
    if (!token) return undefined;
    const key = digest(token).toString("base64url");
    const session = sessions.get(key);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      sessions.delete(key);
      return undefined;
    }
    let valid: boolean;
    try {
      valid = herra?.stillValid(session.herra) ?? false;
    } catch {
      throw new CotejoAuthError(503, "accounts_unavailable", "Las cuentas de herra no están disponibles en este momento.");
    }
    if (!valid) {
      // Cuenta borrada, rechazada o con otra contraseña en herra.
      sessions.delete(key);
      return undefined;
    }
    return { key, session };
  };

  const publicUser = (session: Session): CotejoUser => ({
    username: session.username, name: session.name, role: session.role, actor: session.actor,
  });

  const auth: CotejoAuth = {
    current(request) {
      const found = lookup(request);
      return found ? publicUser(found.session) : undefined;
    },
    requireAdmin(request) {
      if (!trustedOrigin(request)) throw new CotejoAuthError(403, "untrusted_origin", "Origen no permitido.");
      const found = lookup(request);
      if (!found) throw new CotejoAuthError(401, "unauthorized", "Inicia sesión con tu cuenta de herra para decidir géneros.");
      const csrf = request.headers["x-crv-csrf"];
      if (typeof csrf !== "string" || !safeEqual(csrf, found.session.csrf)) {
        throw new CotejoAuthError(403, "invalid_csrf", "La sesión no pudo validarse. Recarga la página e inténtalo de nuevo.");
      }
      if (found.session.role !== "admin") {
        throw new CotejoAuthError(403, "admin_required", "Tu cuenta es de solo lectura: solo los administradores de herra deciden géneros.");
      }
      return publicUser(found.session);
    },
    reset() {
      sessions.clear();
      failures.clear();
    },
  };

  const fail = (reply: FastifyReply, error: CotejoAuthError) =>
    reply.code(error.statusCode).header("cache-control", "no-store").send({ error: error.message, code: error.code });

  app.post("/api/auth/login", async (request, reply) => {
    reply.header("cache-control", "no-store");
    if (!trustedOrigin(request)) return fail(reply, new CotejoAuthError(403, "untrusted_origin", "Origen no permitido."));
    if (!herra) return fail(reply, new CotejoAuthError(503, "accounts_disabled", "La Mesa no tiene configurada la base de cuentas de herra (CRV_HERRA_DB_PATH)."));
    const body = (request.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (username.length < 3 || username.length > 80 || !password || password.length > 200) {
      return reply.code(400).send({ error: "Escribe tu usuario y tu contraseña de herra." });
    }
    const ipKey = request.ip;
    const accountKey = `${ipKey}:${username}`;
    if (limited(ipKey, LOGIN_IP_MAX_FAILURES) || limited(accountKey, LOGIN_MAX_FAILURES)) {
      return fail(reply, new CotejoAuthError(429, "too_many_attempts", "Demasiados intentos. Espera 15 minutos antes de probar de nuevo."));
    }
    charge(ipKey);
    charge(accountKey);
    let candidates: ReturnType<HerraAccounts["findAll"]>;
    try {
      candidates = herra.findAll(username);
    } catch {
      return fail(reply, new CotejoAuthError(503, "accounts_unavailable", "Las cuentas de herra no están disponibles en este momento."));
    }
    let matched: (typeof candidates)[number] | undefined;
    if (!candidates.length) {
      // Mismo trabajo scrypt con o sin cuenta: el tiempo no delata usuarios.
      await herraPasswordMatches(password, HERRA_DUMMY_HASH);
    }
    for (const candidate of candidates) {
      if (await herraPasswordMatches(password, candidate.passwordHash)) {
        matched = candidate;
        break;
      }
    }
    if (!matched) {
      request.log.warn({ ip: request.ip, username }, "cotejo_login_failed");
      return fail(reply, new CotejoAuthError(401, "invalid_credentials", "Usuario o contraseña incorrectos."));
    }
    failures.delete(accountKey);
    const token = randomBytes(32).toString("base64url");
    const csrf = randomBytes(24).toString("base64url");
    const maxAge = env.CRV_SESSION_TTL_HOURS * 60 * 60;
    const session: Session = {
      username: matched.username, name: matched.name, role: matched.kind === "admin" ? "admin" : "reader",
      actor: `herra:${matched.username}`, csrf, expiresAt: Date.now() + maxAge * 1000,
      herra: { kind: matched.kind, id: matched.id, sessionVersion: matched.sessionVersion },
    };
    sessions.set(digest(token).toString("base64url"), session);
    reply.header("set-cookie", `${COTEJO_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure(request)}`);
    return { user: publicUser(session), csrf };
  });

  app.get("/api/auth/me", async (request, reply) => {
    reply.header("cache-control", "no-store");
    let found: ReturnType<typeof lookup>;
    try {
      found = lookup(request);
    } catch (error) {
      return fail(reply, error as CotejoAuthError);
    }
    if (!found) return reply.code(401).send({ error: "No hay una sesión activa.", code: "unauthorized" });
    return { user: publicUser(found.session), csrf: found.session.csrf };
  });

  app.post("/api/auth/logout", async (request, reply) => {
    const token = cookieValue(request, COTEJO_SESSION_COOKIE);
    if (token) sessions.delete(digest(token).toString("base64url"));
    reply.header("set-cookie", `${COTEJO_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure(request)}`);
    return reply.code(204).send();
  });

  return auth;
}
