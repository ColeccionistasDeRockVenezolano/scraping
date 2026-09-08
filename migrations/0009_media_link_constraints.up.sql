-- ============================================================================
-- CRV · Migración 0009_media_link_constraints (UP)
-- Extiende a `media_link` las tres restricciones que gobiernan a qué puede
-- apuntar un claim y una auditoría de merge.
--
-- POR QUÉ VA APARTE DE 0008:
--   0008 añade el valor 'media_link' al enum. PostgreSQL no permite USAR un
--   valor de enum en la misma transacción que lo añade, y la definición de
--   estas restricciones lo usa como literal. Es la misma razón por la que
--   0004 fue un archivo solo. Sin esta migración, escribir la auditoría de un
--   arte falla con merge_audit_entity_kind_check.
--
-- QUÉ GARANTIZAN (y por eso se extienden en vez de relajarse):
--   · un claim/auditoría apunta como mucho a UN destino;
--   · el destino concuerda con el entity_kind, así que una foto de artista no
--     puede quedar colgada de un disco por un mapeo equivocado.
--
-- REGLAS DE GOBIERNO: el schema `public` NO se toca. Idempotente y reversible.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname='ingest' AND t.typname='claim_entity_kind' AND e.enumlabel='media_link'
  ) THEN
    RAISE EXCEPTION 'falta el valor media_link: aplique antes 0008_media_link_claims';
  END IF;
END $$;

-- 1. ingest.claims: un destino como mucho, y concordante con el tipo.
ALTER TABLE ingest.claims DROP CONSTRAINT IF EXISTS claims_one_target_chk;
ALTER TABLE ingest.claims ADD CONSTRAINT claims_one_target_chk CHECK (
  (artist_id IS NOT NULL)::int + (person_id IS NOT NULL)::int
  + (organization_id IS NOT NULL)::int + (album_id IS NOT NULL)::int
  + (track_id IS NOT NULL)::int + (artist_membership_id IS NOT NULL)::int
  + (person_organization_id IS NOT NULL)::int + (album_credit_id IS NOT NULL)::int
  + (track_credit_id IS NOT NULL)::int + (album_format_id IS NOT NULL)::int
  + (video_id IS NOT NULL)::int + (media_link_id IS NOT NULL)::int = ANY (ARRAY[0, 1]));

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
  AND (video_id IS NULL OR entity_kind = 'youtube_video')
  AND (media_link_id IS NULL OR entity_kind = 'media_link'));

-- 2. ingest.merge_audit: mismo par de reglas, más el vocabulario de tipos.
--    `youtube_video` sigue fuera del vocabulario porque el pipeline de vídeo
--    audita en sus propias tablas puente, no aquí.
ALTER TABLE ingest.merge_audit DROP CONSTRAINT IF EXISTS merge_audit_entity_kind_check;
ALTER TABLE ingest.merge_audit ADD CONSTRAINT merge_audit_entity_kind_check CHECK (
  entity_kind = ANY (ARRAY[
    'artist', 'person', 'organization', 'album', 'track', 'artist_membership',
    'person_organization', 'album_credit', 'track_credit', 'album_format',
    'media_link']::ingest.claim_entity_kind[]));

ALTER TABLE ingest.merge_audit DROP CONSTRAINT IF EXISTS merge_audit_one_target_chk;
ALTER TABLE ingest.merge_audit ADD CONSTRAINT merge_audit_one_target_chk CHECK (
  (artist_id IS NOT NULL)::int + (person_id IS NOT NULL)::int
  + (organization_id IS NOT NULL)::int + (album_id IS NOT NULL)::int
  + (track_id IS NOT NULL)::int + (artist_membership_id IS NOT NULL)::int
  + (person_organization_id IS NOT NULL)::int + (album_credit_id IS NOT NULL)::int
  + (track_credit_id IS NOT NULL)::int + (album_format_id IS NOT NULL)::int
  + (media_link_id IS NOT NULL)::int = 1);

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
  AND (album_format_id IS NULL OR entity_kind = 'album_format')
  AND (media_link_id IS NULL OR entity_kind = 'media_link'));

COMMIT;
