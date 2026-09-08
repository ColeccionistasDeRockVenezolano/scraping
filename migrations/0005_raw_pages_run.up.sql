-- CRV · F1: procedencia directa entre snapshots crudos y el run que los
-- descargó. Es aditiva y no toca el schema public.
BEGIN;

ALTER TABLE ingest.raw_pages
  ADD COLUMN IF NOT EXISTS run_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'ingest.raw_pages'::regclass
       AND conname = 'raw_pages_run_id_fkey'
  ) THEN
    ALTER TABLE ingest.raw_pages
      ADD CONSTRAINT raw_pages_run_id_fkey
      FOREIGN KEY (run_id) REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS raw_pages_run_idx ON ingest.raw_pages (run_id);

COMMIT;
