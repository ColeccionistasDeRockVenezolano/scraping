BEGIN;
DROP TABLE IF EXISTS media.youtube_tracklist_entries;
DROP TABLE IF EXISTS media.youtube_description_sections;
ALTER TABLE media.youtube_videos DROP COLUMN IF EXISTS tags;
DROP TABLE IF EXISTS media.youtube_channel_uploads;
DROP TABLE IF EXISTS media.youtube_channels;
ALTER TABLE ingest.seed_uploads
  DROP COLUMN IF EXISTS classification_reason,
  DROP COLUMN IF EXISTS normalized_type,
  DROP COLUMN IF EXISTS content_kind;
COMMIT;
