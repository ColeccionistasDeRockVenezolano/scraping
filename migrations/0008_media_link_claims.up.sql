-- ============================================================================
-- CRV · Migración 0008_media_link_claims (UP)
-- Abre el camino de claims hacia media.media_links.
--
-- POR QUÉ HACE FALTA:
--   `media.media_links` existe desde 0002 con sus restricciones completas
--   (un solo destino, entity_kind concordante, media_type acotado, UNIQUE por
--   destino+url), pero ningún claim podía llegar a ella: `ingest.
--   claim_entity_kind` no tenía un valor para nombrarla. Por eso las artes
--   que NO son portada se quedaban sin destino y no se extraían:
--
--     · 700 artes internas de CRV WordPress (contraportadas, galletas de CD,
--       libretos, contratapas) sobre 176 discos — la única fuente que las
--       tiene.
--     · 513 fotos de artista de Sincopa, declaradas en la RUTA del archivo
--       (`photos*/`, `pictures/`, `artist_photo*/`).
--
--   `albums.cover_url` y `artists.picture_url` son una sola columna cada una:
--   guardan LA portada y LA foto, no una galería. Meter ahí siete artes de un
--   disco obligaría a elegir una y tirar seis.
--
-- REGLAS DE GOBIERNO (CRV_IMPLEMENTATION_CONTRACT.md):
--   * El schema `public` (core canónico) NO se toca: ni una columna, ni un
--     enum, ni un índice. La huella de src/doctor/core-catalog.json queda
--     idéntica y el hash de crv_simple_v1.sql no cambia.
--   * Solo se modifican el enum y dos tablas del schema auxiliar `ingest`.
--   * Idempotente: ADD VALUE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
--   * Reversible: ver 0008_media_link_claims.down.sql
--
-- NOTA POSTGRESQL (por la que este archivo NO usa el valor que añade):
--   Desde PG 12, ALTER TYPE ... ADD VALUE puede ejecutarse dentro de una
--   transacción, pero el valor NO puede USARSE hasta que esa transacción
--   haga COMMIT. Aquí solo se añade el valor y se crean columnas que no lo
--   mencionan; el runner registra la versión en una sentencia aparte.
-- ============================================================================

BEGIN;

-- Guardas de precondición: el enum lo crea 0003 y la tabla destino, 0002.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'ingest' AND t.typname = 'claim_entity_kind'
  ) THEN
    RAISE EXCEPTION
      'ingest.claim_entity_kind no existe: aplique antes 0003_ingest_claims_identity';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'media' AND c.relname = 'media_links'
  ) THEN
    RAISE EXCEPTION 'media.media_links no existe: aplique antes 0002_media';
  END IF;
END $$;

ALTER TYPE ingest.claim_entity_kind ADD VALUE IF NOT EXISTS 'media_link';

-- Trazabilidad en las dos direcciones que ya usan las demás relaciones:
-- el claim apunta a la fila que produjo, y la auditoría del merge también.
ALTER TABLE ingest.claims
  ADD COLUMN IF NOT EXISTS media_link_id bigint
  REFERENCES media.media_links(id) ON DELETE SET NULL;

ALTER TABLE ingest.merge_audit
  ADD COLUMN IF NOT EXISTS media_link_id bigint
  REFERENCES media.media_links(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS claims_media_link_idx
  ON ingest.claims (media_link_id) WHERE media_link_id IS NOT NULL;

-- NOTA sobre claims_dedupe_uk: su COALESCE de destinos NO incluye la columna
-- nueva, y es deliberado. Añadirla cambiaría la clave de deduplicación de
-- TODOS los claims ya almacenados, no solo de los de media_link; y estos
-- deduplican bien sin ella, porque raw_hash ya cubre identidad, valor y
-- evidencia.

COMMENT ON COLUMN ingest.claims.media_link_id IS
  'Fila de media.media_links que este claim materializó (arte no-portada, '
  'foto de artista). NULL mientras el claim sea candidato.';

COMMENT ON TYPE ingest.claim_entity_kind IS
  'Qué afirma un claim. 0003: artist, person, organization, album, track, '
  'artist_membership, person_organization, album_credit, track_credit, '
  'album_format, youtube_video. 0008: media_link (arte o foto adicional que '
  'no cabe en las columnas de una sola imagen del core).';

COMMIT;
