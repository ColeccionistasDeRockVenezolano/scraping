// Recupera portadas y años de discos sin portada/año cuyo origen en Sincopa es
// la página del ARTISTA: de su HTML guardado saca el link a la ficha cdinfo de
// cada disco, asegura la ficha en la caché (fetcher oficial: robots + throttle
// + reintentos) y extrae cover_url/release_year con el adapter y verificación
// estricta (título + artista + año si consta).
// Emite:
//   reports/covers-sincopa-links.jsonl (localize-images --candidates)
//   reports/years-sincopa-links.jsonl  (apply-album-years)
// Uso: tsx harvest-sincopa-directed.mts [--limit N] [--no-fetch]
import { readFile, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { adapterFor } from "../src/adapters/registry.js";
import type { RawRecord } from "../src/adapters/contracts.js";
import { fetchAndCache } from "../src/cache/raw-pages.js";
import { getEnv } from "../src/config/env.js";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const PAGE_LEDGER = path.resolve(ROOT, "reports/etapa3-sincopa-pages-links.jsonl");

interface Target { id: number; title: string; artist: string; year: number | null; needCover: boolean; pageUrl: string; storedPath: string; }
interface Link { href: string; text: string; }

function compact(value: string): string { return normalizeEntityName(value).secondaryKey.replace(/\s+/gu, ""); }
function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function field(record: RawRecord, name: string): string | undefined {
  const value = record.fields.find((item) => item.field === name)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function stripTags(html: string): string {
  return html.replace(/<[^>]*>/gu, " ").replace(/&nbsp;/gu, " ").replace(/&amp;/gu, "&").replace(/\s+/gu, " ").trim();
}
function levenshtein(a: string, b: string): number {
  const m = a.length; const n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i, ...new Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j += 1) {
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = curr;
  }
  return prev[n]!;
}
// Dos títulos coinciden si son iguales, uno es prefijo del otro (≥8 caracteres)
// o difieren en hasta 2 ediciones (variantes tipo Melisa/Melissa).
function titleMatch(recordKey: string, key: string): "exact" | "loose" | null {
  if (recordKey === key) return "exact";
  if (key.length >= 8 && (recordKey.startsWith(key) || key.startsWith(recordKey))) return "loose";
  if (key.length >= 4 && recordKey.startsWith(key) && recordKey.length - key.length <= 40) return "loose";
  if (key.length >= 6 && Math.abs(recordKey.length - key.length) <= 3 && levenshtein(recordKey, key) <= 2) return "loose";
  return null;
}

async function main(): Promise<void> {
  const limitRaw = arg("--limit");
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  const noFetch = process.argv.includes("--no-fetch");
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  const adapter = adapterFor({ slug: "sincopa", siteType: "database" });
  if (!adapter?.extractSnapshot) throw new Error("adaptador Sincopa no disponible");
  const dataDir = getEnv().DATA_DIR;
  try {
    const { rows } = await pool.query<{ id: string; title: string; artist: string; year: number | null; need_cover: boolean; page_url: string; stored_path: string }>(`
      SELECT DISTINCT ON (al.id) al.id::text, al.title, ar.name AS artist, al.release_year AS year,
             (al.cover_url IS NULL) AS need_cover, rp.url AS page_url, rp.stored_path
        FROM public.albums al
        JOIN public.artists ar ON ar.id = al.artist_id
        JOIN ingest.claims c ON c.album_id = al.id AND c.field = 'source_url'
        JOIN ingest.raw_pages rp ON rp.id = c.raw_page_id
       WHERE (al.cover_url IS NULL OR al.release_year IS NULL) AND rp.url LIKE '%artist_rock%'
       ORDER BY al.id, c.id`);
    let targets: Target[] = rows.map((row) => ({ id: Number(row.id), title: row.title, artist: row.artist, year: row.year, needCover: row.need_cover, pageUrl: row.page_url, storedPath: row.stored_path }));
    if (limit !== undefined) targets = targets.slice(0, limit);
    process.stdout.write(`objetivos: ${targets.length}\n`);

    const pageCache = new Map<string, Link[]>();
    const covers: Array<Record<string, unknown>> = [];
    const years: Array<Record<string, unknown>> = [];
    const rejected: Array<Record<string, unknown>> = [];
    const fetchedPages = new Map<string, string | null>(); // url → storedPath|null(error)

    for (const [index, target] of targets.entries()) {
      const key = compact(target.title);
      if (key.length < 4) { rejected.push({ id: target.id, title: target.title, reason: "título corto" }); continue; }
      // 1) Links del artista (desde su HTML guardado).
      let links = pageCache.get(target.storedPath);
      if (links === undefined) {
        try {
          const bytes = await readFile(path.join(dataDir, target.storedPath));
          const body = adapter.decodeBody ? adapter.decodeBody(bytes) : bytes.toString("utf8");
          links = [];
          const re = /<a\s+href="([^"]*cdinfo_rock\/[^"]+\.htm)"[^>]*>([\s\S]*?)<\/a>/giu;
          for (const match of body.matchAll(re)) {
            const href = match[1] ?? ""; const text = stripTags(match[2] ?? "");
            if (href && text) links.push({ href, text });
          }
        } catch { links = []; }
        pageCache.set(target.storedPath, links);
      }
      const slugCompact = (href: string) => (href.split("/").pop() ?? "").replace(/\.htm$/u, "").replace(/_/gu, "");
      const matches = links.filter((link) => {
        const textKey = compact(link.text);
        if (textKey && textKey === key) return true;
        if (slugCompact(link.href).includes(key)) return true;
        return textKey.length >= 5 && key.includes(textKey) && slugCompact(link.href).includes(textKey);
      });
      const unique = [...new Set(matches.map((link) => link.href))];
      if (unique.length === 0) { rejected.push({ id: target.id, title: target.title, reason: "sin link de ficha en la página del artista" }); continue; }
      if (unique.length > 1) { rejected.push({ id: target.id, title: target.title, reason: `${unique.length} links candidatos`, links: unique }); continue; }
      // 2) Asegurar la ficha en la caché (si ya existe, fetchAndCache la reutiliza).
      const pageUrl = new URL(unique[0]!, target.pageUrl).toString();
      let storedPath = fetchedPages.get(pageUrl) ?? undefined;
      if (storedPath === undefined) {
        if (noFetch) { fetchedPages.set(pageUrl, null); }
        else {
          try {
            const cached = await fetchAndCache("sincopa", pageUrl);
            storedPath = cached.storedPath;
            fetchedPages.set(pageUrl, storedPath);
            await appendFile(PAGE_LEDGER, `${JSON.stringify({ url: pageUrl, storedPath, status: cached.status, cached: cached.cached })}\n`);
          } catch (error) {
            fetchedPages.set(pageUrl, null);
            await appendFile(PAGE_LEDGER, `${JSON.stringify({ url: pageUrl, error: error instanceof Error ? error.message : String(error) })}\n`);
          }
        }
      }
      if (!storedPath) { rejected.push({ id: target.id, title: target.title, reason: "ficha no disponible (fetch)" }); continue; }
      const verify = (list: RawRecord[]): RawRecord | undefined => list.filter((item) => {
        if (item.entityKind !== "album") return false;
        const title = field(item, "title"); const artist = field(item, "artist_name");
        if (!title) return false;
        const match = titleMatch(compact(title), key);
        if (!match) return false;
        // El vínculo viene de la discografía del propio artista (página
        // artist_rock del claim): basta título + año compatible. Si el
        // artista del record difiere (p. ej. la banda cuando el catálogo
        // guarda al solista), el vínculo ya lo avala.
        if (!artist && match === "loose") return false;
        const year = Number(field(item, "release_year"));
        if (target.year !== null && Number.isSafeInteger(year) && year > 0 && Math.abs(year - target.year) > 1) return false;
        return true;
      })[0];
      const extract = async (stored: string): Promise<RawRecord[]> => {
        try {
          const bytes = await readFile(path.join(dataDir, stored));
          return adapter.extractSnapshot!({ url: pageUrl, kind: "html", rawPageId: 0,
            body: adapter.decodeBody ? adapter.decodeBody(bytes) : bytes.toString("utf8") });
        } catch { return []; }
      };
      let record = verify(await extract(storedPath));
      if (!record && !noFetch) {
        // Segunda oportunidad: re-fetch forzado (ttl 0). Visto 2026-09-30: algunas
        // páginas guardadas sirven el contenido de OTRA URL (cruce en la caché),
        // así que el snapshot local puede no bastar.
        try {
          const fresh = await fetchAndCache("sincopa", pageUrl, 0);
          storedPath = fresh.storedPath;
          await appendFile(PAGE_LEDGER, `${JSON.stringify({ url: pageUrl, storedPath, status: fresh.status, cached: fresh.cached, refetch: true })}\n`);
          record = verify(await extract(storedPath));
        } catch { /* sin segunda oportunidad */ }
      }
      if (!record) { rejected.push({ id: target.id, title: target.title, reason: "ficha sin record verificado", page: pageUrl }); continue; }
      const cover = field(record, "cover_url");
      if (target.needCover && cover && /^https?:\/\//u.test(cover)) {
        covers.push({ kind: "album", id: target.id, sourceUrl: cover, label: target.title, artist: target.artist, source: "sincopa-cdinfo", snapshotUrl: pageUrl });
      }
      if (target.year === null) {
        const year = Number(field(record, "release_year"));
        if (Number.isSafeInteger(year) && year >= 1950 && year <= 2026) {
          years.push({ albumId: target.id, title: target.title, artist: target.artist, year, source: "sincopa", extractor: "ficha-sincopa", postTitle: target.title, url: pageUrl,
            note: `ficha de Sincopa: «${target.title}» (año ${year} en la ficha)` });
        }
      }
      if ((index + 1) % 25 === 0) process.stdout.write(`procesados ${index + 1}/${targets.length}; covers ${covers.length}; años ${years.length}; rechazados ${rejected.length}\n`);
    }
    const write = async (file: string, list: Array<Record<string, unknown>>) => writeFile(path.resolve(ROOT, file), list.map((row) => JSON.stringify(row)).join("\n") + (list.length ? "\n" : ""));
    await write("reports/covers-sincopa-links.jsonl", covers);
    await write("reports/years-sincopa-links.jsonl", years);
    await write("reports/covers-sincopa-links-rejected.jsonl", rejected);
    process.stdout.write(`${JSON.stringify({ targets: targets.length, covers: covers.length, years: years.length, rejected: rejected.length, noFetch })}\n`);
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
