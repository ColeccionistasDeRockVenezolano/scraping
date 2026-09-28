// Reprocesa los snapshots locales de Sincopa únicamente para fichas de CRV
// que aún no tienen imagen. Genera dos ledgers independientes: candidatos de
// imagen para localize-images.ts y evidencia explícita de género. No escribe
// el core ni inventa asociaciones por texto libre.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { adapterFor } from "../src/adapters/registry.js";
import type { RawRecord } from "../src/adapters/contracts.js";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPORTS = path.join(ROOT, "reports");
const MEDIA_OUT = path.join(REPORTS, "media-sincopa-missing-candidates-2026-09-27.jsonl");
const GENRE_OUT = path.join(REPORTS, "genre-sincopa-missing-evidence-2026-09-27.jsonl");
const SUMMARY_OUT = path.join(REPORTS, "sincopa-missing-media-genres-2026-09-27.json");

type Kind = "artist" | "album";
interface Artist { id: number; name: string; }
interface Album { id: number; title: string; artist: string; year: number | null; }
interface Page { id: number; url: string; storedPath: string; }
interface MediaCandidate { kind: Kind; id: number; sourceUrl: string; label: string; artist?: string; source: "sincopa"; snapshot: string; snapshotSha256: string; signals: string[]; }
interface GenreEvidence { kind: Kind; entityId: number; rawGenre: string; source: "sincopa"; url: string; snapshot: string; snapshotSha256: string; title: string; artist?: string; year?: number | null; signals: string[]; }

