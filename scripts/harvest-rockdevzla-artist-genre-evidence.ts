// Extrae frases de género referidas a la banda en posts de Rock De Vzla.
// Exige URL aceptada, categoría igual al artista y frase al inicio del post.
import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";
import { normalizeGenreText } from "../src/genres/normalize.js";

interface Link { source: string; url: string }
interface Row { caseId: string; kind: string; entityId: number; title: string; sourceLinks: Link[] }
interface Entry { category?: Array<{ term?: string }>; content?: { $t?: string }; link?: Array<{ rel?: string; href?: string }> }
const ROOT = path.resolve("reports");
const SOURCE = process.argv.includes("--source=rockzuela") ? "rockzuela" : "rock-de-vzla";
const RAW = path.resolve("data/raw", SOURCE);
const TAXONOMY_FILE = path.resolve("data/genres/taxonomy.json");

function genreCharPattern(char: string): string {
  const accents: Record<string, string> = {
    a: "aáàâäãå", e: "eéèêë", i: "iíìîï", o: "oóòôöõ", u: "uúùûü",
    n: "nñ", c: "cç",
  };
  return accents[char] ? `[${accents[char]}]` : char.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function genreTermPattern(value: string): string {
  return [...value].map((char) => char === " " ? "[\\s-]+" : genreCharPattern(char)).join("");
}

async function genrePattern(): Promise<RegExp> {
  const data = JSON.parse(await readFile(TAXONOMY_FILE, "utf8")) as {
    families?: Array<{ name: string; aliases?: string[] }>;
    genres?: Array<{ name: string; aliases?: string[] }>;
  };
  const names = [...(data.families ?? []), ...(data.genres ?? [])]
    .flatMap((item) => [item.name, ...(item.aliases ?? [])])
    .map((item) => normalizeGenreText(item)).filter((item) => item.length >= 3);
  const unique = [...new Set(names)].sort((a, b) => b.length - a.length || a.localeCompare(b));
  const alternatives = unique.map(genreTermPattern);
  return new RegExp(`(?<![\\p{L}\\p{N}])(${alternatives.join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

function extract(text: string, genre: RegExp): { genre: string; excerpt: string; original: string } | null {
  const prefix = text.slice(0, 900);
  const entityType = /\b(?:banda|grupo|agrupaci[oó]n|d[uú]o|tr[ií]o|proyecto\s+musical)\s+/giu;
  for (const match of prefix.matchAll(entityType)) {
    const at = (match.index ?? 0) + match[0].length;
    const tail = prefix.slice(at, at + 160);
    const relation = /^(?:de\s+(?:venezuela|caracas|maracaibo|valencia|barquisimeto|maracay|m[eé]rida|cabimas|punto\s+fijo|puerto\s+ordaz)\s+|venezolan[oa]s?\s+|caraqueñ[oa]s?\s+|maracuch[oa]s?\s+|de\s+){0,3}/iu.exec(tail)?.[0] ?? "";
    const genreStart = tail.slice(relation.length);
    genre.lastIndex = 0;
    const found = genre.exec(genreStart);
    if (!found || found.index > 16) continue;
    const raw = found[0].trim();
    const sentence = prefix.slice(Math.max(0, (match.index ?? 0) - 35), Math.min(prefix.length, at + relation.length + found.index + raw.length + 70));
    const value = normalizeGenreText(raw);
    const original = [...(genrePatternCache ?? [])].find((candidate) => normalizeGenreText(candidate) === value) ?? raw;
    return { genre: original, excerpt: sentence, original: raw };
  }
  return null;
}

let genrePatternCache: string[] | null = null;

async function main(): Promise<void> {
  const pattern = await genrePattern();
  const taxonomyData = JSON.parse(await readFile(TAXONOMY_FILE, "utf8")) as {
    families?: Array<{ name: string; aliases?: string[] }>;
    genres?: Array<{ name: string; aliases?: string[] }>;
  };
  genrePatternCache = [...(taxonomyData.families ?? []), ...(taxonomyData.genres ?? [])]
    .flatMap((item) => [item.name, ...(item.aliases ?? [])]);
  const inventory = (await readFile(path.join(ROOT, "genre-laya-evidence-coverage-2026-09-26-inventory.jsonl"), "utf8"))
    .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Row)
    .filter((row) => row.kind === "artist" && row.sourceLinks.some((link) => link.source === SOURCE));
  const covered = new Set<string>();
  for (const file of ["genre-laya-evidence-sincopa-artists-2026-09-26.jsonl",
    "genre-laya-evidence-wikidata-artists-2026-09-26.jsonl",
    ...(SOURCE === "rockzuela" ? ["genre-laya-evidence-rockdevzla-artists-2026-09-26.jsonl"] : [])]) {
    for (const line of (await readFile(path.join(ROOT, file), "utf8")).split(/\r?\n/u).filter(Boolean)) {
      covered.add((JSON.parse(line) as Row).caseId);
    }
  }
  const wanted = new Map<string, Row[]>();
  for (const row of inventory.filter((item) => !covered.has(item.caseId))) {
    for (const link of row.sourceLinks.filter((item) => item.source === SOURCE)) {
      wanted.set(link.url, [...(wanted.get(link.url) ?? []), row]);
    }
  }
  const candidates = new Map<string, Array<Record<string, unknown>>>();
  const rejected: Array<Record<string, unknown>> = [];
  for (const filename of await readdir(RAW)) {
    if (!filename.endsWith(".json") || filename.endsWith(".headers.json")) continue;
    const file = path.join(RAW, filename);
    const body = await readFile(file);
    let entries: Entry[];
    try { entries = (JSON.parse(body.toString()) as { feed?: { entry?: Entry[] } }).feed?.entry ?? []; }
    catch { continue; }
    for (const entry of entries) {
      const url = entry.link?.find((link) => link.rel === "alternate")?.href;
      if (!url || !wanted.has(url)) continue;
      const rows = wanted.get(url)!;
      const label = entry.category?.map((item) => item.term?.trim()).filter(Boolean) ?? [];
      const labelMatches = label.filter((value) => normalizeIdentitySecondary(value!) === normalizeIdentitySecondary(rows[0]?.title ?? ""));
      if (rows.length !== 1 || labelMatches.length !== 1
        || (SOURCE === "rock-de-vzla" && label.length !== 1)) {
        rejected.push({ url, reason: "identity_mismatch_or_ambiguous" }); continue;
      }
      const html = entry.content?.$t ?? "";
      const text = load(html.replace(/<br\s*\/?>/giu, " ").replace(/<\/div>/giu, " ")).text().replace(/\s+/gu, " ").trim();
      const parsed = extract(text, pattern);
      if (!parsed) { rejected.push({ url, caseId: rows[0]!.caseId, reason: "no_direct_genre_phrase" }); continue; }
      const row = rows[0]!;
      const item = { caseId: row.caseId, kind: "artist", entityId: row.entityId, title: row.title,
        source: SOURCE, rawGenre: parsed.genre, excerpt: parsed.excerpt,
        url, snapshot: path.relative(path.resolve("data"), file),
        snapshotSha256: createHash("sha256").update(body).digest("hex"),
        signals: ["accepted_source_url", "entry_category_artist", "direct_artist_genre_phrase"] };
      candidates.set(row.caseId, [...(candidates.get(row.caseId) ?? []), item]);
    }
  }
  const recovered: Record<string, unknown>[] = [];
  for (const [caseId, rows] of candidates) {
    const genres = new Set(rows.map((row) => normalizeIdentitySecondary(String(row["rawGenre"]))));
    if (genres.size !== 1) { rejected.push({ caseId, reason: "conflicting_posts", genres: rows.map((row) => row["rawGenre"]) }); continue; }
    recovered.push(rows[0]!);
  }
  recovered.sort((a, b) => String(a["caseId"]).localeCompare(String(b["caseId"])));
  const stem = SOURCE === "rockzuela" ? "rockzuela" : "rockdevzla";
  await writeFile(path.join(ROOT, `genre-laya-evidence-${stem}-artists-2026-09-26.jsonl`),
    recovered.map((row) => JSON.stringify(row)).join("\n") + (recovered.length ? "\n" : ""));
  await writeFile(path.join(ROOT, `genre-laya-evidence-${stem}-artists-2026-09-26.json`),
    JSON.stringify({ linkedArtists: inventory.length, recovered: recovered.length,
      rejected: rejected.reduce<Record<string, number>>((out, row) => {
        const reason = String(row["reason"]); out[reason] = (out[reason] ?? 0) + 1; return out;
      }, {}) }, null, 2) + "\n");
  console.log(JSON.stringify({ linkedArtists: inventory.length, recovered: recovered.length }));
}

main().catch((error: unknown) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
