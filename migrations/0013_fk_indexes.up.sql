-- ============================================================================
-- CRV · Migración 0013_fk_indexes (UP)
-- Índices para las claves foráneas de `ingest` y `media` que no tenían uno
-- (PHASES.md E11; plan de implementación, FASE 11: auditoría de índices).
--
-- POR QUÉ: PostgreSQL no indexa por sí mismo el lado hijo de una FK. Cada
--   DELETE de una fila padre (retirar una pista, fusionar dos personas, borrar
--   un crédito) comprueba sus hijos con un recorrido secuencial. Medido en la
--   base de desarrollo el 2026-09-14: 4,0 s por fila de `tracks` solo en
--   `entity_resolution_decisions.track_id`, 4,6 s por crédito en
--   `claims.track_credit_id`, 0,7 s en `merge_audit.track_id` y 0,5 s en
--   `review_queue.person_a_id`. Un apply que retira 218 pistas pasaba minutos
--   con bloqueos abiertos.
--
-- CÓMO: un índice por FK de una columna sin índice que empiece por ella. Los
--   parciales (`WHERE col IS NOT NULL`) sirven igual para la comprobación de
--   la FK (`col = $1` implica no nulo) y no pesan por las filas que no apuntan
--   a nada, que en estas tablas son la mayoría.
--
-- FUERA: `public.albums.label_id` también carece de índice, pero es core y
--   no se toca (5.056 filas; el recorrido es barato).
--
-- REGLAS DE GOBIERNO: el schema `public` NO se toca. Idempotente y reversible.
-- ============================================================================

BEGIN;

