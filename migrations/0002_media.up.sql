-- ============================================================================
-- CRV · Migración 0002_media (UP)
-- Schema `media`: videos de YouTube (fuente de primera clase), relaciones
-- N:N video<->artist / video<->album, ocurrencias de tracks dentro de
-- videos, y enlaces de medios (imágenes sin descarga masiva).
--
-- REGLAS DE GOBIERNO:
--   * El schema `public` (core) NO se toca.
--   * tracks.youtube_start_seconds (core) se preserva como timestamp del
--     video principal; NO es la única fuente de timestamps: las ocurrencias
--     viven en media.video_tracks (una canción puede aparecer en N videos).
--   * albums.youtube_url (core) se mantiene como enlace principal; la
--     unicidad de "un enlace principal por álbum" se garantiza aquí con un
--     índice parcial (video_albums.is_primary_link), sin tocar el core.
--   * Un video de tipo music video / live concert / documentary NUNCA crea
--     álbumes: solo se vincula a álbumes existentes.
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS media;

-- ---------------------------------------------------------------------------
-- Enums de media
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'media' AND t.typname = 'video_relation_kind') THEN
    EXECUTE 'CREATE TYPE media.video_relation_kind AS ENUM (''performer'', ''channel'', ''subject'', ''other'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'media' AND t.typname = 'video_album_kind') THEN
    EXECUTE 'CREATE TYPE media.video_album_kind AS ENUM (''full_album'', ''music_video'', ''live_concert'', ''documentary'', ''other'')';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- youtube_videos: registro canónico de videos de YouTube.
