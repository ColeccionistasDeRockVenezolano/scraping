-- ============================================================================
-- CRV · Migración 0027_genre_taxonomy (DOWN)
-- Quita asignaciones, alias y registro de cambios, y devuelve `ingest.genres`
-- a su forma de 0001. El runner (`src/db/migrate.ts`) se niega a aplicarla
-- con GENRES_PROJECTION_ENABLED encendido: sin tablas de asignaciones, el
-- único escritor de `albums.genre` tiene que volver a ser el motor de fusión.
-- `albums.genre` (core) no se toca: conserva el último texto proyectado.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

-- Los avisos que abrieron las reglas de géneros hablan de filas que dejan de
-- existir. Otras revisiones `genre_unknown` (sin ese origen) no se tocan.
DELETE FROM ingest.review_queue
 WHERE kind = 'genre_unknown' AND payload->>'origin' IN ('genres', 'genres-taxonomy', 'genres-merge');

DROP TABLE IF EXISTS ingest.album_genres;
DROP TABLE IF EXISTS ingest.artist_genres;
DROP FUNCTION IF EXISTS ingest.genre_assignment_active_genre();
DROP TABLE IF EXISTS ingest.genre_assignment_log;
DROP TABLE IF EXISTS ingest.genre_taxonomy_changes;
DROP TABLE IF EXISTS ingest.genre_aliases;

DROP TRIGGER IF EXISTS genres_parent_is_family_trg ON ingest.genres;
DROP FUNCTION IF EXISTS ingest.genres_parent_is_family();
DROP INDEX IF EXISTS ingest.genres_parent_idx;
DROP INDEX IF EXISTS ingest.genres_replaced_by_idx;
-- La taxonomía no cabe en la forma de 0001 (sin slug ni familia): se vacía.
DELETE FROM ingest.genres;
ALTER TABLE ingest.genres
  DROP CONSTRAINT IF EXISTS genres_not_self_replaced_chk,
  DROP CONSTRAINT IF EXISTS genres_inactive_replacement_chk,
  DROP CONSTRAINT IF EXISTS genres_replaced_by_fk,
  DROP CONSTRAINT IF EXISTS genres_parent_fk,
  DROP CONSTRAINT IF EXISTS genres_parent_level_chk,
  DROP CONSTRAINT IF EXISTS genres_level_chk,
  DROP CONSTRAINT IF EXISTS genres_slug_format_chk,
  DROP CONSTRAINT IF EXISTS genres_slug_uk,
  DROP COLUMN IF EXISTS change_reason,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS updated_by,
  DROP COLUMN IF EXISTS created_at,
  DROP COLUMN IF EXISTS created_by,
  DROP COLUMN IF EXISTS replaced_by_genre_id,
  DROP COLUMN IF EXISTS description,
  DROP COLUMN IF EXISTS parent_genre_id,
  DROP COLUMN IF EXISTS level,
  DROP COLUMN IF EXISTS slug;

COMMIT;
