-- ============================================================================
-- CRV · Migración 0023_curation_incremental (UP)
-- Análisis incremental de Curaduría (PLAN_CURADURIA E9: A9).
--
-- POR QUÉ: cada análisis reescribía las ~5.400 filas de `curation_findings`,
--   aunque el 99 % no hubiera cambiado: una versión nueva de cada tupla, sus
--   índices, su WAL y el autovacuum detrás. `content_hash` es la huella de lo
--   que el detector emitió para ese hallazgo (categoría, subgrupo, gravedad,
--   etiqueta, campo, valor, título, sugerencia, relacionadas y evidencia). El
--   análisis compara en memoria y solo escribe altas, reaperturas y cambios;
--   de lo demás refresca «visto por última vez» y nada más.
--
--   NULL = fila guardada antes de esta migración: el primer análisis la trata
--   como cambiada y la deja con su huella. No se rellena aquí porque el hash
--   lo calcula el detector (TypeScript), no SQL.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente y
-- reversible.
-- ============================================================================

BEGIN;

ALTER TABLE ingest.curation_findings ADD COLUMN IF NOT EXISTS content_hash TEXT;

ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_content_hash_chk;
ALTER TABLE ingest.curation_findings ADD CONSTRAINT curation_findings_content_hash_chk
  CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{32}$');

COMMENT ON COLUMN ingest.curation_findings.content_hash IS
  'Huella de lo que el detector emitió (sin la historia del hallazgo). El análisis incremental (E9) solo reescribe la fila si cambia; si no, refresca last_seen_*. NULL = fila anterior a 0023.';

-- El análisis dirigido y la autocorrección buscan por detector y subgrupo
-- dentro de lo abierto; el índice de (status, category, detector) no alcanza
-- cuando no se conoce la categoría.
CREATE INDEX IF NOT EXISTS curation_findings_open_detector_idx
  ON ingest.curation_findings (detector, signature) WHERE status = 'open';

COMMIT;