function key(value: string): string { return normalizeIdentitySecondary(value); }
function albumKey(artist: string, title: string): string { return `${key(artist)}\u0000${key(title)}`; }
function field(record: RawRecord, name: string): string | undefined {
  const value = record.fields.find((item) => item.field === name)?.value;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function uniqueMap<T>(items: T[], identity: (item: T) => string): Map<string, T> {
  const grouped = new Map<string, T[]>();
  for (const item of items) { const id = identity(item); grouped.set(id, [...(grouped.get(id) ?? []), item]); }
  return new Map([...grouped].flatMap(([id, rows]) => rows.length === 1 ? [[id, rows[0]!] as const] : []));
}
function addUnique<T extends { kind: Kind; id?: number; entityId?: number }>(map: Map<string, T>, value: T): void {
  const id = value.id ?? value.entityId;
  if (id === undefined) throw new Error("registro sin id");
  const current = map.get(`${value.kind}:${id}`);
  // Dos URLs para la misma ficha son evidencia contradictoria; no se elige.
  if (!current) map.set(`${value.kind}:${id}`, value);
  else if (JSON.stringify(current) !== JSON.stringify(value)) map.delete(`${value.kind}:${id}`);
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    const [artistRows, albumRows, pageRows] = await Promise.all([
      pool.query<{ id: string; name: string }>("SELECT id::text,name FROM public.artists WHERE picture_url IS NULL ORDER BY id"),
      pool.query<{ id: string; title: string; artist: string; year: number | null }>(`
        SELECT al.id::text,al.title,ar.name AS artist,al.release_year AS year
          FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id
         WHERE al.cover_url IS NULL ORDER BY al.id`),
      pool.query<{ id: string; url: string; stored_path: string }>(`
        SELECT DISTINCT ON (r.url) r.id::text,r.url,r.stored_path
          FROM ingest.raw_pages r JOIN ingest.sources s ON s.id=r.source_id
         WHERE s.slug='sincopa' AND r.http_status=200 AND r.stored_path IS NOT NULL
           AND (r.url LIKE '%/artist_rock/%' OR r.url LIKE '%/cdinfo_rock/%')
         ORDER BY r.url,r.fetched_at DESC`),
    ]);
    const artists: Artist[] = artistRows.rows.map((row) => ({ id: Number(row.id), name: row.name }));
    const albums: Album[] = albumRows.rows.map((row) => ({ id: Number(row.id), title: row.title, artist: row.artist, year: row.year }));
    const pages: Page[] = pageRows.rows.map((row) => ({ id: Number(row.id), url: row.url, storedPath: row.stored_path }));
    const artistByName = uniqueMap(artists, (artist) => key(artist.name));
    const albumByIdentity = uniqueMap(albums, (album) => albumKey(album.artist, album.title));
    const catalogTitles = new Map<number, Set<string>>();
    const allAlbums = await pool.query<{ artist_id: string; title: string }>("SELECT artist_id::text,title FROM public.albums");
    for (const album of allAlbums.rows) {
      const titles = catalogTitles.get(Number(album.artist_id)) ?? new Set<string>(); titles.add(key(album.title)); catalogTitles.set(Number(album.artist_id), titles);
    }
    const adapter = adapterFor({ slug: "sincopa", siteType: "database" });
    if (!adapter?.extractSnapshot) throw new Error("adaptador Sincopa no disponible");
    const media = new Map<string, MediaCandidate>();
    const genres = new Map<string, GenreEvidence>();
    const skipped: Record<string, number> = {};
    const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
    for (const page of pages) {
      const file = path.resolve(ROOT, "data", page.storedPath);
      if (!file.startsWith(path.join(ROOT, "data", "raw", "sincopa") + path.sep)) throw new Error(`snapshot fuera de Sincopa: ${page.storedPath}`);
      let body: Buffer;
      try { body = await readFile(file); } catch { skip("snapshot_missing"); continue; }
      const records = adapter.extractSnapshot({ url: page.url, kind: "html", rawPageId: page.id,
        body: adapter.decodeBody ? adapter.decodeBody(body) : body.toString("utf8") });
      const sha = createHash("sha256").update(body).digest("hex");
      for (const record of records) {
        if (record.entityKind === "album") {
          const title = field(record, "title"); const artist = field(record, "artist_name");
          if (!title || !artist) { skip("album_without_identity"); continue; }
          const target = albumByIdentity.get(albumKey(artist, title));
          if (!target) { skip("album_not_unique_missing_target"); continue; }
          const parsedYear = Number(field(record, "release_year"));
          if (target.year !== null && Number.isSafeInteger(parsedYear) && parsedYear > 0 && target.year !== parsedYear) { skip("album_year_mismatch"); continue; }
          const signals = ["artist_name", "album_title", ...(target.year !== null && parsedYear > 0 ? ["release_year"] : [])];
          const cover = field(record, "cover_url");
          if (cover && /^https?:\/\//u.test(cover)) addUnique(media, { kind: "album", id: target.id, sourceUrl: cover, label: target.title, artist: target.artist, source: "sincopa", snapshot: page.storedPath, snapshotSha256: sha, signals });
          const genre = field(record, "genre");
          if (genre) addUnique(genres, { kind: "album", entityId: target.id, rawGenre: genre, source: "sincopa", url: page.url, snapshot: page.storedPath, snapshotSha256: sha, title: target.title, artist: target.artist, year: target.year, signals });
        }
        if (record.entityKind === "artist") {
          const name = field(record, "name"); if (!name) { skip("artist_without_name"); continue; }
          const target = artistByName.get(key(name));
          if (!target) { skip("artist_not_unique_missing_target"); continue; }
          const pageAlbums = records.filter((row) => row.entityKind === "album").map((row) => field(row, "title")).filter((value): value is string => Boolean(value));
          const known = catalogTitles.get(target.id) ?? new Set<string>();
          const crosscheck = pageAlbums.find((title) => known.has(key(title)));
          if (!crosscheck) { skip("artist_without_album_crosscheck"); continue; }
          const signals = ["artist_name", "album_title"];
          const photo = field(record, "picture_url");
          if (photo && /^https?:\/\//u.test(photo)) addUnique(media, { kind: "artist", id: target.id, sourceUrl: photo, label: target.name, source: "sincopa", snapshot: page.storedPath, snapshotSha256: sha, signals });
          const genre = field(record, "genre");
          if (genre) addUnique(genres, { kind: "artist", entityId: target.id, rawGenre: genre, source: "sincopa", url: page.url, snapshot: page.storedPath, snapshotSha256: sha, title: target.name, signals });
        }
      }
    }
    await mkdir(REPORTS, { recursive: true });
    await writeFile(MEDIA_OUT, [...media.values()].map((row) => JSON.stringify(row)).join("\n") + (media.size ? "\n" : ""));
    await writeFile(GENRE_OUT, [...genres.values()].map((row) => JSON.stringify(row)).join("\n") + (genres.size ? "\n" : ""));
    await writeFile(SUMMARY_OUT, `${JSON.stringify({ scannedPages: pages.length, missingArtists: artists.length, missingAlbums: albums.length, imageCandidates: media.size, genreEvidence: genres.size, skipped }, null, 2)}\n`);
    console.log(JSON.stringify({ scannedPages: pages.length, imageCandidates: media.size, genreEvidence: genres.size, skipped, mediaOut: path.relative(ROOT, MEDIA_OUT), genreOut: path.relative(ROOT, GENRE_OUT) }));
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
