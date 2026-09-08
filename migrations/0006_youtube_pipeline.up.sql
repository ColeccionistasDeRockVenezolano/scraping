-- CRV · 0006_youtube_pipeline: evidencia y estado para la ingesta oficial
-- de YouTube. El core public permanece intacto.
BEGIN;

ALTER TABLE ingest.seed_uploads
  ADD COLUMN IF NOT EXISTS content_kind VARCHAR(12)
    CHECK (content_kind IN ('release', 'media', 'review')),
  ADD COLUMN IF NOT EXISTS normalized_type VARCHAR(40),
  ADD COLUMN IF NOT EXISTS classification_reason TEXT;

CREATE TABLE IF NOT EXISTS media.youtube_channels (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id VARCHAR(80) NOT NULL UNIQUE,
  title TEXT,
  description TEXT,
  uploads_playlist_id VARCHAR(80),
  thumbnail_url TEXT,
  publication_status public.publication_status NOT NULL DEFAULT 'unknown',
  metadata JSONB,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetched_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS media.youtube_channel_uploads (
  channel_id BIGINT NOT NULL REFERENCES media.youtube_channels(id) ON DELETE CASCADE,
  video_id VARCHAR(11) NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  playlist_position INTEGER,
  published_at TIMESTAMPTZ,
  title TEXT,
  payload JSONB NOT NULL,
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (channel_id, video_id)
);

CREATE INDEX IF NOT EXISTS youtube_channel_uploads_video_idx
  ON media.youtube_channel_uploads(video_id);

ALTER TABLE media.youtube_videos ADD COLUMN IF NOT EXISTS tags JSONB;

CREATE TABLE IF NOT EXISTS media.youtube_description_sections (
  video_id BIGINT NOT NULL REFERENCES media.youtube_videos(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  section_kind VARCHAR(30) NOT NULL,
  heading TEXT NOT NULL,
  content TEXT NOT NULL,
  PRIMARY KEY (video_id, position)
);

CREATE TABLE IF NOT EXISTS media.youtube_tracklist_entries (
  video_id BIGINT NOT NULL REFERENCES media.youtube_videos(id) ON DELETE CASCADE,
  position SMALLINT NOT NULL,
  title TEXT NOT NULL,
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  PRIMARY KEY (video_id, position),
  UNIQUE (video_id, start_seconds, title)
);

COMMIT;
