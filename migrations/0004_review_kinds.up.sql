-- ============================================================================
-- CRV · Migración 0004_review_kinds (UP)
-- Extiende ingest.review_kind con los ocho tipos de revisión que exigen
-- PHASES F2 y docs/acceptance/caramelos-las-paticas.md, y que 0003 no
-- incluyó (deuda registrada en CRV_IMPLEMENTATION_CONTRACT.md §11.1).
--
-- Valores añadidos:
--   missing_url            86 filas del seed YT sin URL (todas 'Unlisted')
--   seed_incomplete        filas EMPTY del seed (órdenes 97 y 440)
--   media_type_no_album    Music Video / Live Concert / Documentary que NO
--                          crean álbum (decisión de gobierno 19)
--   genre_unknown          género fuera de ingest.genres (nunca bloquea)
--   new_source             alta de fuente pendiente de aprobación manual
--   low_confidence         claim 'low' que jamás toca datos canónicos
--   ai_biography           borrador de biografía IA pendiente de aprobación
--   ai_entity_resolution   desambiguación propuesta por IA (nunca decide)
--
-- REGLAS DE GOBIERNO (CRV_IMPLEMENTATION_CONTRACT.md):
--   * El schema `public` (core canónico, crv_simple_v1.sql) NO se toca.
--   * Solo se modifica un enum del schema auxiliar `ingest`.
--   * Idempotente: ADD VALUE IF NOT EXISTS (re-ejecutable sin efecto).
--   * Reversible: ver 0004_review_kinds.down.sql
--
-- NOTA POSTGRESQL (por la que este archivo va SOLO y sin INSERTs):
--   Desde PG 12, ALTER TYPE ... ADD VALUE puede ejecutarse dentro de un
--   bloque de transacción, pero el valor añadido NO puede USARSE hasta que
--   esa transacción haya hecho COMMIT. Por eso esta migración no contiene
--   ninguna sentencia que utilice los valores nuevos. El harness
--   (tests/migrate.sh) registra la versión en una sentencia aparte, así que
--   el COMMIT ocurre antes de cualquier uso posterior.
-- ============================================================================

BEGIN;

-- Guarda de precondición: el enum debe existir (lo crea 0003).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'ingest' AND t.typname = 'review_kind'
  ) THEN
    RAISE EXCEPTION
      'ingest.review_kind no existe: aplique antes 0003_ingest_claims_identity';
  END IF;
END $$;

ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS 'missing_url';
ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS 'seed_incomplete';
ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS 'media_type_no_album';
ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS 'genre_unknown';
ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS 'new_source';
ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS 'low_confidence';
ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS 'ai_biography';
ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS 'ai_entity_resolution';

COMMENT ON TYPE ingest.review_kind IS
  'Tipos de trabajo humano en ingest.review_queue. 0003: possible_duplicate, '
  'field_conflict, ambiguous_alias, album_match, person_match, '
  'organization_match, youtube_match, manual_review. 0004: missing_url, '
  'seed_incomplete, media_type_no_album, genre_unknown, new_source, '
  'low_confidence, ai_biography, ai_entity_resolution.';

COMMIT;
