-- ============================================================================
-- CRV · Migración 0010_review_decisions (DOWN)
-- Retira la tabla de decisiones provisionales. Aborta si hay decisiones ya
-- aplicadas al catálogo: borrarlas dejaría cambios del core sin su rastro.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_schema='ingest' AND table_name='review_decisions')
     AND EXISTS (SELECT 1 FROM ingest.review_decisions WHERE applied_at IS NOT NULL) THEN
    RAISE EXCEPTION 'ingest.review_decisions tiene decisiones aplicadas: revertir dejaría el core sin su rastro';
  END IF;
END $$;

DROP TABLE IF EXISTS ingest.review_decisions;

COMMIT;