-- publication_status reutiliza el enum del core (public.publication_status)
-- SIN modificarlo; es un uso de lectura del tipo.
-- metadata = payload original de la YouTube Data API (JSONB justificado).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media.youtube_videos (
  id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id           VARCHAR(11) NOT NULL CHECK (video_id ~ '^[A-Za-z0-9_-]{11}$'),
  url                TEXT,
  title              TEXT,
  description        TEXT,
  channel_id         VARCHAR(80),
  channel_title      VARCHAR(200),
  published_at       TIMESTAMPTZ,
  duration_seconds   INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  thumbnail_url      TEXT,
  publication_status public.publication_status NOT NULL DEFAULT 'unknown',
  metadata           JSONB,                       -- snapshot original de la Data API
  first_seen_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_fetched_at    TIMESTAMPTZ,
  seed_upload_id     BIGINT REFERENCES ingest.seed_uploads(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT youtube_videos_video_id_uk UNIQUE (video_id)
);

CREATE INDEX IF NOT EXISTS youtube_videos_channel_idx    ON media.youtube_videos (channel_id);
CREATE INDEX IF NOT EXISTS youtube_videos_published_idx  ON media.youtube_videos (published_at);
CREATE INDEX IF NOT EXISTS youtube_videos_status_idx     ON media.youtube_videos (publication_status);

-- ---------------------------------------------------------------------------
-- video_artists: N:N video <-> artist (un video puede relacionarse con
-- varios artistas y viceversa). FK reales a media.youtube_videos y
-- public.artists.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media.video_artists (
  video_id      BIGINT NOT NULL REFERENCES media.youtube_videos(id) ON DELETE CASCADE,
  artist_id     BIGINT NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,
  relation_kind media.video_relation_kind NOT NULL DEFAULT 'performer',
  confidence    ingest.confidence_level NOT NULL DEFAULT 'medium',
  source_id     BIGINT REFERENCES ingest.sources(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT video_artists_pk PRIMARY KEY (video_id, artist_id, relation_kind)
);

CREATE INDEX IF NOT EXISTS video_artists_artist_idx ON media.video_artists (artist_id);

-- ---------------------------------------------------------------------------
-- video_albums: N:N video <-> album. Un álbum puede tener múltiples videos;
-- un video puede relacionarse con múltiples álbumes (p. ej. un concierto
-- que cubre varios lanzamientos). is_primary_link marca el video principal
-- del álbum (el que se proyecta a albums.youtube_url, core).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media.video_albums (
  video_id        BIGINT NOT NULL REFERENCES media.youtube_videos(id) ON DELETE CASCADE,
  album_id        BIGINT NOT NULL REFERENCES public.albums(id) ON DELETE CASCADE,
  album_kind      media.video_album_kind NOT NULL DEFAULT 'other',
  is_primary_link BOOLEAN NOT NULL DEFAULT false,
  confidence      ingest.confidence_level NOT NULL DEFAULT 'medium',
  source_id       BIGINT REFERENCES ingest.sources(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT video_albums_pk PRIMARY KEY (video_id, album_id),
  CONSTRAINT video_albums_primary_confidence_chk
    CHECK (NOT is_primary_link OR confidence <> 'low')
);

-- A lo sumo UN enlace principal por álbum (protege la unicidad de
-- albums.youtube_url sin tocar el core).
CREATE UNIQUE INDEX IF NOT EXISTS video_albums_one_primary_per_album_uk
  ON media.video_albums (album_id) WHERE is_primary_link;

CREATE INDEX IF NOT EXISTS video_albums_album_idx ON media.video_albums (album_id);

-- ---------------------------------------------------------------------------
-- video_tracks: ocurrencias de tracks dentro de videos (N:N con datos de
-- ocurrencia). Una canción puede aparecer en varios videos; un video puede
-- contener muchas canciones. start_seconds/end_seconds + confidence por
-- ocurrencia. El core tracks.youtube_start_seconds NO es la única fuente.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media.video_tracks (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  video_id      BIGINT NOT NULL REFERENCES media.youtube_videos(id) ON DELETE CASCADE,
  track_id      BIGINT NOT NULL REFERENCES public.tracks(id) ON DELETE CASCADE,
  start_seconds INTEGER NOT NULL CHECK (start_seconds >= 0),
  end_seconds   INTEGER CHECK (end_seconds IS NULL OR end_seconds > start_seconds),
  confidence    ingest.confidence_level NOT NULL DEFAULT 'medium',
  source_id     BIGINT REFERENCES ingest.sources(id) ON DELETE SET NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT video_tracks_occurrence_uk UNIQUE (video_id, track_id, start_seconds)
);

CREATE INDEX IF NOT EXISTS video_tracks_track_idx  ON media.video_tracks (track_id);
CREATE INDEX IF NOT EXISTS video_tracks_video_idx  ON media.video_tracks (video_id, start_seconds);

-- ---------------------------------------------------------------------------
-- media_links: URL + fuente + metadatos de medios (portadas, fotos, scans),
-- SIN descarga masiva. FK reales al core; exactamente un destino.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS media.media_links (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_kind     VARCHAR(20) NOT NULL
                  CHECK (entity_kind IN ('artist','person','organization','album')),
  artist_id       BIGINT REFERENCES public.artists(id)       ON DELETE CASCADE,
  person_id       BIGINT REFERENCES public.persons(id)       ON DELETE CASCADE,
  organization_id BIGINT REFERENCES public.organizations(id) ON DELETE CASCADE,
  album_id        BIGINT REFERENCES public.albums(id)        ON DELETE CASCADE,
  url             TEXT NOT NULL,
  media_type      VARCHAR(20) NOT NULL DEFAULT 'other'
                  CHECK (media_type IN ('cover','artist_photo','scan','logo','other')),
  source_id       BIGINT REFERENCES ingest.sources(id) ON DELETE SET NULL,
  meta            JSONB,                        -- metadatos del medio (JSONB justificado)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT media_links_one_target_chk CHECK (
    (artist_id IS NOT NULL)::int + (person_id IS NOT NULL)::int +
    (organization_id IS NOT NULL)::int + (album_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT media_links_kind_matches_target_chk CHECK (
    (artist_id       IS NULL OR entity_kind = 'artist') AND
    (person_id       IS NULL OR entity_kind = 'person') AND
    (organization_id IS NULL OR entity_kind = 'organization') AND
    (album_id        IS NULL OR entity_kind = 'album')
  )
);

-- Dedupe por entidad + URL (expresión: las FKs son excluyentes por CHECK).
CREATE UNIQUE INDEX IF NOT EXISTS media_links_entity_url_uk ON media.media_links (
  COALESCE(artist_id, person_id, organization_id, album_id), url
);

CREATE INDEX IF NOT EXISTS media_links_artist_idx ON media.media_links (artist_id) WHERE artist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS media_links_album_idx  ON media.media_links (album_id)  WHERE album_id IS NOT NULL;

COMMIT;
