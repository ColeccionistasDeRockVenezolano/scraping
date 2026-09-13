-- ============================================================================
-- CRV · Migración 0011_album_classifications (UP)
-- Todas las clasificaciones que la hoja maestra da a un disco.
--
-- POR QUÉ UNA TABLA: el core guarda un solo `albums.album_type`, pero la hoja
--   —fuente de los tipos por decisión del propietario (2026-09-13)— escribe
--   "Solo Artist, Studio Album" o "Live Concert, Single": un disco puede tener
--   varias. El core no se toca; esta proyección vive en `ingest` y se regenera
--   desde `ingest.seed_uploads` con `crv youtube classifications`.
--
-- INFERIDO: una fila con el tipo vacío recibe uno deducido del artista y del
--   título, marcado `inferred`. Cuando la hoja lo escriba, se reemplaza.
--
-- REGLAS DE GOBIERNO: el schema `public` NO se toca. Idempotente y reversible.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.album_classifications (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  album_id BIGINT NOT NULL REFERENCES public.albums(id) ON DELETE CASCADE,
  -- Tal como la escribe la hoja ("Solo Artist", "Studio Album").
  classification VARCHAR(60) NOT NULL CHECK (btrim(classification) <> ''),
  -- Orden en la celda: la primera clasificación es la que la hoja pone delante.
  position SMALLINT NOT NULL CHECK (position >= 1),
  inferred BOOLEAN NOT NULL DEFAULT false,
  seed_upload_id BIGINT REFERENCES ingest.seed_uploads(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT album_classifications_uk UNIQUE (album_id, classification)
);

CREATE INDEX IF NOT EXISTS album_classifications_album_idx ON ingest.album_classifications(album_id);

COMMIT;
