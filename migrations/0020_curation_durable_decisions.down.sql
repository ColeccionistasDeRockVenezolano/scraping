-- ============================================================================
-- CRV · Migración 0020_curation_durable_decisions (DOWN) — reversible
-- Quita los pares declarados distintos y el motivo de «no es un problema».
-- Antes de restaurar el CHECK de 0019, lo resuelto por `declared_distinct`
-- pasa a `changed_elsewhere` (el motivo más cercano que 0019 conoce).
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS ingest.curation_distinct_pairs;

UPDATE ingest.curation_findings SET resolution = 'changed_elsewhere' WHERE resolution = 'declared_distinct';
ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_resolution_chk;
ALTER TABLE ingest.curation_findings ADD CONSTRAINT curation_findings_resolution_chk
  CHECK (resolution IS NULL OR resolution IN ('fixed_by_curation', 'changed_elsewhere', 'entity_removed', 'rules_changed'));

ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_ignore_reason_chk;
ALTER TABLE ingest.curation_findings DROP COLUMN IF EXISTS ignore_reason;

COMMIT;
