// Busca portadas de discos que siguen vacíos en iTunes Search. Solo emite un
// candidato si artista y título coinciden de forma exacta tras normalización;
// descargar y asociar queda a cargo de localize-images.ts.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "reports", "media-itunes-album-candidates-2026-09-27.jsonl");

interface Album { id: number; title: string; artist: string; }
interface ItunesResult { wrapperType?: string; artistName?: string; collectionName?: string; artworkUrl100?: string; collectionId?: number; }
interface Candidate { kind: "album"; id: number; sourceUrl: string; label: string; artist: string; source: "itunes"; collectionId: number; }

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function numberArg(name: string, fallback: number): number { const raw = arg(name); if (raw === undefined) return fallback; const n = Number(raw); if (!Number.isInteger(n) || n < 1) throw new Error(`${name} debe ser entero positivo`); return n; }
function key(value: string): string { return normalizeEntityName(value).secondaryKey; }
async function pause(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function albums(pool: pg.Pool, limit: number | undefined): Promise<Album[]> {
  const { rows } = await pool.query<{ id: string; title: string; artist: string }>(`
    SELECT al.id::text,al.title,ar.name AS artist FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id
    WHERE al.cover_url IS NULL ORDER BY al.id`);
  const unique = new Map<string, Album>();
  for (const row of rows) {
    const identity = `${key(row.artist)}\u0000${key(row.title)}`;
    if (!unique.has(identity)) unique.set(identity, { id: Number(row.id), title: row.title, artist: row.artist });
  }
  const result = [...unique.values()];
  return limit === undefined ? result : result.slice(0, limit);
}
async function search(album: Album): Promise<ItunesResult[]> {
  const url = new URL("https://itunes.apple.com/search");
  url.search = new URLSearchParams({ term: `${album.artist} ${album.title}`, country: "VE", media: "music", entity: "album", limit: "20" }).toString();
  const response = await fetch(url, { headers: { "user-agent": "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)" }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`iTunes HTTP ${response.status}`);
  return ((await response.json()) as { results?: ItunesResult[] }).results ?? [];
}
function pick(album: Album, results: ItunesResult[]): Candidate | undefined {
  const matches = results.filter((result) => result.wrapperType === "collection" && result.artistName && result.collectionName && result.artworkUrl100 && result.collectionId
    && key(result.artistName) === key(album.artist) && key(result.collectionName) === key(album.title));
  if (matches.length !== 1) return undefined;
  const result = matches[0]!;
  // Apple entrega 100px en la búsqueda, pero el CDN permite una versión de
  // portada adecuada para la ficha sin alterar la identidad del recurso.
  const sourceUrl = result.artworkUrl100!.replace(/100x100(?:bb|-[0-9]+)?/u, "600x600bb");
  return { kind: "album", id: album.id, sourceUrl, label: album.title, artist: album.artist, source: "itunes", collectionId: result.collectionId! };
}

async function main(): Promise<void> {
  const limitRaw = arg("--limit"); const limit = limitRaw === undefined ? undefined : numberArg("--limit", 1);
  const delay = numberArg("--delay-ms", 900); const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    const pending = await albums(pool, limit); const candidates: Candidate[] = []; let failures = 0;
    for (let index = 0; index < pending.length; index += 1) {
      const album = pending[index]!;
      try { const candidate = pick(album, await search(album)); if (candidate) candidates.push(candidate); }
      catch (error) { failures += 1; process.stderr.write(`album ${album.id}: ${(error as Error).message}\n`); }
      if ((index + 1) % 25 === 0 || index + 1 === pending.length) process.stdout.write(`consultados ${index + 1}/${pending.length}; candidatos ${candidates.length}; fallos ${failures}\n`);
      await pause(delay);
    }
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, candidates.map((candidate) => JSON.stringify(candidate)).join("\n") + (candidates.length ? "\n" : ""));
    process.stdout.write(`${JSON.stringify({ pending: pending.length, candidates: candidates.length, failures, out: path.relative(ROOT, OUT) })}\n`);
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
