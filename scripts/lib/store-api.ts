// CRV · Lo que comparten los cosechadores de tiendas (Bandcamp, Deezer,
// iTunes): normalización de nombres y títulos, etiquetas de catálogo que no son
// género y el cliente HTTP con el contacto de CRV en el User-Agent.
import { getEnv } from "../../src/config/env.js";
import { normalizeIdentitySecondary } from "../../src/normalization/claims.js";

/** Etiqueta de catálogo, no género: marca cualquier disco cantado en español (decisión de Brian, 2026-09-24). */
export const STORE_NOT_GENRE = new Set(["latin", "latino", "latin music", "musica latina", "worldwide", "world", "pop internacional", "international pop", "music", "musica"]);

export const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export const norm = (value: string): string => normalizeIdentitySecondary(value);
/** «Xanax [Single]», «Sonó Así - EP», «Vida (Remastered)» → el título a secas. */
export const bareTitle = (value: string): string =>
  norm(value.replace(/\s*[([][^)\]]*[)\]]\s*/gu, " ").replace(/\s+-\s+(EP|Single|LP)\s*$/iu, "").replace(/\s+(EP|LP)\s*$/u, ""));
export const yearOf = (value: unknown): number | null => {
  const match = /(\d{4})/u.exec(typeof value === "string" ? value : "");
  return match ? Number(match[1]) : null;
};
export const contact = (): string => getEnv().GENRES_EXTERNAL_CONTACT ?? "";

export async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20_000),
    headers: { "User-Agent": `CRV-generos/1.0 (${contact()})`, ...(init.headers ?? {}) } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return (await response.json()) as T;
}
