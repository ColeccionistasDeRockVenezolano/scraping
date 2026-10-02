// Etapa 3 (portadas): busca los discos sin portada entre las fichas cdinfo de
// Sincopa YA guardadas en la caché (sin red). Verifica con el adapter
// (título + artista + año) y emite candidatos para localize-images.
// Uso: tsx scan-sincopa-cache.mts [--out reports/covers-sincopa-cache.jsonl]
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { adapterFor } from "../src/adapters/registry.js";
import type { RawRecord } from "../src/adapters/contracts.js";
import { getEnv } from "../src/config/env.js";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

interface Target { id: number; title: string; artist: string; year: number | null; }
interface Cover { kind: "album"; id: number; sourceUrl: string; label: string; artist: string; source: "sincopa-cache"; snapshotUrl: string; }

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
  if (key.length >= 6 && Math.abs(recordKey.length - key.length) <= 3 && levenshtein(recordKey, key) <= 2) return "loose";
  return null;
}
// slug del título para buscar en la URL de la ficha (los slugs de Sincopa usan
// minúsculas sin tildes y separan por _)
function slugKey(value: string): string {
  return normalizeEntityName(value).secondaryKey.toLowerCase().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  const adapter = adapterFor({ slug: "sincopa", siteType: "database" });
  if (!adapter?.extractSnapshot) throw new Error("adaptador Sincopa no disponible");
  const dataDir = getEnv().DATA_DIR;
  try {
    // Discos sin portada con claim de sincopa: página de origen preferente (source_url).
    const { rows } = await pool.query<{ id: string; title: string; artist: string; year: number | null; url: string; stored_path: string }>(`
      SELECT DISTINCT ON (al.id) al.id::text, al.title, ar.name AS artist, al.release_year AS year, rp.url, rp.stored_path
        FROM public.albums al
        JOIN public.artists ar ON ar.id = al.artist_id
        JOIN ingest.claims c ON c.album_id = al.id AND c.status='accepted'
        JOIN ingest.raw_pages rp ON rp.id = c.raw_page_id
       WHERE (al.cover_url IS NULL OR btrim(al.cover_url)='')
         AND c.source_id = (SELECT id FROM ingest.sources WHERE slug='sincopa')
       ORDER BY al.id, (c.field='source_url') DESC, c.id`);
    const targets: Target[] = rows.map((row) => ({ id: Number(row.id), title: row.title, artist: row.artist, year: row.year }));

    // Índice de fichas cdinfo guardadas: slug de la URL → storedPath
    const { rows: pages } = await pool.query<{ url: string; stored_path: string }>(
      `SELECT url, stored_path FROM ingest.raw_pages WHERE url LIKE '%cdinfo_rock%' ORDER BY id`);
    const bySlug = new Map<string, { url: string; stored: string }[]>();
    for (const page of pages) {
      const slug = (page.url.split("/").pop() ?? "").replace(/\.htm.*$/u, "");
      const key = slug.toLowerCase();
      bySlug.set(key, [...(bySlug.get(key) ?? []), { url: page.url, stored: page.stored_path }]);
    }
    console.log(`objetivos: ${targets.length}; fichas cdinfo en caché: ${pages.length}`);

    const recordCache = new Map<string, RawRecord[]>();
    async function recordsOf(stored: string, url: string): Promise<RawRecord[]> {
      const hit = recordCache.get(stored);
      if (hit) return hit;
      let list: RawRecord[];
      try {
        const bytes = await readFile(path.join(dataDir, stored));
        const body = adapter!.decodeBody ? adapter!.decodeBody(bytes) : bytes.toString("utf8");
        list = adapter!.extractSnapshot!({ url, kind: "html", rawPageId: 0, body });
      } catch { list = []; }
      recordCache.set(stored, list);
      return list;
    }

    const covers: Cover[] = [];
    const rejected: Array<Record<string, unknown>> = [];
    for (const [index, target] of targets.entries()) {
      const key = compact(target.title);
      if (key.length < 4) { rejected.push({ id: target.id, title: target.title, reason: "título corto" }); continue; }
      // candidatas por slug: el slug de la ficha contiene el slug del título o al revés
      const tslug = slugKey(target.title);
      const cands: { url: string; stored: string }[] = [];
      for (const [slug, entries] of bySlug) {
        const flat = slug.replace(/_/gu, "");
        const hitsTitle = tslug.length >= 4 && (slug.includes(tslug) || tslug.includes(slug));
        const hitsFlat = key.length >= 6 && (flat.includes(key) || key.includes(flat));
        if (hitsTitle || hitsFlat) cands.push(...entries);
      }
      // verificación estricta con el adapter
      const artistKey = compact(target.artist);
      let found: { cover: string; url: string } | undefined;
      let tried = 0;
      for (const cand of cands) {
        tried += 1;
        const recs = await recordsOf(cand.stored, cand.url);
        for (const item of recs) {
          if (item.entityKind !== "album") continue;
          const title = field(item, "title"); const artist = field(item, "artist_name");
          if (!title) continue;
          const match = titleMatch(compact(title), key);
          if (!match) continue;
          if (artist) {
            const a = compact(artist);
            const ok = a.includes(artistKey) || artistKey.includes(a) || (artistKey.length >= 5 && levenshtein(a, artistKey) <= 2);
            if (!ok) continue;
          } else if (match === "loose") continue;
          const year = Number(field(item, "release_year"));
          if (target.year !== null && Number.isSafeInteger(year) && year > 0 && Math.abs(year - target.year) > 1) continue;
          const cover = field(item, "cover_url");
          if (cover && /^https?:\/\//u.test(cover)) { found = { cover, url: cand.url }; break; }
        }
        if (found) break;
      }
      if (found) covers.push({ kind: "album", id: target.id, sourceUrl: found.cover, label: target.title, artist: target.artist, source: "sincopa-cache", snapshotUrl: found.url });
      else rejected.push({ id: target.id, title: target.title, artist: target.artist, reason: cands.length ? `sin record verificado (${tried} fichas)` : "sin ficha en caché" });
      if ((index + 1) % 25 === 0) console.log(`procesados ${index + 1}/${targets.length}; covers ${covers.length}; rechazados ${rejected.length}`);
    }
    const out = path.resolve(ROOT, arg("--out") ?? "reports/covers-sincopa-cache.jsonl");
    await writeFile(out, covers.map((row) => JSON.stringify(row)).join("\n") + (covers.length ? "\n" : ""));
    await writeFile(path.resolve(ROOT, "reports/covers-sincopa-cache-rejected.jsonl"), rejected.map((row) => JSON.stringify(row)).join("\n") + (rejected.length ? "\n" : ""));
    console.log(JSON.stringify({ targets: targets.length, covers: covers.length, rejected: rejected.length, out: path.relative(ROOT, out) }));
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
