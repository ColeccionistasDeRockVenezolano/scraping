-- ============================================================================
-- CRV · Migración 0025_seed_upload_order_optional (DOWN)
-- Vuelve a exigir Upload Order. Una fila sin número (Short, Interview o fila que
-- ya no está en la hoja) no cabe en ese esquema: el down se niega mientras
-- exista alguna, en vez de inventarle un número.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ingest.seed_uploads WHERE upload_order IS NULL) THEN
    RAISE EXCEPTION 'hay filas de la hoja sin Upload Order; no se puede volver a exigirlo';
  END IF;
END $$;

ALTER TABLE ingest.seed_uploads DROP CONSTRAINT seed_uploads_order_uk;
ALTER TABLE ingest.seed_uploads ADD CONSTRAINT seed_uploads_order_uk UNIQUE (upload_order);
ALTER TABLE ingest.seed_uploads ALTER COLUMN upload_order SET NOT NULL;

COMMIT;
