-- ============================================================================
-- CRV · Migración 0003_ingest_claims_identity (DOWN) — reversible
-- Primero retira las columnas claim_id que 0003 añadió a media (para
-- devolver las tablas de media al estado 0002), luego elimina los objetos
-- de ingest creados en 0003. NO toca el schema public (core).
-- ============================================================================

BEGIN;

ALTER TABLE media.video_tracks  DROP COLUMN IF EXISTS claim_id;
ALTER TABLE media.video_albums  DROP COLUMN IF EXISTS claim_id;
ALTER TABLE media.video_artists DROP COLUMN IF EXISTS claim_id;

DROP TABLE IF EXISTS ingest.merge_audit_claims CASCADE;
DROP TABLE IF EXISTS ingest.merge_audit        CASCADE;
DROP TABLE IF EXISTS ingest.review_queue       CASCADE;
DROP TABLE IF EXISTS ingest.conflicts          CASCADE;
DROP TABLE IF EXISTS ingest.track_aliases      CASCADE;
DROP TABLE IF EXISTS ingest.album_aliases      CASCADE;
DROP TABLE IF EXISTS ingest.organization_aliases CASCADE;
DROP TABLE IF EXISTS ingest.person_aliases     CASCADE;
DROP TABLE IF EXISTS ingest.artist_aliases     CASCADE;
DROP TABLE IF EXISTS ingest.claim_evidence     CASCADE;
DROP TABLE IF EXISTS ingest.claims             CASCADE;

DROP TYPE IF EXISTS ingest.conflict_status     CASCADE;
DROP TYPE IF EXISTS ingest.alias_type          CASCADE;
DROP TYPE IF EXISTS ingest.review_status       CASCADE;
DROP TYPE IF EXISTS ingest.review_kind         CASCADE;
DROP TYPE IF EXISTS ingest.actor_kind          CASCADE;
DROP TYPE IF EXISTS ingest.claim_entity_kind   CASCADE;
DROP TYPE IF EXISTS ingest.claim_status        CASCADE;

COMMIT;
