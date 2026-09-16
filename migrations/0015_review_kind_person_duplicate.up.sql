-- ============================================================================
-- CRV · Migración 0015_review_kind_person_duplicate (UP)
-- Añade `person_duplicate` a ingest.review_kind: la propuesta del detector de
-- candidatos de duplicado de persona (PHASES E11.5; plan P10). No decide
-- nada: propone un par y espera la decisión de una persona.
--
-- POR QUÉ VA SOLA Y SIN ÍNDICES: desde PG 12, `ALTER TYPE ... ADD VALUE`
--   puede ejecutarse dentro de una transacción, pero el valor añadido NO
--   puede usarse hasta que esa transacción haya hecho COMMIT. El índice
--   parcial que usa el valor nuevo vive en 0016_person_duplicate_pair_uk
--   (copia del patrón de 0004_review_kinds).
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca; solo un enum de
--   `ingest`. Idempotente (IF NOT EXISTS). El down es irreversible y lo
--   documenta (ver 0015_review_kind_person_duplicate.down.sql).
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

ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS 'person_duplicate';

COMMENT ON TYPE ingest.review_kind IS
  'Tipos de trabajo humano en ingest.review_queue. 0003: possible_duplicate, '
  'field_conflict, ambiguous_alias, album_match, person_match, '
  'organization_match, youtube_match, manual_review. 0004: missing_url, '
  'seed_incomplete, media_type_no_album, genre_unknown, new_source, '
  'low_confidence, ai_biography, ai_entity_resolution. 0015: person_duplicate.';

COMMIT;
