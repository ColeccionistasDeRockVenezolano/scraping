-- Coleccionistas de Rock Venezolano
-- Esquema simplificado v1 para PostgreSQL 15+

BEGIN;

CREATE TYPE artist_type AS ENUM (
  'band', 'solo_artist', 'duo', 'project', 'group', 'other'
);

CREATE TYPE album_type AS ENUM (
  'studio_album', 'live_album', 'ep', 'single', 'compilation',
  'demo', 'soundtrack', 'collaboration_album', 'remix', 'other'
);

CREATE TYPE publication_status AS ENUM (
  'published', 'unlisted', 'unpublished', 'copyright_blocked', 'unknown'
);

CREATE TYPE archive_quality AS ENUM ('HQ', 'LQ', 'unknown');
CREATE TYPE archive_status AS ENUM ('published', 'unpublished', 'unknown');

CREATE TYPE organization_type AS ENUM (
  'record_label', 'production_company', 'recording_studio',
  'distributor', 'management', 'other'
);

CREATE TYPE credit_type AS ENUM (
  'musician', 'guest', 'writer', 'composer', 'producer',
  'recording', 'mixing', 'mastering', 'photography', 'artwork', 'other'
);

CREATE TABLE artists (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(200) NOT NULL UNIQUE,
  artist_type artist_type NOT NULL DEFAULT 'band',
  biography TEXT,
  picture_url TEXT,
  origin_city VARCHAR(120),
  origin_country VARCHAR(120) NOT NULL DEFAULT 'Venezuela',
  formed_year SMALLINT,
  disbanded_year SMALLINT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artists_years_chk CHECK (
    formed_year IS NULL OR disbanded_year IS NULL OR disbanded_year >= formed_year
  )
);

CREATE TABLE persons (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  biography TEXT,
  picture_url TEXT,
  nationality VARCHAR(120),
  is_venezuelan BOOLEAN NOT NULL DEFAULT false,
  birth_date DATE,
  death_date DATE,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT persons_dates_chk CHECK (
    birth_date IS NULL OR death_date IS NULL OR death_date >= birth_date
  )
);
CREATE INDEX persons_name_idx ON persons (name);

CREATE TABLE artist_members (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artist_id BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  role VARCHAR(200) NOT NULL,
  from_year SMALLINT,
  to_year SMALLINT,
  is_current BOOLEAN NOT NULL DEFAULT false,
  notes TEXT,
  CONSTRAINT artist_members_years_chk CHECK (
    from_year IS NULL OR to_year IS NULL OR to_year >= from_year
  )
);
CREATE INDEX artist_members_artist_idx ON artist_members (artist_id);
CREATE INDEX artist_members_person_idx ON artist_members (person_id);
CREATE INDEX artist_members_pair_idx ON artist_members (artist_id, person_id);

CREATE TABLE organizations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name VARCHAR(200) NOT NULL,
  organization_type organization_type NOT NULL DEFAULT 'other',
  biography TEXT,
  picture_url TEXT,
  website_url TEXT,
  country VARCHAR(120),
  notes TEXT
);
CREATE INDEX organizations_name_idx ON organizations (name);

CREATE TABLE person_organizations (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id BIGINT NOT NULL REFERENCES persons(id) ON DELETE CASCADE,
  organization_id BIGINT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  role VARCHAR(200) NOT NULL,
  from_year SMALLINT,
  to_year SMALLINT,
  notes TEXT,
  CONSTRAINT person_organizations_years_chk CHECK (
    from_year IS NULL OR to_year IS NULL OR to_year >= from_year
  )
);
CREATE INDEX person_organizations_person_idx ON person_organizations (person_id);
CREATE INDEX person_organizations_org_idx ON person_organizations (organization_id);

