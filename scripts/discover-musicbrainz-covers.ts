// Busca portadas canónicas en MusicBrainz/CAA para discos sin cover_url.
// Se acepta solo un release group cuyo título y crédito de artista coincidan
// exactamente tras normalización. El CAA confirma que ese grupo tiene un
// frente aprobado antes de producir un candidato para localize-images.ts.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { normalizeEntityName } from "../src/normalization/entity-name.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "reports", "media-musicbrainz-caa-album-candidates-2026-09-27.jsonl");
const USER_AGENT = "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)";

interface Album { id: number; title: string; artist: string; }
interface ArtistCredit { name?: string; joinphrase?: string; artist?: { name?: string }; }
interface ReleaseGroup { id?: string; title?: string; "artist-credit"?: ArtistCredit[]; }
interface CaaImage { image?: string; front?: boolean; approved?: boolean; }
interface Candidate { kind: "album"; id: number; sourceUrl: string; label: string; artist: string; source: "musicbrainz-caa"; releaseGroupId: string; }

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; }
function positive(name: string, fallback: number): number {
  const raw = arg(name); if (raw === undefined) return fallback;
  const value = Number(raw); if (!Number.isInteger(value) || value < 1) throw new Error(`${name} debe ser entero positivo`);
  return value;
}
function key(value: string): string { return normalizeEntityName(value).secondaryKey; }
function escaped(value: string): string { return value.replace(/([+\-!(){}[\]^"~*?:\\/]|&&|\|\|)/gu, "\\$1"); }
function artistCredit(group: ReleaseGroup): string {
  return (group["artist-credit"] ?? []).map((part) => `${part.name ?? part.artist?.name ?? ""}${part.joinphrase ?? ""}`).join("").trim();
}
async function pause(ms: number): Promise<void> { await new Promise((resolve) => setTimeout(resolve, ms)); }

async function fetchJson(url: string, label: string, allowNotFound = false): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(30_000) });
    if (response.ok) return await response.json() as Record<string, unknown>;
    if (allowNotFound && response.status === 404) return undefined;
    if ((response.status === 429 || response.status === 503) && attempt < 3) {
      const seconds = Number(response.headers.get("retry-after"));
      const delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1_000 : 5_000 * (attempt + 1);
      process.stderr.write(`${label}: HTTP ${response.status}; reintento en ${delay} ms\n`);
      await pause(delay);
      continue;
    }
    throw new Error(`${label} HTTP ${response.status}`);
  }
  throw new Error(`${label} agotó los reintentos`);
}

async function missing(pool: pg.Pool): Promise<Album[][]> {
  const { rows } = await pool.query<{ id: string; title: string; artist: string }>(`
    SELECT al.id::text, al.title, ar.name AS artist
      FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id
     WHERE al.cover_url IS NULL
     ORDER BY al.id`);
  const groups = new Map<string, Album[]>();
  for (const row of rows) {
    const identity = `${key(row.artist)}\u0000${key(row.title)}`;
    groups.set(identity, [...(groups.get(identity) ?? []), { id: Number(row.id), title: row.title, artist: row.artist }]);
  }
  return [...groups.values()];
}

async function releaseGroups(album: Album): Promise<ReleaseGroup[]> {
  const url = new URL("https://musicbrainz.org/ws/2/release-group");
  url.search = new URLSearchParams({
    query: `releasegroup:"${escaped(album.title)}" AND artist:"${escaped(album.artist)}"`, fmt: "json", limit: "10",
  }).toString();
  const payload = await fetchJson(url.toString(), "MusicBrainz");
  return (payload?.["release-groups"] as ReleaseGroup[] | undefined) ?? [];
}

async function approvedFront(releaseGroupId: string): Promise<string | undefined> {
  const payload = await fetchJson(`https://coverartarchive.org/release-group/${encodeURIComponent(releaseGroupId)}`, "Cover Art Archive", true);
  const images = (payload?.["images"] as CaaImage[] | undefined) ?? [];
  const fronts = images.filter((image) => image.front === true && image.approved === true && typeof image.image === "string");
  return fronts.length === 1 ? fronts[0]!.image : undefined;
}

async function main(): Promise<void> {
  const limit = arg("--limit") === undefined ? undefined : positive("--limit", 1);
  const delay = positive("--delay-ms", 1_400);
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    const identities = await missing(pool);
    const selected = limit === undefined ? identities : identities.slice(0, limit);
    const candidates: Candidate[] = []; let failures = 0; let exact = 0;
    for (let index = 0; index < selected.length; index += 1) {
      const albums = selected[index]!; const album = albums[0]!;
      try {
        const matches = (await releaseGroups(album)).filter((group) => group.id && group.title && key(group.title) === key(album.title) && key(artistCredit(group)) === key(album.artist));
        const distinct = [...new Map(matches.map((group) => [group.id!, group])).values()];
        if (distinct.length === 1) {
          exact += 1;
          const sourceUrl = await approvedFront(distinct[0]!.id!);
          if (sourceUrl) candidates.push(...albums.map((row) => ({ kind: "album" as const, id: row.id, sourceUrl, label: row.title, artist: row.artist, source: "musicbrainz-caa" as const, releaseGroupId: distinct[0]!.id! })));
        }
      } catch (error) { failures += 1; process.stderr.write(`album ${album.id}: ${(error as Error).message}\n`); }
      if ((index + 1) % 25 === 0 || index + 1 === selected.length) process.stdout.write(`consultados ${index + 1}/${selected.length}; coincidencias exactas ${exact}; candidatos ${candidates.length}; fallos ${failures}\n`);
      await pause(delay);
    }
    await mkdir(path.dirname(OUT), { recursive: true });
    await writeFile(OUT, candidates.map((row) => JSON.stringify(row)).join("\n") + (candidates.length ? "\n" : ""));
    process.stdout.write(`${JSON.stringify({ identities: selected.length, candidates: candidates.length, failures, out: path.relative(ROOT, OUT) })}\n`);
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
