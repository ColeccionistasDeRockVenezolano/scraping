// Busca el año de lanzamiento de discos sin release_year en iTunes, Deezer,
// MusicBrainz y Discogs. Solo acepta coincidencia exacta (artista y título
// normalizados) y registra el voto de cada fuente; si dos fuentes discrepan el
// caso queda como dudoso y no se aplica (lo decide una persona).
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const USER_AGENT = "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)";

interface Album { id: number; title: string; artist: string; }
interface Candidate { albumId: number; title: string; artist: string; year: number; sources: string[]; all: Record<string, number>; }
interface Doubt { albumId: number; title: string; artist: string; votes: Record<string, number>; reason: string; }

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function numberArg(name: string, fallback: number): number { const raw = arg(name); if (raw === undefined) return fallback; const n = Number(raw); if (!Number.isInteger(n) || n < 1) throw new Error(`${name} debe ser entero positivo`); return n; }
function key(value: string): string { return normalizeEntityName(value).secondaryKey; }
async function pause(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function albums(pool: pg.Pool, limit: number | undefined): Promise<Album[]> {
  const { rows } = await pool.query<{ id: string; title: string; artist: string }>(`
    SELECT al.id::text, al.title, ar.name AS artist
      FROM public.albums al JOIN public.artists ar ON ar.id = al.artist_id
     WHERE al.release_year IS NULL ORDER BY al.id`);
  const unique = new Map<string, Album>();
  for (const row of rows) {
    const identity = `${key(row.artist)}\u0000${key(row.title)}`;
    if (!unique.has(identity)) unique.set(identity, { id: Number(row.id), title: row.title, artist: row.artist });
  }
  const result = [...unique.values()];
  return limit === undefined ? result : result.slice(0, limit);
}
function yearOf(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const year = Number(String(value).slice(0, 4));
  return Number.isInteger(year) && year >= 1950 && year <= 2027 ? year : undefined;
}

async function itunesYear(album: Album): Promise<number | undefined> {
  const url = new URL("https://itunes.apple.com/search");
  url.search = new URLSearchParams({ term: `${album.artist} ${album.title}`, country: "VE", media: "music", entity: "album", limit: "20" }).toString();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (response.ok) {
      const data = ((await response.json()) as { results?: Array<{ wrapperType?: string; artistName?: string; collectionName?: string; releaseDate?: string }> }).results ?? [];
      const matches = data.filter((row) => row.wrapperType === "collection" && row.artistName && row.collectionName && key(row.artistName) === key(album.artist) && key(row.collectionName) === key(album.title));
      return matches.length === 1 ? yearOf(matches[0]!.releaseDate) : undefined;
    }
    if ([429, 403, 503].includes(response.status) && attempt < 2) { await pause(5_000 * (attempt + 1)); continue; }
    throw new Error(`iTunes HTTP ${response.status}`);
  }
  return undefined;
}
async function deezerYear(album: Album): Promise<number | undefined> {
  const url = new URL("https://api.deezer.com/search/album");
  url.search = new URLSearchParams({ q: `${album.artist} ${album.title}`, limit: "20" }).toString();
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Deezer HTTP ${response.status}`);
  const data = ((await response.json()) as { data?: Array<{ title?: string; artist?: { name?: string }; release_date?: string }> }).data ?? [];
  const matches = data.filter((row) => row.title && row.artist?.name && key(row.title) === key(album.title) && key(row.artist.name) === key(album.artist));
  return matches.length === 1 ? yearOf(matches[0]!.release_date) : undefined;
}
async function musicbrainzYear(album: Album): Promise<number | undefined> {
  const query = `releasegroup:"${album.title.replace(/"/g, "")}" AND artist:"${album.artist.replace(/"/g, "")}"`;
  const url = new URL("https://musicbrainz.org/ws/2/release-group/");
  url.search = new URLSearchParams({ query, fmt: "json", limit: "15" }).toString();
  const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`MusicBrainz HTTP ${response.status}`);
  const data = ((await response.json()) as { "release-groups"?: Array<{ title?: string; "first-release-date"?: string; "artist-credit"?: Array<{ name?: string }> }> })["release-groups"] ?? [];
  const matches = data.filter((row) => row.title && row["artist-credit"]?.[0]?.name && key(row.title) === key(album.title) && key(row["artist-credit"]![0]!.name!) === key(album.artist));
  return matches.length === 1 ? yearOf(matches[0]!["first-release-date"]) : undefined;
}
async function discogsYear(album: Album): Promise<number | undefined> {
  const token = process.env["DISCOGS_TOKEN"]?.trim();
  if (!token) throw new Error("falta DISCOGS_TOKEN");
  const url = new URL("https://api.discogs.com/database/search");
  url.search = new URLSearchParams({ artist: album.artist, release_title: album.title, type: "master", per_page: "25" }).toString();
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: { authorization: `Discogs token=${token}`, "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (response.ok) {
      const data = ((await response.json()) as { results?: Array<{ type?: string; title?: string; year?: string | number; id?: number }> }).results ?? [];
      const matches = data.filter((row) => {
        if (row.type !== "master" || typeof row.title !== "string") return false;
        const suffix = ` - ${album.title}`;
        if (!row.title.endsWith(suffix)) return false;
        const credited = row.title.slice(0, -suffix.length).replace(/\s+\(\d+\)$/u, "");
        return key(credited) === key(album.artist);
      });
      const years = [...new Set(matches.map((row) => Number(row.year)).filter((value) => Number.isInteger(value) && value >= 1950 && value <= 2027))];
      return years.length === 1 ? years[0] : undefined;
    }
    if ([429, 503].includes(response.status) && attempt < 3) {
      const seconds = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 5_000 * (attempt + 1);
      await pause(wait);
      continue;
    }
    throw new Error(`Discogs HTTP ${response.status}`);
  }
  return undefined;
}

async function main(): Promise<void> {
  const limitRaw = arg("--limit"); const limit = limitRaw === undefined ? undefined : numberArg("--limit", 1);
  const delay = numberArg("--delay-ms", 1_100);
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    const pending = await albums(pool, limit);
    const candidates: Candidate[] = []; const doubts: Doubt[] = []; let failures = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const album = pending[index]!;
      const votes: Record<string, number> = {};
      for (const [source, fn] of [["itunes", itunesYear], ["deezer", deezerYear], ["musicbrainz", musicbrainzYear], ["discogs", discogsYear]] as const) {
        try { const year = await fn(album); if (year !== undefined) votes[source] = year; }
        catch (error) { failures += 1; process.stderr.write(`album ${album.id} ${source}: ${(error as Error).message}\n`); }
      }
      const values = Object.values(votes);
      if (values.length === 0) { /* sin datos: silencio */ }
      else if (new Set(values).size === 1) {
        candidates.push({ albumId: album.id, title: album.title, artist: album.artist, year: values[0]!, sources: Object.keys(votes), all: votes });
      } else {
        const byYear = new Map<number, string[]>();
        for (const [source, year] of Object.entries(votes)) byYear.set(year, [...(byYear.get(year) ?? []), source]);
        const winner = [...byYear.entries()].sort((a, b) => b[1].length - a[1].length)[0]!;
        if (byYear.size === 2 && winner[1].length >= 2) {
          candidates.push({ albumId: album.id, title: album.title, artist: album.artist, year: winner[0], sources: winner[1], all: votes });
        } else {
          doubts.push({ albumId: album.id, title: album.title, artist: album.artist, votes, reason: "fuentes en desacuerdo" });
        }
      }
      if ((index + 1) % 20 === 0 || index + 1 === pending.length) {
        process.stdout.write(`consultados ${index + 1}/${pending.length}; candidatos ${candidates.length}; dudosos ${doubts.length}; fallos ${failures}\n`);
      }
      await pause(delay);
    }
    const out = path.resolve(ROOT, arg("--out") ?? "reports/album-years-candidates-2026-09-30.jsonl");
    const doubtsOut = path.resolve(ROOT, arg("--doubts") ?? "reports/album-years-doubts-2026-09-30.jsonl");
    await mkdir(path.dirname(out), { recursive: true });
    await writeFile(out, candidates.map((row) => JSON.stringify(row)).join("\n") + (candidates.length ? "\n" : ""));
    await writeFile(doubtsOut, doubts.map((row) => JSON.stringify(row)).join("\n") + (doubts.length ? "\n" : ""));
    process.stdout.write(`${JSON.stringify({ pending: pending.length, candidates: candidates.length, doubts: doubts.length, failures, out: path.relative(ROOT, out) })}\n`);
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
