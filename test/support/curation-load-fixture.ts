// CRV · Catálogo de carga para medir el rendimiento de Curaduría
// (PLAN_CURADURIA E9.5: «< 5 s para el completo con el doble de catálogo»).
//
// No inventa nombres: copia en el contenedor la foto real del catálogo
// (`catalog-2026-09-16.json.gz`, 44.471 fichas) tantas veces como se le pida.
// Un catálogo inventado mide otra cosa —el vocabulario se aprende de los
// nombres, y unos nombres sintéticos no tienen ni las marcas de sello ni los
// nombres de pila ni las repeticiones que hacen trabajar a los detectores—,
// así que el doble del catálogo real es el doble del trabajo real.
//
// Cada copia lleva sus ids desplazados un millón, y a partir de la segunda los
// ARTISTAS llevan sufijo: `public.artists.name` es UNIQUE en el core y el core
// no se toca. Lo demás se copia tal cual, con lo que la segunda copia trae
// además su ración de fichas repetidas: el análisis tiene más que hacer, no
// menos, que con un catálogo del mismo tamaño.
import type { Pool } from "pg";
import { loadCatalogFixture } from "./curation-catalog-fixture.js";

/** Separación entre copias (y respecto de lo que ya hubiera): la foto real no llega a 30.000 filas por tabla. */
const ID_OFFSET = 1_000_000;
const CHUNK = 2_000;

/** Sufijo de la copia n (la primera va sin sufijo). */
const COPY_SUFFIX = ["", " II", " III", " IV", " V"];

export interface LoadedCatalog {
  artists: number; persons: number; organizations: number; albums: number; tracks: number; members: number;
  /** Filas del core insertadas en total. */
  rows: number;
}

async function insertAll(pool: Pool, sql: string, rows: unknown[]): Promise<number> {
  for (let offset = 0; offset < rows.length; offset += CHUNK) {
    await pool.query(sql, [JSON.stringify(rows.slice(offset, offset + CHUNK))]);
  }
  return rows.length;
}

/**
 * Inserta `copies` copias de la foto real. Devuelve lo insertado; deja las
 * secuencias de identidad por encima de los ids usados para que el resto de la
 * prueba pueda seguir escribiendo con normalidad.
 */
export async function loadCatalogCopies(pool: Pool, copies: number): Promise<LoadedCatalog> {
  const snapshot = loadCatalogFixture();
  const counts: LoadedCatalog = { artists: 0, persons: 0, organizations: 0, albums: 0, tracks: 0, members: 0, rows: 0 };

  for (let copy = 0; copy < copies; copy += 1) {
    // Desde un millón hacia arriba: las fichas que la prueba creó a mano
    // ocupan los ids bajos y el core no admite dos artistas con el mismo id.
    const shift = (copy + 1) * ID_OFFSET;
    const suffix = COPY_SUFFIX[copy] ?? ` ${copy + 1}`;

    counts.organizations += await insertAll(pool, `
      INSERT INTO public.organizations (id, name, organization_type) OVERRIDING SYSTEM VALUE
      SELECT id, name, type::organization_type FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, name text, type text)`,
    snapshot.organizations.map((org) => ({ id: org.id + shift, name: org.name, type: org.type })));

    counts.artists += await insertAll(pool, `
      INSERT INTO public.artists (id, name, origin_city, formed_year, disbanded_year) OVERRIDING SYSTEM VALUE
      SELECT id, name, city, formed, disbanded FROM jsonb_to_recordset($1::jsonb)
        AS x(id bigint, name text, city text, formed smallint, disbanded smallint)`,
    snapshot.artists.map((artist) => ({
      id: artist.id + shift, name: `${artist.name}${suffix}`.slice(0, 200), city: artist.originCity,
      formed: artist.formedYear, disbanded: artist.disbandedYear,
    })));

    counts.persons += await insertAll(pool, `
      INSERT INTO public.persons (id, name) OVERRIDING SYSTEM VALUE
      SELECT id, name FROM jsonb_to_recordset($1::jsonb) AS x(id bigint, name text)`,
    snapshot.persons.map((person) => ({ id: person.id + shift, name: person.name })));

    counts.albums += await insertAll(pool, `
      INSERT INTO public.albums (id, artist_id, title, release_year, album_type) OVERRIDING SYSTEM VALUE
      SELECT id, artist_id, title, year, type::album_type FROM jsonb_to_recordset($1::jsonb)
        AS x(id bigint, artist_id bigint, title text, year smallint, type text)`,
    snapshot.albums.map((album) => ({
      id: album.id + shift, artist_id: album.artistId + shift, title: album.title, year: album.releaseYear, type: album.albumType,
    })));

    counts.tracks += await insertAll(pool, `
      INSERT INTO public.tracks (id, album_id, disc_number, track_number, title, duration_seconds) OVERRIDING SYSTEM VALUE
      SELECT id, album_id, disc, number, title, duration FROM jsonb_to_recordset($1::jsonb)
        AS x(id bigint, album_id bigint, disc smallint, number smallint, title text, duration integer)`,
    snapshot.tracks.map((track) => ({
      id: track.id + shift, album_id: track.albumId + shift, disc: track.disc, number: track.number,
      title: track.title, duration: track.durationSeconds,
    })));

    // Los vínculos de persona vienen de la foto (`personArtists`): sin ellos
    // todas las personas serían huérfanas y el análisis mediría un catálogo
    // que no existe.
    const members = [...snapshot.personArtists].flatMap(([personId, artistIds]) =>
      [...artistIds].map((artistId) => ({ person: personId + shift, artist: artistId + shift })));
    counts.members += await insertAll(pool, `
      INSERT INTO public.artist_members (artist_id, person_id, role)
      SELECT artist, person, 'músico' FROM jsonb_to_recordset($1::jsonb) AS x(artist bigint, person bigint)`, members);
  }

  for (const table of ["organizations", "artists", "persons", "albums", "tracks"]) {
    await pool.query(
      `SELECT setval(pg_get_serial_sequence('public.${table}', 'id'), coalesce((SELECT max(id) FROM public.${table}), 1))`);
  }
  await pool.query("ANALYZE");
  counts.rows = counts.artists + counts.persons + counts.organizations + counts.albums + counts.tracks + counts.members;
  return counts;
}
