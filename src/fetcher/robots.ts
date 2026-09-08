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
}

interface RobotsPolicy {
  rules: Rule[];
  fetchedAt: number;
}

const cache = new Map<string, RobotsPolicy>();
const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000; // 1 día, independiente del TTL de páginas

function parseRobotsTxt(text: string, userAgent: string): Rule[] {
  const lines = text.split(/\r?\n/);
  const groups: { agents: string[]; rules: Rule[] }[] = [];
  let current: { agents: string[]; rules: Rule[] } | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const sepIdx = line.indexOf(":");
    if (sepIdx === -1) continue;
    const field = line.slice(0, sepIdx).trim().toLowerCase();
    const value = line.slice(sepIdx + 1).trim();

    if (field === "user-agent") {
      if (!current || current.rules.length > 0) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if (field === "disallow" && current) {
      if (value !== "") current.rules.push({ path: value, allow: false });
      else current.rules.push({ path: "", allow: true }); // Disallow: vacío = permite todo
    } else if (field === "allow" && current) {
      current.rules.push({ path: value, allow: true });
    }
  }

  const ua = userAgent.toLowerCase();
  const specific = groups.find((g) => g.agents.some((a) => a !== "*" && ua.includes(a)));
  const wildcard = groups.find((g) => g.agents.includes("*"));
  return (specific ?? wildcard)?.rules ?? [];
}

async function getPolicy(origin: string): Promise<RobotsPolicy> {
  const cached = cache.get(origin);
  if (cached && Date.now() - cached.fetchedAt < ROBOTS_TTL_MS) return cached;

  const userAgent = getEnv().CRAWL_USER_AGENT;
  let rules: Rule[] = [];
  try {
    const res = await fetch(new URL("/robots.txt", origin), {
      headers: { "user-agent": userAgent },
      signal: AbortSignal.timeout(getEnv().CRAWL_TIMEOUT_MS),
    });
    if (res.ok) {
      rules = parseRobotsTxt(await res.text(), userAgent);
    } else {
      // 404 u otro error: sin reglas declaradas (p. ej. sincopa.com, SOURCES.md §3.2).
      log.info({ origin, status: res.status }, "robots.txt no disponible; se aplica cortesía propia sin reglas del sitio");
    }
  } catch (err) {
    log.warn({ origin, err }, "no se pudo obtener robots.txt; se aplica cortesía propia sin reglas del sitio");
  }

  const policy: RobotsPolicy = { rules, fetchedAt: Date.now() };
  cache.set(origin, policy);
  return policy;
}

/** true si la política del sitio permite acceder a `url` (fail-open si robots.txt no está disponible). */
export async function isAllowedByRobots(url: string): Promise<boolean> {
  const u = new URL(url);
  const policy = await getPolicy(u.origin);
  if (policy.rules.length === 0) return true;

  let best: Rule | null = null;
  for (const rule of policy.rules) {
    if (rule.path === "" || u.pathname.startsWith(rule.path)) {
      if (!best || rule.path.length > best.path.length) best = rule;
    }
  }
  return best ? best.allow : true;
}
