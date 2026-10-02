// Etapa 3 (portadas): asegura en caché las fichas cdinfo encontradas por
// búsqueda dirigida (Brave) y verifica con el adapter + la página de artista de
// Sincopa del propio claim (la ficha debe estar enlazada en su discografía) o
// con compatibilidad de artista. Uso del fetcher oficial: robots + throttle.
// Uso: tsx fetch-sincopa-brave.mts [--limit N]
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
const LEDGER = path.resolve(ROOT, "reports/etapa3-sincopa-pages.jsonl");

interface Row { albumId: number; title: string; artist: string; cdinfoUrl: string | null; }

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function compact(value: string): string { return normalizeEntityName(value).secondaryKey.replace(/\s+/gu, ""); }
function field(record: RawRecord, name: string): string | undefined {
  const value = record.fields.find((item) => item.field === name)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function levenshtein(a: string, b: string): number {
  const m = a.length; const n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i += 1) {
    const curr = [i, ...new Array<number>(n).fill(0)];
    for (let j = 1; j <= n; j += 1) curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = curr;
  }
  return prev[n]!;
}
function titleMatch(recordKey: string, key: string): "exact" | "loose" | null {
  if (recordKey === key) return "exact";
  if (key.length >= 8 && (recordKey.startsWith(key) || key.startsWith(recordKey))) return "loose";
  if (key.length >= 4 && recordKey.startsWith(key) && recordKey.length - key.length <= 40) return "loose";
  if (key.length >= 6 && Math.abs(recordKey.length - key.length) <= 3 && levenshtein(recordKey, key) <= 2) return "loose";
  return null;
}
function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return url; }
}

