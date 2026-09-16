-- ============================================================================
-- CRV · Migración 0019_curation_scan_resolution (UP)
-- Motor de análisis de Curaduría robusto (PLAN_CURADURIA E1).
--
-- POR QUÉ:
--   * `partial`: un detector que falla ya no resuelve sus hallazgos (antes los
--     cerraba todos y el siguiente análisis los «reabría» como nuevos). El
--     análisis guarda lo que sí miró y queda marcado como parcial.
--   * `skipped`: dos procesos (API y CLI) no pueden guardar a la vez; el que
--     no consigue el candado deja constancia y se reintenta después.
--   * `resolution` + `resolved_by_run_id`: un hallazgo resuelto dice por qué
--     —corregido desde Curaduría, cambiado en otra parte, ficha retirada o
--     cambio de reglas— y, cuando se sabe, qué run de escritura lo resolvió
--     (`ingest.scrape_runs`, el mismo run que queda en `merge_audit`).
--
-- Los hallazgos resueltos antes de esta migración quedan con `resolution`
-- NULL: no hay forma honesta de reconstruir el motivo.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente y
-- reversible.
-- ============================================================================

BEGIN;

ALTER TABLE ingest.curation_scans DROP CONSTRAINT IF EXISTS curation_scans_status_chk;
ALTER TABLE ingest.curation_scans ADD CONSTRAINT curation_scans_status_chk
  CHECK (status IN ('running', 'ok', 'partial', 'skipped', 'failed'));

ALTER TABLE ingest.curation_findings ADD COLUMN IF NOT EXISTS resolution VARCHAR(20);
ALTER TABLE ingest.curation_findings ADD COLUMN IF NOT EXISTS resolved_by_run_id BIGINT;

ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_resolution_chk;
ALTER TABLE ingest.curation_findings ADD CONSTRAINT curation_findings_resolution_chk
  CHECK (resolution IS NULL OR resolution IN ('fixed_by_curation', 'changed_elsewhere', 'entity_removed', 'rules_changed'));

-- El motivo solo tiene sentido mientras el hallazgo sigue resuelto.
ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_resolution_status_chk;
ALTER TABLE ingest.curation_findings ADD CONSTRAINT curation_findings_resolution_status_chk
  CHECK (status = 'resolved' OR (resolution IS NULL AND resolved_by_run_id IS NULL));

ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_resolved_by_run_fk;
ALTER TABLE ingest.curation_findings ADD CONSTRAINT curation_findings_resolved_by_run_fk
  FOREIGN KEY (resolved_by_run_id) REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS curation_findings_resolved_by_run_idx
  ON ingest.curation_findings (resolved_by_run_id) WHERE resolved_by_run_id IS NOT NULL;

COMMENT ON COLUMN ingest.curation_findings.resolution IS
  'Por qué se resolvió: fixed_by_curation, changed_elsewhere, entity_removed o rules_changed. NULL si sigue abierto/ignorado o si se resolvió antes de 0019.';
COMMENT ON COLUMN ingest.curation_findings.resolved_by_run_id IS
  'Run de escritura (ingest.scrape_runs) que cambió el valor detectado, cuando merge_audit lo registra.';

COMMIT;
