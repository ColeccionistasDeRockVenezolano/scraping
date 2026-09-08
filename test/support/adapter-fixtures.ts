// Qué fixture representa a cada fuente, en un solo sitio. Estaba repetido en
// dos tests y un script, y al pasar CRV WordPress de JSON a HTML —su canal
// real es el sitemap, no una REST— los tres tenían que cambiar a la vez.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "adapters");

export const ADAPTER_SLUGS = [
  "descargas-metal-venezolano", "rockzuela", "rock-de-vzla", "hippito-y-sus-chatarritas",
  "rhv-blogspot", "rock-hecho-en-venezuela", "sincopa", "coleccionistas-de-rock-venezolano",
  "el-punk-en-venezuela",
] as const;

export type AdapterSlug = (typeof ADAPTER_SLUGS)[number];

export interface FixtureRef { file: string; url: string; kind: "html" | "json" }

/**
 * Sincopa tiene DOS tipos de ficha con estructuras distintas: la de artista
 * trae formación y miembros; la de disco trae pistas y créditos. Una sola no
 * cubre el contrato.
 */
const SINCOPA: FixtureRef[] = [
  { file: "sincopa.html", url: "https://fixture.invalid/rock_pop/artist_rock/los_kings.htm", kind: "html" },
  { file: "sincopa-album.html", url: "https://fixture.invalid/rock_pop/cdinfo_rock/fusion4_tarde.htm", kind: "html" },
];

/** Fuentes que se sirven como HTML y no como colección JSON. */
const HTML_SOURCES = new Set<string>(["coleccionistas-de-rock-venezolano"]);

export function fixturesFor(slug: AdapterSlug): FixtureRef[] {
  if (slug === "sincopa") return SINCOPA;
  const kind = HTML_SOURCES.has(slug) ? "html" : "json";
  return [{ file: `${slug}.${kind}`, url: `https://fixture.invalid/${slug}`, kind }];
}

export function siteTypeFor(slug: AdapterSlug): string {
  if (slug === "sincopa") return "database";
  return slug.includes("wordpress") || HTML_SOURCES.has(slug) ? "wordpress" : "blogspot";
}
