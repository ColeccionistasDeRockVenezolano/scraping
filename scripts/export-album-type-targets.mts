// Discos con tipo `other` (el valor por defecto) que el cosechador de tipos
// (scripts/harvest-album-types.py) puede resolver, con lo que ya dice el
// catálogo de cada uno: títulos crudos y URL de los posts de cada fuente, el
// formato de Sincopa y Rock De Vzla, las clasificaciones de la hoja y las
// ediciones «Main» de Discogs de los artistas ya identificados (caché de la
// etapa 4 de géneros; no hace peticiones). Solo lectura.
// Uso: tsx scripts/export-album-type-targets.mts > reports/album-type-targets-<fecha>.json
import { closeDb, getPool } from "../src/db/client.js";

const pool = getPool();
const albums = (await pool.query(`
  SELECT a.id::int, ar.name AS artist, a.artist_id::int, a.title, a.release_year AS yr,
         (SELECT count(*)::int FROM public.tracks t WHERE t.album_id = a.id) AS ntracks,
         (SELECT count(*)::int FROM public.albums o WHERE o.artist_id = a.artist_id AND o.id <> a.id) AS siblings,
         (SELECT coalesce(json_agg(DISTINCT x.classification), '[]') FROM ingest.album_classifications x WHERE x.album_id = a.id) AS classes,
         (SELECT coalesce(json_agg(json_build_object('s', s.slug, 'f', c.field, 'v', c.raw_value #>> '{}')), '[]')
            FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
           WHERE c.album_id = a.id AND c.entity_kind = 'album' AND c.field IN ('title', 'source_url', 'format')
             AND c.status IN ('accepted', 'superseded', 'candidate')) AS claims
    FROM public.albums a JOIN public.artists ar ON ar.id = a.artist_id
   WHERE a.album_type = 'other'
   ORDER BY a.id`)).rows;
const discogs = (await pool.query(`
  SELECT i.entity_id::int AS artist_id, r->>'id' AS id, r->>'title' AS title, r->>'year' AS year, r->>'format' AS format
    FROM ingest.genre_external_identities i
    JOIN ingest.genre_external_sources s ON s.id = i.source_id AND s.slug = 'discogs'
    JOIN ingest.genre_external_cache c ON c.source_id = i.source_id AND c.request_key LIKE 'artist:releases:' || i.external_id || '%'
    CROSS JOIN LATERAL jsonb_array_elements(c.payload->'releases') r
   WHERE i.status = 'matched' AND i.entity_kind = 'artist' AND r->>'type' = 'release' AND r->>'role' = 'Main'
     AND i.entity_id IN (SELECT artist_id FROM public.albums WHERE album_type = 'other')`)).rows;
console.log(JSON.stringify({ albums, discogs }));
await closeDb();
