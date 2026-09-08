-- ============================================================================
-- CRV · Migración 0001_ingest_core (DOWN) — reversible
-- Elimina SOLO objetos del schema ingest creados en 0001.
-- NO toca el schema public (core). Si quedan tablas de 0002/0003 que
-- dependen de estos objetos, la base rechazará el DROP (integridad).
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS ingest.genres        CASCADE;
DROP TABLE IF EXISTS ingest.seed_uploads  CASCADE;
DROP TABLE IF EXISTS ingest.scrape_errors CASCADE;
DROP TABLE IF EXISTS ingest.scrape_runs   CASCADE;
DROP TABLE IF EXISTS ingest.raw_pages     CASCADE;
DROP TABLE IF EXISTS ingest.sources       CASCADE;

-- Bookkeeping del harness de migraciones (no es parte del core).
DROP TABLE IF EXISTS ingest.schema_migrations CASCADE;

DROP TYPE IF EXISTS ingest.run_status      CASCADE;
DROP TYPE IF EXISTS ingest.run_kind        CASCADE;
DROP TYPE IF EXISTS ingest.confidence_level CASCADE;
DROP TYPE IF EXISTS ingest.trust_level     CASCADE;

-- El schema solo se elimina si quedó vacío (no usar CASCADE aquí: si algo
-- sobrevive, preferimos el error explícito antes que borrar por sorpresa).
DROP SCHEMA IF EXISTS ingest;

COMMIT;
