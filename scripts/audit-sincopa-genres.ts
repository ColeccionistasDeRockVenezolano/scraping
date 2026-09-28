// CRV · Auditoría de géneros de Sincopa sobre las capturas ya guardadas.
//
// Pasa el adaptador por TODAS las páginas de Sincopa en data/raw (también
// jazz, latin_pop, classic, new_age… que el adaptador no recorre) y cruza cada
// género con las fichas del catálogo que siguen sin principal: álbum por
// artista + título normalizados, artista por nombre. Sin red. Escribe un libro
// de evidencia compatible con scripts/apply-source-genres.ts.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { load } from "cheerio";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { getEnv } from "../src/config/env.js";
import { closeDb, getPool } from "../src/db/client.js";

const OUT = "reports/genre-laya-evidence-sincopa-audit-2026-09-26.jsonl";

function norm(text: string): string {
  return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/^(the|los|las|la|el)\s+/u, "").replace(/[^a-z0-9]+/gu, "");
}

/** El adaptador solo reconoce rutas rock_pop; las demás secciones comparten plantilla. */
function asRockUrl(url: string): string | null {
  const u = new URL(url);
  if (/\/(artist_rock|artists?|artists_lat|artist_class|artist_newage|artists1)\//i.test(u.pathname)) {
    return `${u.origin}/rock_pop/artist_rock/${path.basename(u.pathname)}`;
  }
  if (/\/(cdinfo_rock|cdinfo|cdinfo_latin|cdinfo_class|cdinfo_age|cdinfo2)\//i.test(u.pathname)) {
    return `${u.origin}/rock_pop/cdinfo_rock/${path.basename(u.pathname)}`;
  }
  return null;
}

async function main(): Promise<void> {
  const pool = getPool();
  const pages = (await pool.query<{ url: string; stored_path: string }>(`
    SELECT DISTINCT ON (r.url) r.url, r.stored_path FROM ingest.raw_pages r JOIN ingest.sources s ON s.id=r.source_id
     WHERE s.slug='sincopa' ORDER BY r.url, r.fetched_at DESC`)).rows;
  // Fichas enlazadas que nunca se bajaron (scripts/fetch-sincopa-missing-pages.py).
  const extraIndex = path.join(getEnv().DATA_DIR, "raw", "sincopa-extra", "index.jsonl");
  if (existsSync(extraIndex)) {
    for (const line of readFileSync(extraIndex, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as { url: string; file: string | null };
      if (entry.file) pages.push({ url: entry.url, stored_path: `raw/sincopa-extra/${entry.file}` });
    }
  }
  const pendingAlbums = (await pool.query<{ id: number; title: string; artist: string; release_year: number | null }>(`
    SELECT al.id::int, al.title, ar.name AS artist, al.release_year FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id
     WHERE NOT EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id=al.id AND g.role='primary' AND g.status='confirmed')`)).rows;
  const pendingArtists = (await pool.query<{ id: number; name: string }>(`
    SELECT a.id::int, a.name FROM public.artists a
     WHERE NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id=a.id AND g.role='primary' AND g.status='confirmed')`)).rows;

  const albumKey = new Map<string, typeof pendingAlbums>();
  // Segunda llave sin el paréntesis final: el catálogo escribe «Simple (Pop)»
  // donde Sincopa dice «Simple». Si ambas llaves apuntan a la misma ficha no
  // se duplica; si la llave corta es ambigua, la exacta sigue mandando.
  const bare = (title: string): string => norm(title.replace(/\s*\([^)]*\)\s*$/u, ""));
  for (const album of pendingAlbums) {
    for (const key of new Set([`${norm(album.artist)}::${norm(album.title)}`, `${norm(album.artist)}::${bare(album.title)}`])) {
      albumKey.set(key, [...(albumKey.get(key) ?? []), album]);
    }
  }
  const artistKey = new Map<string, typeof pendingArtists>();
  for (const artist of pendingArtists) artistKey.set(norm(artist.name), [...(artistKey.get(norm(artist.name)) ?? []), artist]);

  const adapter = new SincopaAdapter();
  const dataDir = getEnv().DATA_DIR;
  const stats = { pages: pages.length, parsed: 0, withGenre: { album: 0, artist: 0 }, matched: { album: 0, artist: 0 }, ambiguous: 0, bySection: {} as Record<string, number> };
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    const rockUrl = asRockUrl(page.url);
    if (!rockUrl) continue;
    const body = new TextDecoder("windows-1252").decode(readFileSync(path.join(dataDir, page.stored_path)));
    stats.parsed += 1;
    for (const record of adapter.extract(load(body), rockUrl)) {
      const text = (name: string): string => String(record.fields.find((field) => field.field === name)?.value ?? "");
      if (record.entityKind !== "album" && record.entityKind !== "artist") continue;
      const genre = text("genre");
      if (!genre) continue;
      stats.withGenre[record.entityKind] += 1;
      let hits: Array<{ id: number }>;
      let title: string;
      if (record.entityKind === "album") {
        const artist = text("artist_name");
        title = text("title");
        hits = albumKey.get(`${norm(artist)}::${norm(title)}`) ?? albumKey.get(`${norm(artist)}::${bare(title)}`) ?? [];
      } else {
        title = text("name");
        hits = artistKey.get(norm(title)) ?? [];
      }
      if (hits.length > 1) { stats.ambiguous += 1; continue; }
      const hit = hits[0];
      if (!hit) continue;
      const caseId = `${record.entityKind}:${hit.id}`;
      if (seen.has(caseId)) continue;
      seen.add(caseId);
      stats.matched[record.entityKind] += 1;
      const section = new URL(page.url).pathname.split("/")[1] ?? "";
      stats.bySection[section] = (stats.bySection[section] ?? 0) + 1;
      lines.push(JSON.stringify({
        caseId, kind: record.entityKind, entityId: hit.id, source: "sincopa", rawGenre: genre, url: page.url,
        snapshot: page.stored_path, title, signals: record.entityKind === "album" ? ["artist_name", "album_title"] : ["artist_name"],
      }));
    }
  }
  writeFileSync(OUT, lines.join("\n") + (lines.length ? "\n" : ""));
  console.log(JSON.stringify(stats, null, 2));
  console.log(`libro: ${OUT}`);
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
