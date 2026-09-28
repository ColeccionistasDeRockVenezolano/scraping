// Recupera arte y género ya extraídos de los snapshots originales. Solo toma
// discos que siguen sin portada, exige artista y título únicos y compara el
// año si ambas fichas lo tienen. Emite imagen y género en informes separados.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadDotenv } from "dotenv";
import pg from "pg";
import { normalizeIdentitySecondary } from "../src/normalization/claims.js";

loadDotenv();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MEDIA_OUT = path.join(ROOT, "reports", "media-source-claims-missing-candidates-2026-09-27.jsonl");
const GENRE_OUT = path.join(ROOT, "reports", "genre-source-claims-missing-evidence-2026-09-27.jsonl");
const SUMMARY_OUT = path.join(ROOT, "reports", "source-claims-missing-media-genres-2026-09-27.json");

interface Album { id: number; title: string; artist: string; year: number | null; }
interface ClaimRow { identity_key: string; source_id: string; slug: string; raw_page_id: string | null; stored_path: string | null; field: string; value: string | null; }
interface Candidate { kind: "album"; id: number; sourceUrl: string; label: string; artist: string; source: string; snapshot: string | null; signals: string[]; }
interface GenreEvidence { kind: "album"; entityId: number; rawGenre: string; source: string; snapshot: string | null; title: string; artist: string; year: number | null; signals: string[]; }

function key(value: string): string { return normalizeIdentitySecondary(value); }
function identity(artist: string, title: string): string { return `${key(artist)}\u0000${key(title)}`; }
function exactly(values: Set<string>): string | undefined { return values.size === 1 ? [...values][0] : undefined; }

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env["DATABASE_URL"] });
  try {
    const [albumsResult, claimsResult] = await Promise.all([
      pool.query<{ id: string; title: string; artist: string; year: number | null }>(`
        SELECT al.id::text,al.title,ar.name AS artist,al.release_year AS year
          FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id
         WHERE al.cover_url IS NULL ORDER BY al.id`),
      pool.query<ClaimRow>(`
        SELECT c.identity_key,c.source_id::text,s.slug,c.raw_page_id::text,r.stored_path,c.field,c.raw_value #>> '{}' AS value
          FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
          LEFT JOIN ingest.raw_pages r ON r.id=c.raw_page_id
         WHERE c.entity_kind='album' AND c.field IN ('cover_url','title','artist_name','release_year','genre')
           AND c.identity_key IS NOT NULL`),
    ]);
    const albums: Album[] = albumsResult.rows.map((row) => ({ id: Number(row.id), title: row.title, artist: row.artist, year: row.year }));
    const targets = new Map<string, Album[]>();
    for (const album of albums) { const id = identity(album.artist, album.title); targets.set(id, [...(targets.get(id) ?? []), album]); }
    const uniqueTargets = new Map([...targets].flatMap(([id, rows]) => rows.length === 1 ? [[id, rows[0]!] as const] : []));
    const groups = new Map<string, { slug: string; storedPath: string | null; fields: Map<string, Set<string>> }>();
    for (const row of claimsResult.rows) {
      const groupId = `${row.source_id}\u0000${row.identity_key}`;
      const group = groups.get(groupId) ?? { slug: row.slug, storedPath: row.stored_path, fields: new Map<string, Set<string>>() };
      if (row.value?.trim()) { const values = group.fields.get(row.field) ?? new Set<string>(); values.add(row.value.trim()); group.fields.set(row.field, values); }
      groups.set(groupId, group);
    }
    const media = new Map<number, Candidate>(); const genres = new Map<number, GenreEvidence>();
    const skipped: Record<string, number> = {}; const skip = (reason: string) => { skipped[reason] = (skipped[reason] ?? 0) + 1; };
    for (const group of groups.values()) {
      const cover = exactly(group.fields.get("cover_url") ?? new Set());
      if (!cover || !/^https?:\/\//u.test(cover)) continue;
      const title = exactly(group.fields.get("title") ?? new Set());
      const artist = exactly(group.fields.get("artist_name") ?? new Set());
      if (!title || !artist) { skip("missing_unique_identity"); continue; }
      const target = uniqueTargets.get(identity(artist, title));
      if (!target) { skip("not_unique_missing_target"); continue; }
      const yearValue = exactly(group.fields.get("release_year") ?? new Set()); const year = Number(yearValue);
      if (target.year !== null && Number.isSafeInteger(year) && year > 0 && target.year !== year) { skip("year_mismatch"); continue; }
      const signals = ["artist_name", "album_title", ...(target.year !== null && year > 0 ? ["release_year"] : [])];
      const candidate: Candidate = { kind: "album", id: target.id, sourceUrl: cover, label: target.title, artist: target.artist, source: group.slug, snapshot: group.storedPath, signals };
      const prior = media.get(target.id);
      if (!prior) media.set(target.id, candidate);
      else if (prior.sourceUrl !== candidate.sourceUrl) { media.delete(target.id); skip("conflicting_cover_sources"); }
      const genre = exactly(group.fields.get("genre") ?? new Set());
      if (!genre) continue;
      const evidence: GenreEvidence = { kind: "album", entityId: target.id, rawGenre: genre, source: group.slug, snapshot: group.storedPath, title: target.title, artist: target.artist, year: target.year, signals };
      const existingGenre = genres.get(target.id);
      if (!existingGenre) genres.set(target.id, evidence);
      else if (key(existingGenre.rawGenre) !== key(evidence.rawGenre)) { genres.delete(target.id); skip("conflicting_genre_sources"); }
    }
    await mkdir(path.dirname(MEDIA_OUT), { recursive: true });
    await writeFile(MEDIA_OUT, [...media.values()].map((row) => JSON.stringify(row)).join("\n") + (media.size ? "\n" : ""));
    await writeFile(GENRE_OUT, [...genres.values()].map((row) => JSON.stringify(row)).join("\n") + (genres.size ? "\n" : ""));
    await writeFile(SUMMARY_OUT, `${JSON.stringify({ missingAlbums: albums.length, uniqueTargets: uniqueTargets.size, claimGroups: groups.size, imageCandidates: media.size, genreEvidence: genres.size, skipped }, null, 2)}\n`);
    console.log(JSON.stringify({ missingAlbums: albums.length, imageCandidates: media.size, genreEvidence: genres.size, skipped, mediaOut: path.relative(ROOT, MEDIA_OUT), genreOut: path.relative(ROOT, GENRE_OUT) }));
  } finally { await pool.end(); }
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
