-- ============================================================================
-- CRV · Migración 0028_change_journal (DOWN)
-- Quita los disparadores del diario (también los de `public`), las funciones
-- y las tablas. El diario se pierde: los runs ya no se podrán deshacer con él.
-- ============================================================================

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT t.tgrelid::regclass AS rel
      FROM pg_trigger t
     WHERE t.tgname = 'crv_journal' AND NOT t.tgisinternal
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS crv_journal ON %s', r.rel);
  END LOOP;
END $$;

DROP TRIGGER IF EXISTS crv_bind_run ON ingest.scrape_runs;
DROP FUNCTION IF EXISTS ingest.crv_bind_run();
DROP FUNCTION IF EXISTS ingest.crv_journal_attach_all();
DROP FUNCTION IF EXISTS ingest.crv_journal_attach(REGCLASS, TEXT);
DROP FUNCTION IF EXISTS ingest.crv_journal();

DROP TABLE IF EXISTS ingest.run_undos;
DROP TABLE IF EXISTS ingest.change_journal_tables;
DROP TABLE IF EXISTS ingest.change_journal;

COMMIT;
