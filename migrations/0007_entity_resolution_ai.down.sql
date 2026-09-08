-- CRV · 0007_entity_resolution_ai (DOWN). Solo elimina objetos auxiliares.
BEGIN;

DROP TABLE IF EXISTS ingest.ai_biography_claims;
DROP TABLE IF EXISTS ingest.ai_biographies;
DROP TABLE IF EXISTS ingest.entity_resolution_decisions;
DROP TABLE IF EXISTS ingest.ai_runs;

ALTER TABLE ingest.claims
  DROP COLUMN IF EXISTS identity_secondary_key,
  DROP COLUMN IF EXISTS identity_key,
  DROP COLUMN IF EXISTS identity_raw;

COMMIT;
