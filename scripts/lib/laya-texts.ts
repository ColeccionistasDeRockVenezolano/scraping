// CRV · Textos de las capturas locales para géneros: índice de posts
// (Blogger/WordPress), prosa sin tracklists y menciones de géneros con la
// taxonomía. Lo comparten los expedientes de Laya y las frases de banda.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { normalizeGenreText } from "../../src/genres/normalize.js";
import type { Taxonomy } from "../../src/genres/taxonomy.js";

export const TEXT_SOURCES = ["rock-de-vzla", "rockzuela", "hippito-y-sus-chatarritas", "rhv-blogspot",
  "coleccionistas-de-rock-venezolano", "descargas-metal-venezolano", "el-punk-en-venezuela", "rock-hecho-en-venezuela"];

export function plain(html: string): string {
  return html.replace(/<br\s*\/?>/giu, "\n").replace(/<\/p>/giu, "\n").replace(/<[^>]+>/gu, " ")
    .replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").replace(/&quot;/gu, "\"").replace(/&#39;/gu, "'")
    .replace(/&[a-z]+;|&#\d+;/giu, " ").replace(/[ \t]+/gu, " ").replace(/\n\s*\n+/gu, "\n").trim();
}

export function canonical(url: string): string {
  return url.replace(/^https?:\/\//u, "").replace(/^www\./u, "").replace(/[?#].*$/u, "").replace(/\/+$/u, "").toLowerCase();
}

/** URL del post → texto, desde las capturas JSON (feeds de Blogger y API de WordPress). */
export function indexPosts(dataDir: string): Map<string, string> {
  const posts = new Map<string, string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    const item = node as Record<string, unknown>;
    // Blogger: entry.link[rel=alternate].href + entry.content.$t
    if (Array.isArray(item["link"]) && item["content"] && typeof item["content"] === "object") {
      const alt = (item["link"] as Array<Record<string, string>>).find((link) => link["rel"] === "alternate");
      const body = (item["content"] as Record<string, unknown>)["$t"];
      const title = (item["title"] as Record<string, unknown> | undefined)?.["$t"];
      if (alt?.["href"] && typeof body === "string") posts.set(canonical(alt["href"]), `${typeof title === "string" ? `${title}\n` : ""}${plain(body)}`);
    }
    // WordPress: link + content.rendered
    if (typeof item["link"] === "string" && item["content"] && typeof item["content"] === "object") {
      const body = (item["content"] as Record<string, unknown>)["rendered"];
      const title = (item["title"] as Record<string, unknown> | undefined)?.["rendered"];
      if (typeof body === "string") posts.set(canonical(item["link"]), `${typeof title === "string" ? `${plain(title)}\n` : ""}${plain(body)}`);
    }
    for (const value of Object.values(item)) if (value && typeof value === "object") visit(value);
  };
  for (const source of TEXT_SOURCES) {
    const dir = path.join(dataDir, "raw", source);
    let files: string[];
    try { files = readdirSync(dir).filter((file) => file.endsWith(".json") && !file.endsWith(".headers.json")); } catch { continue; }
    for (const file of files) {
      try { visit(JSON.parse(readFileSync(path.join(dir, file), "utf8"))); } catch { /* captura no JSON */ }
    }
  }
  return posts;
}

/** Línea con lista de temas corrida («01. Tema 02. Otro…») o con tiempos («03:22»). */
function isInlineTracklist(line: string): boolean {
  const numbered = line.match(/(?:^|\s)(?:\d{1,2}|[AB]\d)\s*[.)\-–]\s+\S/gu)?.length ?? 0;
  const times = line.match(/\b\d{1,2}:\d{2}\b/gu)?.length ?? 0;
  return numbered >= 3 || times >= 2;
}

/**
 * Prosa del post: fuera tracklists («01. Tema (autor)», también corridas en una
 * sola línea) y líneas de créditos o catálogo. Una canción llamada «Black Is
 * Black» o «Rock en Fantasía» no dice nada del género.
 */
export function prose(text: string): string {
  return text.split("\n")
    .filter((line) => !/^\s*(?:\d{1,2}|[AB]\d?)\s*[.)\-–]/u.test(line))
    .filter((line) => !isInlineTracklist(line))
    .filter((line) => !/^\s*(?:lado [ab]|side [ab]|cara [ab]|cr[eé]ditos|m[uú]sicos|producci[oó]n|grabado|mezcla|tracklist|temas|canciones)\b/iu.test(line))
    .join("\n").trim();
}

/**
 * Palabras que en la prosa casi nunca nombran ese género solas: «disco» es el
 * álbum («este disco…»), «power» es el «power trio» y «indie» califica a otro
 * género («indie electrónico», «Indie Tropical») o a un nombre («The Indie –O-
 * Mara Project»). Solas no cuentan como mención; dentro de un alias más largo
 * («italo disco», «power metal», «indie rock») sí. En los campos de género de
 * las fuentes siguen resolviendo por la taxonomía: esto solo afecta al texto libre.
 */
const PROSE_ONLY_IN_LONGER_ALIAS = new Set(["disco", "indie", "power"]);

/**
 * Géneros que el texto nombra con un alias aprobado, en el orden del texto.
 * Gana la coincidencia más larga y no se solapan: «punk rock» es punk rock,
 * no además «punk» y «rock».
 */
export function mentioned(taxonomy: Taxonomy, text: string, ignore: string[] = []): number[] {
  // El título del disco y el nombre del artista no cuentan como mención:
  // «Dance Again» o «Rock n' Roll Show» son nombres, no afirmaciones.
  let clean = normalizeGenreText(text);
  for (const name of ignore) {
    const key = normalizeGenreText(name);
    if (key.length > 2) clean = clean.split(key).join(" | ");
  }
  const words = clean.replace(/[^a-z0-9 &|]+/gu, " ").split(/\s+/u).filter(Boolean);
  const hits: Array<{ start: number; id: number }> = [];
  const used = new Set<number>();
  for (let size = 4; size >= 1; size -= 1) {
    for (let start = 0; start + size <= words.length; start += 1) {
      const span = words.slice(start, start + size);
      if (span.includes("|") || span.some((_, k) => used.has(start + k))) continue;
      if (size === 1 && PROSE_ONLY_IN_LONGER_ALIAS.has(span[0]!)) continue;
      const target = taxonomy.aliases.get(span.join(" "));
      if (target?.kind === "genre" && taxonomy.genres.get(target.genreId)?.active) {
        hits.push({ start, id: target.genreId });
        for (let k = 0; k < size; k += 1) used.add(start + k);
      }
    }
  }
  return [...new Set(hits.sort((a, b) => a.start - b.start).map((hit) => hit.id))];
}
