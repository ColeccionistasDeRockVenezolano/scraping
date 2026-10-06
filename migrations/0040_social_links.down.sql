-- ============================================================================
-- CRV · Migración 0040_social_links (DOWN)
-- Quita la tabla de redes sociales. Se pierde lo poblado (las redes no viven
-- en ninguna otra columna).
-- ============================================================================

BEGIN;

DELETE FROM ingest.change_journal_tables WHERE table_name = 'public.social_links';
DROP TABLE IF EXISTS public.social_links;

COMMIT;
