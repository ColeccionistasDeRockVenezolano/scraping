-- ============================================================================
-- CRV · Migración 0016_person_duplicate_pair_uk (DOWN) — reversible
-- Elimina solo el índice único parcial; no toca datos ni el enum.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS ingest.review_queue_person_duplicate_live_uk;

COMMIT;
