// CRV · Fichas de evaluación de fuentes externas desde archivo
// (PLAN_GENEROS etapa 4, entregable «ficha de evaluación y autorización»).
//
// El archivo es la evaluación revisable; cargarlo NO autoriza nada. La fuente
// queda como la ficha diga (por omisión `evaluating`) y autorizar, habilitar
// la importación y habilitar el volumen son decisiones humanas aparte.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseTagPolicy } from "./mapping.js";
import type { ExternalSourceSheet, ExternalSourceStatus } from "./store.js";

export const DEFAULT_SHEETS_FILE = path.resolve(process.cwd(), "data/genres/external-sources.json");

const ACCESS_MODES = new Set(["api", "dump", "sparql"]);
const LEVELS = new Set(["artist", "album", "both"]);
const STATUSES = new Set(["evaluating", "authorized", "blocked"]);

function requireText(value: unknown, field: string, slug: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`la ficha de «${slug}» no tiene ${field}`);
  return value.trim();
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function parseSheet(raw: unknown): ExternalSourceSheet {
  const row = (raw ?? {}) as Record<string, unknown>;
  const slug = requireText(row["slug"], "slug", String(row["slug"] ?? "?"));
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/u.test(slug)) throw new Error(`slug inválido en la ficha: «${slug}»`);
  const accessMode = requireText(row["accessMode"], "accessMode", slug);
  if (!ACCESS_MODES.has(accessMode)) throw new Error(`accessMode inválido en «${slug}»: ${accessMode}`);
  const levels = requireText(row["levels"], "levels", slug);
  if (!LEVELS.has(levels)) throw new Error(`levels inválido en «${slug}»: ${levels}`);
  const status = optionalText(row["status"]) ?? "evaluating";
  if (!STATUSES.has(status)) throw new Error(`status inválido en «${slug}»: ${status}`);
  const rate = Number(row["rateLimitPerMinute"] ?? 30);
  if (!Number.isFinite(rate) || rate <= 0) throw new Error(`rateLimitPerMinute inválido en «${slug}»`);
  const threshold = Number(row["precisionThreshold"] ?? 0.85);
  if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) throw new Error(`precisionThreshold inválido en «${slug}»`);
  return {
    slug,
    name: requireText(row["name"], "name", slug),
    homepage: optionalText(row["homepage"]),
    apiBase: optionalText(row["apiBase"]),
    accessMode: accessMode as ExternalSourceSheet["accessMode"],
    // Por qué ese acceso está permitido: la etapa 4 no admite raspar lo prohibido.
    accessNote: requireText(row["accessNote"], "accessNote", slug),
    license: requireText(row["license"], "license", slug),
    attribution: requireText(row["attribution"], "attribution", slug),
    termsUrl: optionalText(row["termsUrl"]),
    rateLimitPerMinute: Math.round(rate),
    levels: levels as ExternalSourceSheet["levels"],
    coverageNote: requireText(row["coverageNote"], "coverageNote", slug),
    identifierStability: requireText(row["identifierStability"], "identifierStability", slug),
    tagPolicy: parseTagPolicy(row["tagPolicy"]),
    status: status as ExternalSourceStatus,
    precisionThreshold: threshold,
    reason: requireText(row["reason"], "reason", slug),
  };
}

export async function loadSheetsFile(file: string = DEFAULT_SHEETS_FILE): Promise<ExternalSourceSheet[]> {
  const parsed = JSON.parse(await readFile(file, "utf8")) as { sources?: unknown };
  if (!Array.isArray(parsed.sources)) throw new Error(`${file} no tiene una lista «sources»`);
  return parsed.sources.map(parseSheet);
}
