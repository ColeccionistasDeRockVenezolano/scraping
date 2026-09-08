-- ============================================================================
-- CRV · Migración 0009_media_link_constraints (DOWN)
-- Devuelve las tres restricciones a su forma anterior a media_link.
-- Aborta si alguna fila usa ya el destino nuevo: retirar la regla dejaría el
-- dato sin la garantía que lo protege.
-- ============================================================================

BEGIN;

DO $$
DECLARE v_rows bigint;
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema='ingest' AND table_name='claims' AND column_name='media_link_id') THEN
    EXECUTE 'SELECT count(*) FROM ingest.claims WHERE media_link_id IS NOT NULL' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION '% claims apuntan a media_links: no se relajan sus restricciones', v_rows;
    END IF;
    EXECUTE 'SELECT count(*) FROM ingest.merge_audit WHERE media_link_id IS NOT NULL' INTO v_rows;
    IF v_rows > 0 THEN
      RAISE EXCEPTION '% auditorías apuntan a media_links: no se relajan sus restricciones', v_rows;
    END IF;
  END IF;
END $$;

ALTER TABLE ingest.claims DROP CONSTRAINT IF EXISTS claims_one_target_chk;
ALTER TABLE ingest.claims ADD CONSTRAINT claims_one_target_chk CHECK (
  (artist_id IS NOT NULL)::int + (person_id IS NOT NULL)::int
  + (organization_id IS NOT NULL)::int + (album_id IS NOT NULL)::int
  + (track_id IS NOT NULL)::int + (artist_membership_id IS NOT NULL)::int
  + (person_organization_id IS NOT NULL)::int + (album_credit_id IS NOT NULL)::int
  + (track_credit_id IS NOT NULL)::int + (album_format_id IS NOT NULL)::int
  + (video_id IS NOT NULL)::int = ANY (ARRAY[0, 1]));

ALTER TABLE ingest.claims DROP CONSTRAINT IF EXISTS claims_kind_matches_target_chk;
ALTER TABLE ingest.claims ADD CONSTRAINT claims_kind_matches_target_chk CHECK (
  (artist_id IS NULL OR entity_kind = 'artist')
  AND (person_id IS NULL OR entity_kind = 'person')
  AND (organization_id IS NULL OR entity_kind = 'organization')
  AND (album_id IS NULL OR entity_kind = 'album')
  AND (track_id IS NULL OR entity_kind = 'track')
  AND (artist_membership_id IS NULL OR entity_kind = 'artist_membership')
  AND (person_organization_id IS NULL OR entity_kind = 'person_organization')
  AND (album_credit_id IS NULL OR entity_kind = 'album_credit')
  AND (track_credit_id IS NULL OR entity_kind = 'track_credit')
  AND (album_format_id IS NULL OR entity_kind = 'album_format')
  AND (video_id IS NULL OR entity_kind = 'youtube_video'));

ALTER TABLE ingest.merge_audit DROP CONSTRAINT IF EXISTS merge_audit_entity_kind_check;
ALTER TABLE ingest.merge_audit ADD CONSTRAINT merge_audit_entity_kind_check CHECK (
  entity_kind = ANY (ARRAY[
    'artist', 'person', 'organization', 'album', 'track', 'artist_membership',
    'person_organization', 'album_credit', 'track_credit', 'album_format']::ingest.claim_entity_kind[]));

ALTER TABLE ingest.merge_audit DROP CONSTRAINT IF EXISTS merge_audit_one_target_chk;
ALTER TABLE ingest.merge_audit ADD CONSTRAINT merge_audit_one_target_chk CHECK (
  (artist_id IS NOT NULL)::int + (person_id IS NOT NULL)::int
  + (organization_id IS NOT NULL)::int + (album_id IS NOT NULL)::int
  + (track_id IS NOT NULL)::int + (artist_membership_id IS NOT NULL)::int
  + (person_organization_id IS NOT NULL)::int + (album_credit_id IS NOT NULL)::int
  + (track_credit_id IS NOT NULL)::int + (album_format_id IS NOT NULL)::int = 1);

ALTER TABLE ingest.merge_audit DROP CONSTRAINT IF EXISTS merge_audit_kind_matches_target_chk;
ALTER TABLE ingest.merge_audit ADD CONSTRAINT merge_audit_kind_matches_target_chk CHECK (
  (artist_id IS NULL OR entity_kind = 'artist')
  AND (person_id IS NULL OR entity_kind = 'person')
  AND (organization_id IS NULL OR entity_kind = 'organization')
  AND (album_id IS NULL OR entity_kind = 'album')
  AND (track_id IS NULL OR entity_kind = 'track')
  AND (artist_membership_id IS NULL OR entity_kind = 'artist_membership')
  AND (person_organization_id IS NULL OR entity_kind = 'person_organization')
  AND (album_credit_id IS NULL OR entity_kind = 'album_credit')
  AND (track_credit_id IS NULL OR entity_kind = 'track_credit')
  AND (album_format_id IS NULL OR entity_kind = 'album_format'));

COMMIT;
