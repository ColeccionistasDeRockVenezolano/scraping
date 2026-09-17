-- ============================================================================
-- CRV · Migración 0021_curation_fix_batches (DOWN) — reversible
-- Quita los lotes de correcciones y el alcance de los análisis. Los runs de
-- escritura, `merge_audit` y los claims de cada corrección quedan: son la
-- auditoría del catálogo, no de Curaduría. Sin los lotes ya no se puede
-- deshacer por lote (sí run por run con las herramientas del motor).
-- Antes de quitar `scope`, las verificaciones dirigidas pasan a `failed` con
-- una nota: 0017–0020 no las distinguen y contarían como análisis completos.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS ingest.curation_fix_items;
DROP TABLE IF EXISTS ingest.curation_fix_batches;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'ingest' AND table_name = 'curation_scans' AND column_name = 'scope') THEN
    UPDATE ingest.curation_scans
       SET status = 'failed', error = coalesce(error, 'verificación dirigida de un lote (0021 down)')
     WHERE scope = 'dirigido';
  END IF;
END $$;

ALTER TABLE ingest.curation_scans DROP CONSTRAINT IF EXISTS curation_scans_scope_chk;
ALTER TABLE ingest.curation_scans DROP COLUMN IF EXISTS scope;

COMMIT;
