-- ============================================================================
-- CRV · Migración 0008_media_link_claims (DOWN) — reversible y no destructiva
-- Devuelve ingest.claim_entity_kind a los 11 valores de 0003 y retira las dos
-- columnas de trazabilidad.
--
-- PostgreSQL no permite eliminar valores de un enum, así que el enum se
-- recrea: se renombra el actual, se crea el original, se reescriben las
-- columnas que lo usan y se elimina el viejo.
--
-- SEGURIDAD (el down NUNCA borra datos en silencio):
--   * Si algún claim, conflicto o auditoría usa 'media_link', ABORTA con el
--     detalle. Primero hay que reclasificar o retirar esas filas.
--   * Si alguna fila de media.media_links quedó enganchada a un claim,
--     ABORTA: retirar la columna dejaría esas artes sin procedencia.
--   * NO toca el schema public (core) ni borra media.media_links.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  v_used   bigint;
  v_linked bigint;
  v_col    record;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'ingest' AND t.typname = 'claim_entity_kind'
  ) THEN
    RAISE NOTICE 'ingest.claim_entity_kind no existe; nada que revertir';
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = 'ingest' AND t.typname = 'claim_entity_kind'
       AND e.enumlabel = 'media_link'
  ) THEN
    RAISE NOTICE '0008 no aplicada (falta el valor media_link); nada que revertir';
    RETURN;
  END IF;

  SELECT count(*) INTO v_used FROM ingest.claims WHERE entity_kind = 'media_link';
  IF v_used > 0 THEN
    RAISE EXCEPTION
      '% claims usan entity_kind=media_link: reclasifíquelos antes de revertir 0008', v_used;
  END IF;
  SELECT count(*) INTO v_used FROM ingest.merge_audit WHERE entity_kind = 'media_link';
  IF v_used > 0 THEN
    RAISE EXCEPTION
      '% filas de merge_audit usan entity_kind=media_link: revertir 0008 borraría su rastro', v_used;
  END IF;
  SELECT count(*) INTO v_used FROM ingest.conflicts WHERE entity_kind = 'media_link';
  IF v_used > 0 THEN
    RAISE EXCEPTION '% conflictos usan entity_kind=media_link', v_used;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='ingest' AND table_name='claims' AND column_name='media_link_id') THEN
    EXECUTE 'SELECT count(*) FROM ingest.claims WHERE media_link_id IS NOT NULL' INTO v_linked;
    IF v_linked > 0 THEN
      RAISE EXCEPTION
        '% claims apuntan a media.media_links: esas artes perderían su procedencia', v_linked;
    END IF;
  END IF;

  -- Las restricciones CHECK guardan el OID del tipo, no su nombre: al
  -- renombrar el enum se quedarian comparando contra
  -- `claim_entity_kind_0008` y cualquier escritura fallaria con "operator
  -- does not exist". Se guardan sus definiciones, se retiran, y se recrean al
  -- final con el nombre ya restituido.
  CREATE TEMP TABLE _crv_checks_0008 ON COMMIT DROP AS
    SELECT n.nspname AS sch, c.relname AS tbl, con.conname AS name,
           pg_get_constraintdef(con.oid) AS def
      FROM pg_constraint con
      JOIN pg_class c     ON c.oid = con.conrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE con.contype = 'c'
       AND EXISTS (
         SELECT 1 FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
            AND t.typname = 'claim_entity_kind'
            AND t.typnamespace = 'ingest'::regnamespace);

  FOR v_col IN SELECT sch, tbl, name FROM _crv_checks_0008 LOOP
    EXECUTE format('ALTER TABLE %I.%I DROP CONSTRAINT %I', v_col.sch, v_col.tbl, v_col.name);
  END LOOP;

  -- Columnas de trazabilidad (vacias, comprobado arriba).
  ALTER TABLE ingest.claims      DROP COLUMN IF EXISTS media_link_id;
  ALTER TABLE ingest.merge_audit DROP COLUMN IF EXISTS media_link_id;

  -- Recreacion del enum sin 'media_link'.
  EXECUTE 'ALTER TYPE ingest.claim_entity_kind RENAME TO claim_entity_kind_0008';
  EXECUTE $ddl$CREATE TYPE ingest.claim_entity_kind AS ENUM (
    'artist', 'person', 'organization', 'album', 'track',
    'artist_membership', 'person_organization', 'album_credit',
    'track_credit', 'album_format', 'youtube_video')$ddl$;

  FOR v_col IN
    SELECT n.nspname AS sch, c.relname AS tbl, a.attname AS col
      FROM pg_attribute a
      JOIN pg_class c     ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t      ON t.oid = a.atttypid
     WHERE t.typname = 'claim_entity_kind_0008'
       AND a.attnum > 0 AND NOT a.attisdropped AND c.relkind = 'r'
  LOOP
    EXECUTE format(
      'ALTER TABLE %I.%I ALTER COLUMN %I TYPE ingest.claim_entity_kind USING %I::text::ingest.claim_entity_kind',
      v_col.sch, v_col.tbl, v_col.col, v_col.col);
  END LOOP;

  EXECUTE 'DROP TYPE ingest.claim_entity_kind_0008';

  FOR v_col IN SELECT sch, tbl, name, def FROM _crv_checks_0008 LOOP
    EXECUTE format('ALTER TABLE %I.%I ADD CONSTRAINT %I %s', v_col.sch, v_col.tbl, v_col.name,
                   replace(v_col.def, 'claim_entity_kind_0008', 'claim_entity_kind'));
  END LOOP;
END $$;

COMMIT;
