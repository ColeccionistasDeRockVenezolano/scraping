-- ============================================================================
-- CRV · Migración 0004_review_kinds (DOWN) — reversible y no destructiva
-- Devuelve ingest.review_kind a los 8 valores originales de 0003.
--
-- PostgreSQL no permite eliminar valores de un enum, así que el enum se
-- recrea: se renombra el actual, se crea el original, se reescriben las
-- columnas que lo usan y se elimina el viejo.
--
-- SEGURIDAD (el down NUNCA borra datos en silencio):
--   * Si alguna fila usa uno de los 8 valores añadidos por 0004, la
--     migración ABORTA con el detalle de qué kinds y cuántas filas. Primero
--     hay que reclasificar o resolver esas revisiones.
--   * Si el enum no existe (0003 ya revertida) o los valores nuevos no están
--     presentes, no hace nada.
--   * NO toca el schema public (core).
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_added  TEXT[] := ARRAY['missing_url','seed_incomplete','media_type_no_album',
                           'genre_unknown','new_source','low_confidence',
                           'ai_biography','ai_entity_resolution'];
  v_col    RECORD;
  v_used   TEXT;
  v_report TEXT := '';
BEGIN
  -- 1. ¿Existe el enum? Si 0003 ya se revirtió, no hay nada que hacer.
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'ingest' AND t.typname = 'review_kind'
  ) THEN
    RAISE NOTICE '0004 down: ingest.review_kind no existe; nada que revertir';
    RETURN;
  END IF;

  -- 2. ¿Están presentes los valores de 0004? Si no, ya está revertida.
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'ingest' AND t.typname = 'review_kind'
       AND e.enumlabel = ANY(v_added)
  ) THEN
    RAISE NOTICE '0004 down: los valores de 0004 no están presentes; nada que hacer';
    RETURN;
  END IF;

  -- 3. Ninguna fila puede estar usando los valores que vamos a retirar.
  FOR v_col IN
    SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col
      FROM pg_attribute a
      JOIN pg_class c     ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t      ON t.oid = a.atttypid
      JOIN pg_namespace tn ON tn.oid = t.typnamespace
     WHERE tn.nspname = 'ingest' AND t.typname = 'review_kind'
       AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'SELECT string_agg(k || ''='' || n, '', '' ORDER BY k) FROM ('
      '  SELECT %I::text AS k, count(*) AS n FROM %I.%I'
      '   WHERE %I::text = ANY($1) GROUP BY 1) s',
      v_col.col, v_col.sch, v_col.tbl, v_col.col
    ) INTO v_used USING v_added;

    IF v_used IS NOT NULL THEN
      v_report := v_report || format(E'\n  %s.%s.%s -> %s',
                                     v_col.sch, v_col.tbl, v_col.col, v_used);
    END IF;
  END LOOP;

  IF v_report <> '' THEN
    -- Nota: en RAISE el marcador de sustitución es '%' a secas (no '%s').
    RAISE EXCEPTION
      'No se puede revertir 0004: hay filas usando kinds de 0004:%', v_report
      USING HINT = 'Reclasifique o resuelva esas revisiones antes del rollback.';
  END IF;

  -- 4. Recrear el enum con los 8 valores originales de 0003.
  EXECUTE 'ALTER TYPE ingest.review_kind RENAME TO review_kind_pre0004';

  EXECUTE 'CREATE TYPE ingest.review_kind AS ENUM ('
          '''possible_duplicate'', ''field_conflict'', ''ambiguous_alias'', '
          '''album_match'', ''person_match'', ''organization_match'', '
          '''youtube_match'', ''manual_review'')';

  -- 5. Reescribir cada columna que use el tipo viejo (índices se reconstruyen
  --    solos; NOT NULL se conserva; la columna no tiene DEFAULT).
  FOR v_col IN
    SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col
      FROM pg_attribute a
      JOIN pg_class c     ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t      ON t.oid = a.atttypid
      JOIN pg_namespace tn ON tn.oid = t.typnamespace
     WHERE tn.nspname = 'ingest' AND t.typname = 'review_kind_pre0004'
       AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE ingest.review_kind '
      'USING %I::text::ingest.review_kind',
      v_col.sch, v_col.tbl, v_col.col, v_col.col
    );
  END LOOP;

  EXECUTE 'DROP TYPE ingest.review_kind_pre0004';

  RAISE NOTICE '0004 down: ingest.review_kind restaurado a los 8 valores de 0003';
END $$;

COMMENT ON TYPE ingest.review_kind IS
  'Tipos de trabajo humano en ingest.review_queue (0003): possible_duplicate, '
  'field_conflict, ambiguous_alias, album_match, person_match, '
  'organization_match, youtube_match, manual_review.';

COMMIT;
