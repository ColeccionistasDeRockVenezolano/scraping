-- ============================================================================
-- CRV · Migración 0018_curation_finding_fixes (DOWN) — reversible
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

ALTER TABLE ingest.curation_findings DROP COLUMN IF EXISTS suggested_value;

COMMIT;
