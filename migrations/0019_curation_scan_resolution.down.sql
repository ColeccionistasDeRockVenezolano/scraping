-- ============================================================================
-- CRV · Migración 0019_curation_scan_resolution (DOWN) — reversible
-- Quita el motivo de resolución y vuelve a los tres estados de análisis de
-- 0017. Antes de restaurar el CHECK, los análisis `partial` (sí guardaron lo
-- que miraron) pasan a `ok` y los `skipped` (no analizaron) a `failed` con
-- una nota: sin eso el CHECK antiguo no se podría volver a crear.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS ingest.curation_findings_resolved_by_run_idx;
ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_resolved_by_run_fk;
ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_resolution_status_chk;
ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_resolution_chk;
ALTER TABLE ingest.curation_findings DROP COLUMN IF EXISTS resolved_by_run_id;
ALTER TABLE ingest.curation_findings DROP COLUMN IF EXISTS resolution;

UPDATE ingest.curation_scans SET status = 'ok' WHERE status = 'partial';
UPDATE ingest.curation_scans
   SET status = 'failed', error = coalesce(error, 'omitido: otro proceso estaba analizando (0019 down)')
 WHERE status = 'skipped';

ALTER TABLE ingest.curation_scans DROP CONSTRAINT IF EXISTS curation_scans_status_chk;
ALTER TABLE ingest.curation_scans ADD CONSTRAINT curation_scans_status_chk
  CHECK (status IN ('running', 'ok', 'failed'));

COMMIT;
