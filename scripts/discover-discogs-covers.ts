// Busca portadas en Discogs para álbumes sin cover_url. Un resultado solo se
// acepta si artista, título y, cuando CRV lo conoce, año coinciden de forma
// exacta. El script no escribe el core: emite candidatos auditables para
// localize-images.ts.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, arg("--out") ?? "reports/media-discogs-album-candidates-2026-09-27.jsonl");
const USER_AGENT = "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)";

interface Album { id: number; title: string; artist: string; year: number | null; }
interface Result { id?: number; type?: string; title?: string; year?: string | number; cover_image?: string; }
interface Candidate { kind: "album"; id: number; sourceUrl: string; label: string; artist: string; source: "discogs"; masterId: number; year: number | null; }

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function positive(name: string, fallback: number): number {
  const raw = arg(name); if (raw === undefined) return fallback;
  const value = Number(raw); if (!Number.isInteger(value) || value < 1) throw new Error(`${name} debe ser entero positivo`);
  return value;
}
function key(value: string): string { return normalizeEntityName(value).secondaryKey; }
function discogsArtist(value: string): string { return value.replace(/\s+\(\d+\)$/u, ""); }
function splitResultTitle(value: string, albumTitle: string): string | undefined {
  const suffix = ` - ${albumTitle}`;
  if (!value.endsWith(suffix)) return undefined;
  return value.slice(0, -suffix.length);
}
async function pause(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function search(album: Album): Promise<Result[]> {
  const token = process.env["DISCOGS_TOKEN"]?.trim();
  if (!token) throw new Error("falta DISCOGS_TOKEN");
  const url = new URL("https://api.discogs.com/database/search");
  url.search = new URLSearchParams({ artist: album.artist, release_title: album.title, type: "master", per_page: "25" }).toString();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: { authorization: `Discogs token=${token}`, "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (response.ok) return ((await response.json()) as { results?: Result[] }).results ?? [];
    if ((response.status === 429 || response.status === 503) && attempt < 3) {
      const seconds = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 5_000 * (attempt + 1);
      process.stderr.write(`Discogs: HTTP ${response.status}; reintento en ${wait} ms\n`);
      await pause(wait);
      continue;
    }
    throw new Error(`Discogs HTTP ${response.status}`);
  }
  throw new Error("Discogs agotó los reintentos");
}

function select(album: Album, results: Result[]): { id: number; sourceUrl: string } | undefined {
  const matches = results.filter((result) => {
    if (result.type !== "master" || !Number.isInteger(result.id) || typeof result.title !== "string" || !/^https?:\/\//u.test(result.cover_image ?? "")) return false;
    const credited = splitResultTitle(result.title, album.title);
    if (!credited || key(discogsArtist(credited)) !== key(album.artist)) return false;
    return album.year === null || Number(result.year) === album.year;
  });
  const distinct = [...new Map(matches.map((result) => [result.id!, result])).values()];
  return distinct.length === 1 ? { id: distinct[0]!.id!, sourceUrl: distinct[0]!.cover_image! } : undefined;
}

async function missing(pool: pg.Pool): Promise<Album[][]> {
  const { rows } = await pool.query<{ id: string; title: string; artist: string; year: number | null }>(`
    SELECT al.id::text, al.title, ar.name AS artist, al.release_year AS year
      FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id
     WHERE al.cover_url IS NULL
     ORDER BY al.id`);
  const groups = new Map<string, Album[]>();
  for (const row of rows) {
    const identity = `${key(row.artist)}\u0000${key(row.title)}\u0000${row.year ?? ""}`;
    groups.set(identity, [...(groups.get(identity) ?? []), { id: Number(row.id), title: row.title, artist: row.artist, year: row.year }]);
  }
  return [...groups.values()];
}

async function main(): Promise<void> {
  const limit = arg("--limit") === undefined ? undefined : positive("--limit", 1);
  const delay = positive("--delay-ms", 1_500);
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    const identities = await missing(pool); const selected = limit === undefined ? identities : identities.slice(0, limit);
    const candidates: Candidate[] = []; let failures = 0;
    for (let index = 0; index < selected.length; index += 1) {
      const albums = selected[index]!; const album = albums[0]!;
      try {
        const match = select(album, await search(album));
        if (match) candidates.push(...albums.map((row) => ({ kind: "album" as const, id: row.id, sourceUrl: match.sourceUrl, label: row.title, artist: row.artist, source: "discogs" as const, masterId: match.id, year: row.year })));
      } catch (error) { failures += 1; process.stderr.write(`album ${album.id}: ${(error as Error).message}\n`); }
      if ((index + 1) % 25 === 0 || index + 1 === selected.length) process.stdout.write(`consultados ${index + 1}/${selected.length}; candidatos ${candidates.length}; fallos ${failures}\n`);
      await pause(delay);
    }
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, candidates.map((row) => JSON.stringify(row)).join("\n") + (candidates.length ? "\n" : ""));
    process.stdout.write(`${JSON.stringify({ identities: selected.length, candidates: candidates.length, failures, out: path.relative(ROOT, OUT) })}\n`);
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
