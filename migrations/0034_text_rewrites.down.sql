-- ============================================================================
-- CRV · Migración 0034_text_rewrites (DOWN)
-- Quita la cola de reescrituras. Las marcas pendientes se pierden; los textos
-- ya unidos en el core se quedan como están.
-- ============================================================================

BEGIN;

DELETE FROM ingest.change_journal_tables WHERE table_name = 'ingest.text_rewrites';
DROP TABLE IF EXISTS ingest.text_rewrites;

COMMIT;
