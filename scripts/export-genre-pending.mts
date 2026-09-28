// Lista las fichas que una fuente externa aún puede clasificar, para los
// cosechadores de géneros: artistas y discos sin principal confirmado, más los
// que tienen el principal elegido por Laya (la fuente manda sobre Laya:
// scripts/source-over-laya.ts). `allArtists` es el catálogo entero, para el
// cotejo de homónimos; `catalogAlbums` y `members` (todos los discos e
// integrantes de cada artista) son la segunda prueba de identidad. Solo lectura.
// Uso: tsx scripts/export-genre-pending.mts > reports/genre-pending-<fecha>.json
import { closeDb, getPool } from "../src/db/client.js";

const pool = getPool();
const open = (table: string, column: string) => `NOT EXISTS (
  SELECT 1 FROM ingest.${table} g WHERE g.${column}=x.id AND g.role='primary' AND g.status='confirmed'
     AND g.decided_by IS DISTINCT FROM 'auto:laya')`;
const artists = (await pool.query(`SELECT x.id, x.name FROM public.artists x WHERE ${open("artist_genres", "artist_id")} ORDER BY x.id`)).rows;
const albums = (await pool.query(`SELECT x.id, x.title, x.artist_id FROM public.albums x WHERE ${open("album_genres", "album_id")} ORDER BY x.id`)).rows;
const allArtists = (await pool.query(`SELECT id, name FROM public.artists ORDER BY id`)).rows;
const catalogAlbums = (await pool.query(`SELECT id, title, artist_id, release_year FROM public.albums ORDER BY id`)).rows;
const members = (await pool.query(`
  SELECT DISTINCT m.artist_id, p.name FROM public.artist_members m JOIN public.persons p ON p.id=m.person_id ORDER BY 1, 2`)).rows;
console.log(JSON.stringify({ artists, albums, allArtists, catalogAlbums, members }));
await closeDb();
