// Lista las fichas que una fuente externa aún puede clasificar, para los
// cosechadores de géneros: artistas y discos sin principal confirmado, más los
// que tienen el principal elegido por Laya (la fuente manda sobre Laya:
// scripts/source-over-laya.ts). `allArtists` es el catálogo entero, para el
// cotejo de homónimos. Solo lectura.
// Uso: tsx scripts/export-genre-pending.mts > reports/genre-pending-<fecha>.json
import { closeDb, getPool } from "../src/db/client.js";

const pool = getPool();
const open = (table: string, column: string) => `NOT EXISTS (
  SELECT 1 FROM ingest.${table} g WHERE g.${column}=x.id AND g.role='primary' AND g.status='confirmed'
     AND g.decided_by IS DISTINCT FROM 'auto:laya')`;
const artists = (await pool.query(`SELECT x.id, x.name FROM public.artists x WHERE ${open("artist_genres", "artist_id")} ORDER BY x.id`)).rows;
const albums = (await pool.query(`SELECT x.id, x.title, x.artist_id FROM public.albums x WHERE ${open("album_genres", "album_id")} ORDER BY x.id`)).rows;
const allArtists = (await pool.query(`SELECT id, name FROM public.artists ORDER BY id`)).rows;
console.log(JSON.stringify({ artists, albums, allArtists }));
await closeDb();
