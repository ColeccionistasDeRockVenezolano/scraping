-- CRV · F1 rollback: elimina únicamente la procedencia añadida en 0005.
BEGIN;

DROP INDEX IF EXISTS ingest.raw_pages_run_idx;
ALTER TABLE IF EXISTS ingest.raw_pages
  DROP CONSTRAINT IF EXISTS raw_pages_run_id_fkey,
  DROP COLUMN IF EXISTS run_id;

COMMIT;
