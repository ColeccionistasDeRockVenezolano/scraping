-- ============================================================================
-- CRV · Migración 0025_seed_upload_order_optional (UP)
-- La hoja maestra deja sin Upload Order a Shorts e Interview (decisión de
-- Brian, 2026-09-22), y su numeración se corre cuando se insertan filas
-- arriba: el número deja de identificar la fila. El importador casa ahora
-- por video (o por artista+disco si no hay URL) y reasigna los números en
-- la misma transacción; por eso la unicidad se comprueba al COMMIT.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

ALTER TABLE ingest.seed_uploads ALTER COLUMN upload_order DROP NOT NULL;
ALTER TABLE ingest.seed_uploads DROP CONSTRAINT seed_uploads_order_uk;
ALTER TABLE ingest.seed_uploads
  ADD CONSTRAINT seed_uploads_order_uk UNIQUE (upload_order) DEFERRABLE INITIALLY DEFERRED;

COMMIT;
