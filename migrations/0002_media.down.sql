-- ============================================================================
-- CRV · Migración 0002_media (DOWN) — reversible
-- Elimina SOLO objetos del schema media creados en 0002 (incluidas las
-- columnas claim_id que 0003 añada a estas tablas, por CASCADE del DROP).
-- NO toca el schema public (core).
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS media.media_links     CASCADE;
DROP TABLE IF EXISTS media.video_tracks    CASCADE;
DROP TABLE IF EXISTS media.video_albums    CASCADE;
DROP TABLE IF EXISTS media.video_artists   CASCADE;
DROP TABLE IF EXISTS media.youtube_videos  CASCADE;

DROP TYPE IF EXISTS media.video_album_kind    CASCADE;
DROP TYPE IF EXISTS media.video_relation_kind CASCADE;

DROP SCHEMA IF EXISTS media;

COMMIT;
