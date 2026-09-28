// CRV · Vuelca las fichas sin género principal confirmado (y el catálogo de
// nombres para detectar homónimos) para scripts/recover-local-texts.py.
// Solo lectura.
import { writeFileSync } from "node:fs";
import { closeDb, getPool } from "../src/db/client.js";

const out = process.argv[2] ?? "reports/recover-pending-2026-09-27.json";
const p = getPool();
const albums = (await p.query(`
  SELECT al.id, al.title, al.release_year AS year, al.artist_id, ar.name AS artist,
         NOT EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id=al.id AND g.role='primary' AND g.status='confirmed') AS pending,
         coalesce((SELECT array_agg(DISTINCT a.alias) FROM ingest.album_aliases a WHERE a.album_id=al.id), '{}') AS aliases,
         coalesce((SELECT array_agg(DISTINCT c.raw_value #>> '{}') FROM ingest.claims c WHERE c.album_id=al.id AND c.field='source_url' AND c.status='accepted'), '{}') AS urls
    FROM public.albums al JOIN public.artists ar ON ar.id=al.artist_id`)).rows;
const artists = (await p.query(`
  SELECT ar.id, ar.name, ar.origin_city, ar.origin_country,
         NOT EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id=ar.id AND g.role='primary' AND g.status='confirmed') AS pending,
         coalesce((SELECT array_agg(DISTINCT a.alias) FROM ingest.artist_aliases a WHERE a.artist_id=ar.id), '{}') AS aliases,
         coalesce((SELECT array_agg(DISTINCT c.raw_value #>> '{}') FROM ingest.claims c WHERE c.artist_id=ar.id AND c.field='source_url' AND c.status='accepted'), '{}') AS urls
    FROM public.artists ar`)).rows;
const pages = (await p.query(`SELECT s.slug, r.url, r.stored_path FROM ingest.raw_pages r JOIN ingest.sources s ON s.id=r.source_id`)).rows;
const genres = (await p.query(`SELECT g.id, g.slug, g.name, g.active, coalesce((SELECT array_agg(a.alias_normalized) FROM ingest.genre_aliases a WHERE a.genre_id=g.id AND a.kind='genre'), '{}') AS aliases FROM ingest.genres g`)).rows;
writeFileSync(out, JSON.stringify({ albums, artists, pages, genres }));
console.log(out, albums.length, artists.length, pages.length);
await closeDb();
