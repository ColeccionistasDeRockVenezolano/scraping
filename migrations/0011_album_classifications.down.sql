-- ============================================================================
-- CRV · Migración 0011_album_classifications (DOWN)
-- Retira la proyección de clasificaciones. No pierde datos de origen: se
-- regenera desde ingest.seed_uploads con `crv youtube classifications`.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS ingest.album_classifications;

COMMIT;
