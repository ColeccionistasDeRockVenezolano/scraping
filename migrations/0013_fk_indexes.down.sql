-- ============================================================================
-- CRV · Migración 0013_fk_indexes (DOWN)
-- Retira los índices de claves foráneas de 0013. No borra datos: las FKs
-- siguen en su sitio, solo vuelven a comprobarse con recorridos secuenciales.
-- ============================================================================

BEGIN;

DROP INDEX IF EXISTS ingest.ai_biographies_artist_id_fk_idx;
DROP INDEX IF EXISTS ingest.ai_biographies_person_id_fk_idx;
DROP INDEX IF EXISTS ingest.ai_biographies_review_queue_id_fk_idx;
DROP INDEX IF EXISTS ingest.album_aliases_claim_id_fk_idx;
DROP INDEX IF EXISTS ingest.album_aliases_raw_page_id_fk_idx;
DROP INDEX IF EXISTS ingest.album_aliases_source_id_fk_idx;
DROP INDEX IF EXISTS ingest.artist_aliases_claim_id_fk_idx;
DROP INDEX IF EXISTS ingest.artist_aliases_raw_page_id_fk_idx;
DROP INDEX IF EXISTS ingest.artist_aliases_source_id_fk_idx;
DROP INDEX IF EXISTS ingest.organization_aliases_claim_id_fk_idx;
DROP INDEX IF EXISTS ingest.organization_aliases_raw_page_id_fk_idx;
DROP INDEX IF EXISTS ingest.organization_aliases_source_id_fk_idx;
DROP INDEX IF EXISTS ingest.person_aliases_claim_id_fk_idx;
DROP INDEX IF EXISTS ingest.person_aliases_raw_page_id_fk_idx;
DROP INDEX IF EXISTS ingest.person_aliases_source_id_fk_idx;
DROP INDEX IF EXISTS ingest.track_aliases_claim_id_fk_idx;
DROP INDEX IF EXISTS ingest.track_aliases_raw_page_id_fk_idx;
DROP INDEX IF EXISTS ingest.track_aliases_source_id_fk_idx;
DROP INDEX IF EXISTS ingest.album_classifications_seed_upload_id_fk_idx;
DROP INDEX IF EXISTS ingest.ambiguity_resolutions_ai_run_id_fk_idx;
DROP INDEX IF EXISTS ingest.ambiguity_resolutions_applied_run_id_fk_idx;
DROP INDEX IF EXISTS ingest.ambiguity_resolutions_run_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_decisions_applied_run_id_fk_idx;
DROP INDEX IF EXISTS ingest.claim_evidence_raw_page_id_fk_idx;
DROP INDEX IF EXISTS ingest.claim_evidence_seed_upload_id_fk_idx;
DROP INDEX IF EXISTS ingest.claims_album_credit_id_fk_idx;
DROP INDEX IF EXISTS ingest.claims_album_format_id_fk_idx;
DROP INDEX IF EXISTS ingest.claims_artist_membership_id_fk_idx;
DROP INDEX IF EXISTS ingest.claims_person_organization_id_fk_idx;
DROP INDEX IF EXISTS ingest.claims_raw_page_id_fk_idx;
DROP INDEX IF EXISTS ingest.claims_run_id_fk_idx;
DROP INDEX IF EXISTS ingest.claims_seed_upload_id_fk_idx;
DROP INDEX IF EXISTS ingest.claims_track_credit_id_fk_idx;
DROP INDEX IF EXISTS ingest.conflicts_claim_b_id_fk_idx;
DROP INDEX IF EXISTS ingest.entity_resolution_decisions_ai_run_id_fk_idx;
DROP INDEX IF EXISTS ingest.entity_resolution_decisions_album_id_fk_idx;
DROP INDEX IF EXISTS ingest.entity_resolution_decisions_artist_id_fk_idx;
DROP INDEX IF EXISTS ingest.entity_resolution_decisions_claim_id_fk_idx;
DROP INDEX IF EXISTS ingest.entity_resolution_decisions_organization_id_fk_idx;
DROP INDEX IF EXISTS ingest.entity_resolution_decisions_person_id_fk_idx;
DROP INDEX IF EXISTS ingest.entity_resolution_decisions_run_id_fk_idx;
DROP INDEX IF EXISTS ingest.entity_resolution_decisions_track_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_album_credit_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_album_format_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_artist_membership_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_media_link_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_organization_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_person_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_person_organization_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_run_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_track_credit_id_fk_idx;
DROP INDEX IF EXISTS ingest.merge_audit_track_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_album_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_artist_a_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_artist_b_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_claim_a_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_claim_b_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_conflict_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_organization_a_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_organization_b_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_person_a_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_person_b_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_track_id_fk_idx;
DROP INDEX IF EXISTS ingest.review_queue_video_id_fk_idx;
DROP INDEX IF EXISTS ingest.scrape_errors_raw_page_id_fk_idx;
DROP INDEX IF EXISTS ingest.seed_uploads_run_id_fk_idx;
DROP INDEX IF EXISTS media.media_links_organization_id_fk_idx;
DROP INDEX IF EXISTS media.media_links_person_id_fk_idx;
DROP INDEX IF EXISTS media.media_links_source_id_fk_idx;
DROP INDEX IF EXISTS media.video_albums_claim_id_fk_idx;
DROP INDEX IF EXISTS media.video_albums_source_id_fk_idx;
DROP INDEX IF EXISTS media.video_artists_claim_id_fk_idx;
DROP INDEX IF EXISTS media.video_artists_source_id_fk_idx;
DROP INDEX IF EXISTS media.video_tracks_claim_id_fk_idx;
DROP INDEX IF EXISTS media.video_tracks_source_id_fk_idx;
DROP INDEX IF EXISTS media.youtube_videos_seed_upload_id_fk_idx;

COMMIT;
