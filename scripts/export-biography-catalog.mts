// CRV · Catálogo entero para el cosechador de biografías
// (scripts/harvest-biography-texts.py): artistas, discos, personas y
// organizaciones, con lo que ya casa cada ficha con una fuente (URLs de origen
// aceptadas e identidades externas confirmadas). A diferencia de
// export-genre-pending.mts no filtra nada: la biografía se completa o mejora
// en todas las fichas. Solo lectura.
// Uso: tsx scripts/export-biography-catalog.mts > reports/biography-catalog-<fecha>.json
import { closeDb, getPool } from "../src/db/client.js";

const pool = getPool();
const rows = async (sql: string) => (await pool.query(sql)).rows;

const artists = await rows(`SELECT id, name, artist_type, origin_city, origin_country, formed_year FROM public.artists ORDER BY id`);
const albums = await rows(`SELECT id, title, artist_id, release_year FROM public.albums ORDER BY id`);
// `related`: bandas y discos con los que el catálogo ya relaciona a la persona;
// una página externa con su nombre solo es suya si nombra alguno de ellos.
const persons = await rows(`
  SELECT p.id, p.name, p.is_venezuelan,
         EXISTS(SELECT 1 FROM public.artist_members m WHERE m.person_id=p.id) AS member,
         ARRAY(SELECT DISTINCT x FROM (
           SELECT a.name AS x FROM public.artist_members m JOIN public.artists a ON a.id=m.artist_id WHERE m.person_id=p.id
           UNION SELECT artist_name FROM public.person_album_credits WHERE person_id=p.id
           UNION SELECT album_title FROM public.person_album_credits WHERE person_id=p.id
           UNION SELECT al.title FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id
                   JOIN public.albums al ON al.id=t.album_id WHERE tc.person_id=p.id
           UNION SELECT a.name FROM public.track_credits tc JOIN public.tracks t ON t.id=tc.track_id
                   JOIN public.albums al ON al.id=t.album_id JOIN public.artists a ON a.id=al.artist_id WHERE tc.person_id=p.id
         ) r WHERE x IS NOT NULL) AS related
    FROM public.persons p ORDER BY p.id`);
const organizations = await rows(`
  SELECT o.id, o.name, o.organization_type, o.country,
         ARRAY(SELECT DISTINCT a.name FROM public.albums al JOIN public.artists a ON a.id=al.artist_id
                WHERE al.label_id=o.id) AS related
    FROM public.organizations o ORDER BY o.id`);
// URL de origen de cada ficha en las fuentes propias del proyecto.
const sourceUrls = await rows(`
  SELECT c.entity_kind AS kind, COALESCE(c.artist_id, c.album_id, c.person_id, c.organization_id) AS id,
         s.slug AS source, c.raw_value #>> '{}' AS url
    FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
   WHERE c.field='source_url' AND c.status='accepted'
     AND c.entity_kind IN ('artist','album','person','organization')
     AND COALESCE(c.artist_id, c.album_id, c.person_id, c.organization_id) IS NOT NULL`);
// Identidades ya decididas por los cosechadores de géneros (Discogs, MusicBrainz).
const identities = await rows(`
  SELECT i.entity_kind AS kind, i.entity_id AS id, s.slug AS source, i.external_id, i.external_url
    FROM ingest.genre_external_identities i JOIN ingest.genre_external_sources s ON s.id=i.source_id
   WHERE i.status='matched'`);

// Páginas de Sincopa ya guardadas por el fetcher (URL → archivo bajo DATA_DIR).
const rawPages = await rows(`
  SELECT r.url, r.stored_path FROM ingest.raw_pages r JOIN ingest.sources s ON s.id=r.source_id
   WHERE s.slug='sincopa' AND r.http_status=200`);

console.log(JSON.stringify({ artists, albums, persons, organizations, sourceUrls, identities, rawPages }));
await closeDb();
