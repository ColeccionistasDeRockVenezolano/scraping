// CRV · robots.txt (ARCHITECTURE.md §4.1: "Respeto de robots.txt"). Parser
// mínimo pero correcto: agrupa por User-agent, aplica el algoritmo de
// "regla más específica gana" (Allow/Disallow por longitud de path
// coincidente), igual que los crawlers de referencia. Caché en memoria por
// origin durante el proceso (suficiente para F1: un run de CLI es un
// proceso corto; no necesita persistencia entre ejecuciones separadas).
import { moduleLogger } from "../logger/index.js";
import { getEnv } from "../config/env.js";

const log = moduleLogger("fetcher:robots");

interface Rule {
  path: string;
  allow: boolean;
  pattern: RegExp;
  specificity: number;
}

interface RobotsPolicy {
  rules: Rule[];
  crawlDelayMs: number | null;
  sitemaps: string[];
  /** false solo ante error transitorio/red/5xx: se bloquea por seguridad. */
  available: boolean;
  fetchedAt: number;
}

const cache = new Map<string, RobotsPolicy>();
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000; // 1 día, independiente del TTL de páginas

interface ParsedRobots {
  rules: Rule[];
  crawlDelayMs: number | null;
  sitemaps: string[];
}

function compilePattern(value: string): { pattern: RegExp; specificity: number } {
  const anchored = value.endsWith("$");
  const body = anchored ? value.slice(0, -1) : value;
  const escaped = body.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return {
    pattern: new RegExp(`^${escaped}${anchored ? "$" : ""}`),
    specificity: body.replace(/\*/g, "").length,
  };
}

function parseRobotsTxt(text: string, userAgent: string): ParsedRobots {
  const lines = text.split(/\r?\n/);
  const groups: { agents: string[]; rules: Rule[]; crawlDelayMs: number | null }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[]; crawlDelayMs: number | null } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sepIdx = line.indexOf(":");
    if (sepIdx === -1) continue;
    const field = line.slice(0, sepIdx).trim().toLowerCase();
    const value = line.slice(sepIdx + 1).trim();

    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [], crawlDelayMs: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "disallow" && current) {
      if (value !== "") current.rules.push({ path: value, allow: false, ...compilePattern(value) });
    } else if (field === "allow" && current) {
      current.rules.push({ path: value, allow: true, ...compilePattern(value) });
    } else if (field === "crawl-delay" && current) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelayMs = Math.ceil(seconds * 1000);
    } else if (field === "sitemap" && value) {
      sitemaps.push(value);
    }
  }

  const ua = userAgent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  const selected = specific ?? wildcard;
  return {
    rules: selected?.rules ?? [],
    crawlDelayMs: selected?.crawlDelayMs ?? null,
    sitemaps,
  };
}

async function getPolicy(origin: string): Promise<RobotsPolicy> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached;

  const userAgent = getEnv().CRAWL_USER_AGENT;
  let rules: Rule[] = [];
  let crawlDelayMs: number | null = null;
  let sitemaps: string[] = [];
  let available = true;
  try {
    const res = await fetch(new URL("/robots.txt", origin), {
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(getEnv().CRAWL_TIMEOUT_MS),
    });
    if (res.ok) {
      ({ rules, crawlDelayMs, sitemaps } = parseRobotsTxt(await res.text(), userAgent));
    } else if (res.status >= 400 && res.status < 500 && res.status !== 429) {
      // 404/4xx permanente = no hay política publicada (caso Sincopa).
      log.info({ origin, status: res.status }, "robots.txt no disponible; se aplica cortesía propia sin reglas del sitio");
    } else {
      available = false;
      log.warn({ origin, status: res.status }, "robots.txt temporalmente inaccesible; acceso bloqueado por seguridad");
    }
  } catch (err) {
    available = false;
    log.warn({ origin, err }, "no se pudo obtener robots.txt; acceso bloqueado por seguridad");
  }

  const policy: RobotsPolicy = { rules, crawlDelayMs, sitemaps, available, fetchedAt: Date.now() };
  cache.set(origin, policy);
  return policy;
}

/** true si la política del sitio permite acceder a `url`; fallos transitorios son fail-closed. */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  const u = new URL(url);
  const policy = await getPolicy(u.origin);
  if (!policy.available) return false;
  if (policy.rules.length === 0) return true;

  let best: Rule | null = null;
  for (const rule of policy.rules) {
    const target = `${u.pathname}${u.search}`;
    if (rule.pattern.test(target)) {
      if (!best || rule.specificity > best.specificity ||
          (rule.specificity === best.specificity && rule.allow)) best = rule;
    }
  }
  return best ? best.allow : true;
}

/** Demora declarada por el sitio; el fetcher aplica el mayor valor entre esta y la cortesía local. */
export async function getRobotsCrawlDelay(url: string): Promise<number> {
  return (await getPolicy(new URL(url).origin)).crawlDelayMs ?? 0;
}

/** Sitemaps declarados, disponibles para construir frontiers posteriores. */
export async function getRobotsSitemaps(url: string): Promise<string[]> {
  return [...(await getPolicy(new URL(url).origin)).sitemaps];
}
