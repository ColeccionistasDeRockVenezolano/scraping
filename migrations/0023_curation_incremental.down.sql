-- ============================================================================
-- CRV · Migración 0023_curation_incremental (DOWN) — reversible
-- Quita la huella de contenido: sin ella el análisis vuelve a reescribir todas
-- las filas en cada vuelta (no se pierde ningún hallazgo).
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS ingest.curation_findings_open_detector_idx;
ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_content_hash_chk;
ALTER TABLE ingest.curation_findings DROP COLUMN IF EXISTS content_hash;

COMMIT;
