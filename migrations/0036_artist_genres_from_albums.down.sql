-- ============================================================================
-- CRV · Migración 0036_artist_genres_from_albums (DOWN)
-- Quita la regla «el artista suma los géneros de sus discos»: disparadores
-- (incluido el de public.albums, quinta excepción al core), funciones, la tabla
-- de pendientes y las filas derivadas. Lo que una persona confirmó sobre una
-- fila derivada se conserva como decisión editorial.
-- ============================================================================

BEGIN;

DROP TRIGGER IF EXISTS crv_artist_genres_from_albums ON public.albums;
DROP TRIGGER IF EXISTS crv_artist_genres_from_albums ON ingest.album_genres;
DROP TRIGGER IF EXISTS crv_artist_genres_from_albums ON ingest.artist_genres;
DROP TRIGGER IF EXISTS crv_artist_genres_flush ON ingest.artist_genres_pending;
DROP FUNCTION IF EXISTS ingest.crv_artist_genres_flush();
DROP FUNCTION IF EXISTS ingest.crv_artist_genres_mark();
DROP FUNCTION IF EXISTS ingest.crv_derive_artist_genres(BIGINT, BOOLEAN);
DROP TABLE IF EXISTS ingest.artist_genres_pending;

DELETE FROM ingest.artist_genres WHERE source_kind = 'albums' AND decision_kind = 'rule';
UPDATE ingest.artist_genres SET source_kind = 'editorial' WHERE source_kind = 'albums';
-- Las FK diferidas de esas filas se comprueban ya: ALTER TABLE no admite eventos pendientes.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE ingest.artist_genres DROP CONSTRAINT IF EXISTS artist_genres_source_kind_chk;
ALTER TABLE ingest.artist_genres ADD CONSTRAINT artist_genres_source_kind_chk
  CHECK (source_kind IN ('catalog_source', 'editorial', 'external', 'ai'));

COMMIT;