CREATE TABLE albums (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artist_id BIGINT NOT NULL REFERENCES artists(id) ON DELETE CASCADE,
  title VARCHAR(250) NOT NULL,
  release_year SMALLINT,
  album_type album_type NOT NULL DEFAULT 'other',
  genre VARCHAR(200),
  label_id BIGINT REFERENCES organizations(id) ON DELETE SET NULL,
  cover_url TEXT,
  description TEXT,
  youtube_url TEXT,
  youtube_status publication_status NOT NULL DEFAULT 'unknown',
  instagram_url TEXT,
  instagram_status publication_status NOT NULL DEFAULT 'unknown',
  wordpress_url TEXT,
  wordpress_status publication_status NOT NULL DEFAULT 'unknown',
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX albums_artist_idx ON albums (artist_id);
CREATE INDEX albums_release_year_idx ON albums (release_year);
CREATE INDEX albums_artist_title_idx ON albums (artist_id, title);

CREATE TABLE tracks (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  album_id BIGINT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  disc_number SMALLINT NOT NULL DEFAULT 1 CHECK (disc_number > 0),
  track_number SMALLINT NOT NULL CHECK (track_number > 0),
  title VARCHAR(250) NOT NULL,
  duration_seconds INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  youtube_start_seconds INTEGER CHECK (youtube_start_seconds IS NULL OR youtube_start_seconds >= 0),
  notes TEXT,
  CONSTRAINT tracks_position_uk UNIQUE (album_id, disc_number, track_number)
);
CREATE INDEX tracks_album_idx ON tracks (album_id);

CREATE TABLE album_credits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  album_id BIGINT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  person_id BIGINT REFERENCES persons(id) ON DELETE CASCADE,
  artist_id BIGINT REFERENCES artists(id) ON DELETE CASCADE,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
  credit_type credit_type NOT NULL,
  role VARCHAR(200) NOT NULL,
  notes TEXT,
  CONSTRAINT album_credits_one_target_chk CHECK (
    (person_id IS NOT NULL)::int +
    (artist_id IS NOT NULL)::int +
    (organization_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX album_credits_album_idx ON album_credits (album_id);
CREATE INDEX album_credits_person_idx ON album_credits (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX album_credits_artist_idx ON album_credits (artist_id) WHERE artist_id IS NOT NULL;
CREATE INDEX album_credits_org_idx ON album_credits (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX album_credits_type_idx ON album_credits (credit_type);

CREATE TABLE track_credits (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  track_id BIGINT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  person_id BIGINT REFERENCES persons(id) ON DELETE CASCADE,
  artist_id BIGINT REFERENCES artists(id) ON DELETE CASCADE,
  organization_id BIGINT REFERENCES organizations(id) ON DELETE CASCADE,
  credit_type credit_type NOT NULL,
  role VARCHAR(200) NOT NULL,
  notes TEXT,
  CONSTRAINT track_credits_one_target_chk CHECK (
    (person_id IS NOT NULL)::int +
    (artist_id IS NOT NULL)::int +
    (organization_id IS NOT NULL)::int = 1
  )
);
CREATE INDEX track_credits_track_idx ON track_credits (track_id);
CREATE INDEX track_credits_person_idx ON track_credits (person_id) WHERE person_id IS NOT NULL;
CREATE INDEX track_credits_artist_idx ON track_credits (artist_id) WHERE artist_id IS NOT NULL;
CREATE INDEX track_credits_org_idx ON track_credits (organization_id) WHERE organization_id IS NOT NULL;
CREATE INDEX track_credits_type_idx ON track_credits (credit_type);

CREATE TABLE album_formats (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  album_id BIGINT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  format VARCHAR(50) NOT NULL,
  quality archive_quality,
  archive_status archive_status NOT NULL DEFAULT 'unknown',
  file_path TEXT,
  notes TEXT
);
CREATE INDEX album_formats_album_idx ON album_formats (album_id);
CREATE INDEX album_formats_album_format_idx ON album_formats (album_id, format);

-- Vistas útiles para la futura web -------------------------------------------

CREATE VIEW person_band_history AS
SELECT
  p.id AS person_id,
  p.name AS person_name,
  a.id AS artist_id,
  a.name AS artist_name,
  am.role,
  am.from_year,
  am.to_year,
  am.is_current
FROM artist_members am
JOIN persons p ON p.id = am.person_id
JOIN artists a ON a.id = am.artist_id;

CREATE VIEW person_album_credits AS
SELECT
  p.id AS person_id,
  p.name AS person_name,
  a.id AS album_id,
  a.title AS album_title,
  ar.name AS artist_name,
  ac.credit_type,
  ac.role,
  ac.notes
FROM album_credits ac
JOIN persons p ON p.id = ac.person_id
JOIN albums a ON a.id = ac.album_id
JOIN artists ar ON ar.id = a.artist_id
WHERE ac.person_id IS NOT NULL;

CREATE VIEW person_track_credits AS
SELECT
  p.id AS person_id,
  p.name AS person_name,
  t.id AS track_id,
  t.title AS track_title,
  a.id AS album_id,
  a.title AS album_title,
  ar.name AS artist_name,
  tc.credit_type,
  tc.role,
  tc.notes
FROM track_credits tc
JOIN persons p ON p.id = tc.person_id
JOIN tracks t ON t.id = tc.track_id
JOIN albums a ON a.id = t.album_id
JOIN artists ar ON ar.id = a.artist_id
WHERE tc.person_id IS NOT NULL;

COMMIT;
