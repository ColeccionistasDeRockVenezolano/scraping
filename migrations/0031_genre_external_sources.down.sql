-- ============================================================================
-- CRV · Migración 0031_genre_external_sources (DOWN)
-- Quita las fichas de fuentes externas, su caché, sus identidades y el
-- registro de importaciones, y con ellos las sugerencias externas vivas.
-- Las decisiones editoriales NO se pierden: solo se borran las filas
-- `source_kind = 'external'` que siguen en `suggested` (propuestas sin
-- resolver). Lo que una persona confirmó o rechazó es `decision_kind = 'human'`
-- y se queda; solo pierde el puntero a la ficha de la fuente externa.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DELETE FROM ingest.album_genres  WHERE source_kind = 'external' AND status = 'suggested' AND decision_kind = 'rule';
DELETE FROM ingest.artist_genres WHERE source_kind = 'external' AND status = 'suggested' AND decision_kind = 'rule';

-- Los avisos que abrió la importación (coincidencia dudosa, desacuerdo con
-- CRV, término sin equivalencia, etiqueta demasiado general) hablan de filas
-- que dejan de existir.
DELETE FROM ingest.review_queue WHERE kind = 'genre_unknown' AND payload->>'origin' = 'genres-external';

ALTER TABLE ingest.album_genres
  DROP CONSTRAINT IF EXISTS album_genres_external_chk,
  DROP COLUMN IF EXISTS external_source_id,
  DROP COLUMN IF EXISTS external_ref;
ALTER TABLE ingest.artist_genres
  DROP CONSTRAINT IF EXISTS artist_genres_external_chk,
  DROP COLUMN IF EXISTS external_source_id,
  DROP COLUMN IF EXISTS external_ref;

DROP TABLE IF EXISTS ingest.genre_external_imports;
DROP TABLE IF EXISTS ingest.genre_external_identities;
DROP TABLE IF EXISTS ingest.genre_external_cache;
DROP TABLE IF EXISTS ingest.genre_external_sources;

COMMIT;
