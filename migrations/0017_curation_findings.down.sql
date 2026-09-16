-- ============================================================================
-- CRV · Migración 0017_curation_findings (DOWN) — reversible
-- Elimina los hallazgos y los análisis del detector de Curaduría. Las
-- decisiones «ignorar» se pierden con ellos: el detector las vuelve a
-- proponer en el siguiente análisis.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS ingest.curation_findings;
DROP TABLE IF EXISTS ingest.curation_scans;

COMMIT;
