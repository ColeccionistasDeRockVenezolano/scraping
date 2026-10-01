-- ============================================================================
-- CRV · Migración 0035_artist_relations (DOWN)
-- Quita las relaciones explícitas entre artistas. Los relacionados calculados
-- por integrantes compartidos siguen funcionando.
-- ============================================================================

BEGIN;

DELETE FROM ingest.change_journal_tables WHERE table_name = 'ingest.artist_relations';
DROP TABLE IF EXISTS ingest.artist_relations;

COMMIT;
