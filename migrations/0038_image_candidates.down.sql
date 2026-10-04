-- ============================================================================
-- CRV · Migración 0038_image_candidates (DOWN)
-- Quita las candidatas de imagen. Las portadas y fotos ya elegidas se quedan
-- en sus fichas.
-- ============================================================================

BEGIN;

DELETE FROM ingest.change_journal_tables WHERE table_name = 'ingest.image_candidates';
DROP TABLE IF EXISTS ingest.image_candidates;

COMMIT;