async function main(): Promise<void> {
  const limit = arg("--limit") === undefined ? undefined : Number(arg("--limit"));
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  const adapter = adapterFor({ slug: "sincopa", siteType: "database" });
  if (!adapter?.extractSnapshot) throw new Error("adaptador Sincopa no disponible");
  const dataDir = getEnv().DATA_DIR;
  try {
    const rows = (await readFile(path.resolve(ROOT, "reports/etapa3-sincopa-brave.jsonl"), "utf8"))
      .split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as Row)
      .filter((row) => row.cdinfoUrl);
    const selected = limit === undefined ? rows : rows.slice(0, limit);
    console.log(`fichas a asegurar: ${selected.length}`);
    const covers: Array<Record<string, unknown>> = [];
    const years: Array<Record<string, unknown>> = [];
    const rejected: Array<Record<string, unknown>> = [];
    for (const [index, row] of selected.entries()) {
      const key = compact(row.title);
      // 1) página de artista del claim (para verificar vínculo)
      const { rows: claim } = await pool.query<{ url: string; stored_path: string }>(
        `SELECT rp.url, rp.stored_path FROM ingest.claims c JOIN ingest.raw_pages rp ON rp.id=c.raw_page_id
          WHERE c.album_id=$1 AND c.status='accepted' AND rp.url LIKE '%artist_rock%'
          ORDER BY (c.field='source_url') DESC, c.id LIMIT 1`, [row.albumId]);
      let linked = false;
      if (claim[0]) {
        try {
          const bytes = await readFile(path.join(dataDir, claim[0].stored_path));
          const body = adapter.decodeBody ? adapter.decodeBody(bytes) : bytes.toString("utf8");
          const target = pathOf(row.cdinfoUrl!);
          const re = /<a\s+href="([^"]*cdinfo_[^"]+\.htm)"[^>]*>([\s\S]*?)<\/a>/giu;
          for (const m of body.matchAll(re)) {
            const href = m[1] ?? "";
            if (pathOf(new URL(href, claim[0].url).toString()) === target) { linked = true; break; }
          }
        } catch { /* sin página de artista legible */ }
      }
      // 2) asegurar la ficha en caché (oficial)
      let stored: string | null = null;
      try {
        const cached = await fetchAndCache("sincopa", row.cdinfoUrl!);
        stored = cached.storedPath;
        await appendFile(LEDGER, `${JSON.stringify({ url: row.cdinfoUrl, storedPath: stored, status: cached.status, cached: cached.cached })}\n`);
      } catch (error) { rejected.push({ id: row.albumId, reason: `fetch: ${(error as Error).message}` }); }
      if (!stored) { await pause(); continue; }
      const bytes = await readFile(path.join(dataDir, stored));
      const body = adapter.decodeBody ? adapter.decodeBody(bytes) : bytes.toString("utf8");
      const recs = adapter.extractSnapshot({ url: row.cdinfoUrl!, kind: "html", rawPageId: 0, body });
      const artistKey = compact(row.artist);
      const rec = recs.filter((item) => {
        if (item.entityKind !== "album") return false;
        const title = field(item, "title"); const artist = field(item, "artist_name");
        if (!title) return false;
        const match = titleMatch(compact(title), key);
        if (!match) return false;
        if (!linked) {
          // sin vínculo en la página del artista: exigir compatibilidad estricta
          if (!artist) return false;
          const a = compact(artist);
          const ok = a.includes(artistKey) || artistKey.includes(a) || (artistKey.length >= 5 && levenshtein(a, artistKey) <= 2);
          if (!ok) return false;
        }
        return true;
      })[0];
      if (!rec) { rejected.push({ id: row.albumId, title: row.title, reason: linked ? "sin record verificado (ligado)" : "sin record verificado", page: row.cdinfoUrl }); await pause(); continue; }
      const { rows: cur } = await pool.query<{ year: number | null; cover_ok: boolean }>(
        "SELECT release_year AS year, (cover_url IS NOT NULL AND btrim(cover_url) <> '') AS cover_ok FROM public.albums WHERE id=$1", [row.albumId]);
      const recordYear = Number(field(rec, "release_year"));
      const yearOk = !(cur[0] && cur[0].year !== null && Number.isSafeInteger(recordYear) && recordYear > 0 && Math.abs(recordYear - cur[0].year) > 1);
      if (!yearOk) { rejected.push({ id: row.albumId, title: row.title, reason: `año en conflicto (BD ${cur[0]!.year} vs ficha ${recordYear})`, page: row.cdinfoUrl }); await pause(); continue; }
      const cover = field(rec, "cover_url");
      if (cover && /^https?:\/\//u.test(cover) && cur[0] && !cur[0].cover_ok) {
        covers.push({ kind: "album", id: row.albumId, sourceUrl: cover, label: row.title, artist: row.artist, source: "sincopa-brave", snapshotUrl: row.cdinfoUrl, linkedToArtistPage: linked });
      }
      if (cur[0] && cur[0].year === null && Number.isSafeInteger(recordYear) && recordYear >= 1950 && recordYear <= 2026) {
        years.push({ albumId: row.albumId, title: row.title, artist: row.artist, year: recordYear, source: "sincopa", extractor: "ficha-sincopa", postTitle: row.title, url: row.cdinfoUrl,
          note: `ficha de Sincopa: «${row.title}» (año ${recordYear} en la ficha)` });
      }
      if ((index + 1) % 10 === 0) console.log(`procesados ${index + 1}/${selected.length}; portadas ${covers.length}; años ${years.length}; rechazados ${rejected.length}`);
      await pause();
    }
    await writeFile(path.resolve(ROOT, "reports/covers-sincopa-brave.jsonl"), covers.map((r) => JSON.stringify(r)).join("\n") + (covers.length ? "\n" : ""));
    await writeFile(path.resolve(ROOT, "reports/years-sincopa-brave.jsonl"), years.map((r) => JSON.stringify(r)).join("\n") + (years.length ? "\n" : ""));
    await writeFile(path.resolve(ROOT, "reports/covers-sincopa-brave-rejected.jsonl"), rejected.map((r) => JSON.stringify(r)).join("\n") + (rejected.length ? "\n" : ""));
    console.log(JSON.stringify({ fichas: selected.length, portadas: covers.length, años: years.length, rechazados: rejected.length }));
  } finally { await pool.end(); }
}
async function pause(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 400)); }
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
