-- ============================================================================
-- CRV · Migración 0026_claims_identity_idx (DOWN)
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS ingest.claims_identity_idx;

COMMIT;
