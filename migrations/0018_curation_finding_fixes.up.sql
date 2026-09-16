-- ============================================================================
-- CRV · Migración 0018_curation_finding_fixes (UP)
-- Herramientas de corrección de Curaduría (categorías y subcategorías ya
-- conocidas, plan de mejora 2026-09-16): añade el valor sugerido que algunos
-- detectores ya calculan (p. ej. «nombres sucios») como columna propia, en vez
-- de tener que extraerlo del texto de `suggestion`. Con esto la web puede
-- ofrecer «Corregir» con un valor listo para confirmar, individualmente, por
-- selección o en lote por categoría/detector/subgrupo.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente y
-- reversible. `suggested_value` es NULL salvo que el detector calcule un
-- reemplazo determinista de `value` (mismo campo, mismo tipo de dato).
-- ============================================================================

BEGIN;

ALTER TABLE ingest.curation_findings ADD COLUMN IF NOT EXISTS suggested_value TEXT;

COMMENT ON COLUMN ingest.curation_findings.suggested_value IS
  'Reemplazo determinista de "value" que el detector propone (p. ej. el nombre sin caracteres invisibles). NULL cuando la corrección exige criterio humano.';

COMMIT;
