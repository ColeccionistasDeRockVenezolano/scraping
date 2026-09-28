// CRV · Géneros de Sincopa que ya están enlazados a la ficha por su source_url
// y que el cruce por nombre no aplicó (p. ej. disco asignado a un músico en
// vez de a la banda: la página sigue siendo la de ESE disco). Solo lectura:
// escribe filas que scripts/recover-local-texts.py funde en el libro local.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { load } from "cheerio";
import { SincopaAdapter } from "../src/adapters/sincopa.js";
import { getEnv } from "../src/config/env.js";
import { closeDb, getPool } from "../src/db/client.js";

const OUT = process.argv[2] ?? "reports/recover-sincopa-linked-2026-09-27.jsonl";
const canon = (url: string): string => url.replace(/^https?:\/\//u, "").replace(/^www\./u, "").replace(/[?#].*$/u, "").replace(/\/+$/u, "").toLowerCase();

function asRockUrl(url: string): string | null {
  const u = new URL(url);
  if (/\/(artist_rock|artists?|artists_lat|artist_class|artist_newage|artists1)\//i.test(u.pathname)) return `${u.origin}/rock_pop/artist_rock/${path.basename(u.pathname)}`;
  if (/\/(cdinfo_rock|cdinfo|cdinfo_latin|cdinfo_class|cdinfo_age|cdinfo2|compilations1)\//i.test(u.pathname)) return `${u.origin}/rock_pop/cdinfo_rock/${path.basename(u.pathname)}`;
  return null;
}

async function main(): Promise<void> {
  const pool = getPool();
  const dataDir = getEnv().DATA_DIR;
  const pages = new Map<string, { url: string; file: string }>();
  for (const row of (await pool.query<{ url: string; stored_path: string }>(`
    SELECT DISTINCT ON (r.url) r.url, r.stored_path FROM ingest.raw_pages r JOIN ingest.sources s ON s.id=r.source_id
     WHERE s.slug='sincopa' ORDER BY r.url, r.fetched_at DESC`)).rows) pages.set(canon(row.url), { url: row.url, file: row.stored_path });
  const extra = path.join(dataDir, "raw", "sincopa-extra", "index.jsonl");
  if (existsSync(extra)) for (const line of readFileSync(extra, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as { url: string; file: string | null };
    if (entry.file && !pages.has(canon(entry.url))) pages.set(canon(entry.url), { url: entry.url, file: `raw/sincopa-extra/${entry.file}` });
  }
  const links = (await pool.query<{ kind: "album" | "artist"; id: number; title: string; artist: string | null; url: string }>(`
    SELECT 'album' AS kind, al.id::int, al.title, ar.name AS artist, c.raw_value #>> '{}' AS url
      FROM ingest.claims c JOIN public.albums al ON al.id=c.album_id JOIN public.artists ar ON ar.id=al.artist_id
     WHERE c.field='source_url' AND c.status='accepted' AND c.entity_kind='album' AND c.raw_value #>> '{}' ILIKE '%sincopa.com%'
       AND NOT EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id=al.id AND g.role='primary' AND g.status='confirmed')
    UNION
    SELECT 'artist', ar.id::int, ar.name, NULL, c.raw_value #>> '{}'
      FROM ingest.claims c JOIN public.artists ar ON ar.id=c.artist_id
     WHERE c.field='source_url' AND c.status='accepted' AND c.entity_kind='artist' AND c.raw_value #>> '{}' ILIKE '%sincopa.com%'
       AND NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id=ar.id AND g.role='primary' AND g.status='confirmed')`)).rows;

  const adapter = new SincopaAdapter();
  const stats = { links: links.length, withPage: 0, withGenre: 0, noPage: 0 };
  const out: string[] = [];
  for (const link of links) {
    const page = pages.get(canon(link.url));
    const rock = asRockUrl(link.url);
    if (!page || !rock) { stats.noPage += 1; continue; }
    stats.withPage += 1;
    const body = new TextDecoder("windows-1252").decode(readFileSync(path.join(dataDir, page.file)));
    for (const record of adapter.extract(load(body), rock)) {
      if (record.entityKind !== link.kind) continue;
      const text = (name: string): string => String(record.fields.find((field) => field.field === name)?.value ?? "");
      const genre = text("genre").trim();
      if (!genre) continue;
      stats.withGenre += 1;
      out.push(JSON.stringify({
        caseId: `${link.kind}:${link.id}`, kind: link.kind, entityId: link.id, source: "sincopa", url: link.url, title: link.title,
        rawGenres: [genre], pageArtist: text("artist_name") || text("name"), pageTitle: text("title"), catalogArtist: link.artist,
      }));
      break;
    }
  }
  writeFileSync(OUT, out.join("\n") + (out.length ? "\n" : ""));
  console.log(JSON.stringify({ ...stats, out: OUT }));
  await closeDb();
}

main().catch(async (error) => { console.error(error); await closeDb(); process.exit(1); });
