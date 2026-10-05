-- ============================================================================
-- CRV · Migración 0039_streaming_links (DOWN)
-- Quita la tabla de links de streaming. Se pierde lo poblado (los links no
-- viven en ninguna otra columna).
-- ============================================================================

BEGIN;

DELETE FROM ingest.change_journal_tables WHERE table_name = 'public.streaming_links';
DROP TABLE IF EXISTS public.streaming_links;

COMMIT;