-- ingest.ai_biographies
CREATE INDEX IF NOT EXISTS ai_biographies_artist_id_fk_idx ON ingest.ai_biographies (artist_id) WHERE artist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_biographies_person_id_fk_idx ON ingest.ai_biographies (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ai_biographies_review_queue_id_fk_idx ON ingest.ai_biographies (review_queue_id) WHERE review_queue_id IS NOT NULL;

-- ingest.*_aliases
CREATE INDEX IF NOT EXISTS album_aliases_claim_id_fk_idx ON ingest.album_aliases (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS album_aliases_raw_page_id_fk_idx ON ingest.album_aliases (raw_page_id) WHERE raw_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS album_aliases_source_id_fk_idx ON ingest.album_aliases (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS artist_aliases_claim_id_fk_idx ON ingest.artist_aliases (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS artist_aliases_raw_page_id_fk_idx ON ingest.artist_aliases (raw_page_id) WHERE raw_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS artist_aliases_source_id_fk_idx ON ingest.artist_aliases (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS organization_aliases_claim_id_fk_idx ON ingest.organization_aliases (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS organization_aliases_raw_page_id_fk_idx ON ingest.organization_aliases (raw_page_id) WHERE raw_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS organization_aliases_source_id_fk_idx ON ingest.organization_aliases (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_aliases_claim_id_fk_idx ON ingest.person_aliases (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_aliases_raw_page_id_fk_idx ON ingest.person_aliases (raw_page_id) WHERE raw_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS person_aliases_source_id_fk_idx ON ingest.person_aliases (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS track_aliases_claim_id_fk_idx ON ingest.track_aliases (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS track_aliases_raw_page_id_fk_idx ON ingest.track_aliases (raw_page_id) WHERE raw_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS track_aliases_source_id_fk_idx ON ingest.track_aliases (source_id) WHERE source_id IS NOT NULL;

-- ingest.album_classifications, ambiguity_resolutions, review_decisions
CREATE INDEX IF NOT EXISTS album_classifications_seed_upload_id_fk_idx ON ingest.album_classifications (seed_upload_id) WHERE seed_upload_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ambiguity_resolutions_ai_run_id_fk_idx ON ingest.ambiguity_resolutions (ai_run_id) WHERE ai_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ambiguity_resolutions_applied_run_id_fk_idx ON ingest.ambiguity_resolutions (applied_run_id) WHERE applied_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ambiguity_resolutions_run_id_fk_idx ON ingest.ambiguity_resolutions (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_decisions_applied_run_id_fk_idx ON ingest.review_decisions (applied_run_id) WHERE applied_run_id IS NOT NULL;

-- ingest.claims y claim_evidence
CREATE INDEX IF NOT EXISTS claim_evidence_raw_page_id_fk_idx ON ingest.claim_evidence (raw_page_id) WHERE raw_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claim_evidence_seed_upload_id_fk_idx ON ingest.claim_evidence (seed_upload_id) WHERE seed_upload_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_album_credit_id_fk_idx ON ingest.claims (album_credit_id) WHERE album_credit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_album_format_id_fk_idx ON ingest.claims (album_format_id) WHERE album_format_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_artist_membership_id_fk_idx ON ingest.claims (artist_membership_id) WHERE artist_membership_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_person_organization_id_fk_idx ON ingest.claims (person_organization_id) WHERE person_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_raw_page_id_fk_idx ON ingest.claims (raw_page_id) WHERE raw_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_run_id_fk_idx ON ingest.claims (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_seed_upload_id_fk_idx ON ingest.claims (seed_upload_id) WHERE seed_upload_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_track_credit_id_fk_idx ON ingest.claims (track_credit_id) WHERE track_credit_id IS NOT NULL;

-- ingest.conflicts
CREATE INDEX IF NOT EXISTS conflicts_claim_b_id_fk_idx ON ingest.conflicts (claim_b_id);

-- ingest.entity_resolution_decisions
CREATE INDEX IF NOT EXISTS entity_resolution_decisions_ai_run_id_fk_idx ON ingest.entity_resolution_decisions (ai_run_id) WHERE ai_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_resolution_decisions_album_id_fk_idx ON ingest.entity_resolution_decisions (album_id) WHERE album_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_resolution_decisions_artist_id_fk_idx ON ingest.entity_resolution_decisions (artist_id) WHERE artist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_resolution_decisions_claim_id_fk_idx ON ingest.entity_resolution_decisions (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_resolution_decisions_organization_id_fk_idx ON ingest.entity_resolution_decisions (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_resolution_decisions_person_id_fk_idx ON ingest.entity_resolution_decisions (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_resolution_decisions_run_id_fk_idx ON ingest.entity_resolution_decisions (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_resolution_decisions_track_id_fk_idx ON ingest.entity_resolution_decisions (track_id) WHERE track_id IS NOT NULL;

-- ingest.merge_audit
CREATE INDEX IF NOT EXISTS merge_audit_album_credit_id_fk_idx ON ingest.merge_audit (album_credit_id) WHERE album_credit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_album_format_id_fk_idx ON ingest.merge_audit (album_format_id) WHERE album_format_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_artist_membership_id_fk_idx ON ingest.merge_audit (artist_membership_id) WHERE artist_membership_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_media_link_id_fk_idx ON ingest.merge_audit (media_link_id) WHERE media_link_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_organization_id_fk_idx ON ingest.merge_audit (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_person_id_fk_idx ON ingest.merge_audit (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_person_organization_id_fk_idx ON ingest.merge_audit (person_organization_id) WHERE person_organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_run_id_fk_idx ON ingest.merge_audit (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_track_credit_id_fk_idx ON ingest.merge_audit (track_credit_id) WHERE track_credit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_track_id_fk_idx ON ingest.merge_audit (track_id) WHERE track_id IS NOT NULL;

-- ingest.review_queue
CREATE INDEX IF NOT EXISTS review_queue_album_id_fk_idx ON ingest.review_queue (album_id) WHERE album_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_artist_a_id_fk_idx ON ingest.review_queue (artist_a_id) WHERE artist_a_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_artist_b_id_fk_idx ON ingest.review_queue (artist_b_id) WHERE artist_b_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_claim_a_id_fk_idx ON ingest.review_queue (claim_a_id) WHERE claim_a_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_claim_b_id_fk_idx ON ingest.review_queue (claim_b_id) WHERE claim_b_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_conflict_id_fk_idx ON ingest.review_queue (conflict_id) WHERE conflict_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_organization_a_id_fk_idx ON ingest.review_queue (organization_a_id) WHERE organization_a_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_organization_b_id_fk_idx ON ingest.review_queue (organization_b_id) WHERE organization_b_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_person_a_id_fk_idx ON ingest.review_queue (person_a_id) WHERE person_a_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_person_b_id_fk_idx ON ingest.review_queue (person_b_id) WHERE person_b_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_track_id_fk_idx ON ingest.review_queue (track_id) WHERE track_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS review_queue_video_id_fk_idx ON ingest.review_queue (video_id) WHERE video_id IS NOT NULL;

-- ingest.scrape_errors, seed_uploads
CREATE INDEX IF NOT EXISTS scrape_errors_raw_page_id_fk_idx ON ingest.scrape_errors (raw_page_id) WHERE raw_page_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS seed_uploads_run_id_fk_idx ON ingest.seed_uploads (run_id) WHERE run_id IS NOT NULL;

-- media
CREATE INDEX IF NOT EXISTS media_links_organization_id_fk_idx ON media.media_links (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_links_person_id_fk_idx ON media.media_links (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_links_source_id_fk_idx ON media.media_links (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_albums_claim_id_fk_idx ON media.video_albums (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_albums_source_id_fk_idx ON media.video_albums (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_artists_claim_id_fk_idx ON media.video_artists (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_artists_source_id_fk_idx ON media.video_artists (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_tracks_claim_id_fk_idx ON media.video_tracks (claim_id) WHERE claim_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS video_tracks_source_id_fk_idx ON media.video_tracks (source_id) WHERE source_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS youtube_videos_seed_upload_id_fk_idx ON media.youtube_videos (seed_upload_id) WHERE seed_upload_id IS NOT NULL;

COMMIT;
