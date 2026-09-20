-- ============================================================================
-- CRV · Migración 0024_curation_autofix (DOWN) — reversible
-- Quita la lista blanca y su auditoría. Los lotes automáticos ya aplicados
-- siguen en `curation_fix_batches` con su deshacer: nada de lo escrito en el
-- catálogo depende de estas tablas.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS ingest.curation_autofix_events;
DROP TABLE IF EXISTS ingest.curation_autofix_rules;

COMMIT;
