-- ============================================================================
-- CRV · Migración 0012_ambiguity_resolutions (DOWN)
-- Retira las decisiones del resolutor de ambigüedades. Lo ya aplicado al core
-- conserva su rastro en ingest.merge_audit y en las notas de review_queue; las
-- decisiones pendientes se regeneran con `crv ambiguity:resolve`.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS ingest.ambiguity_resolutions;

COMMIT;
