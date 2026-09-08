-- ============================================================================
-- CRV · Migración 0001_ingest_core (UP)
-- Schema `ingest`: enums base, fuentes, páginas crudas, runs de scraping,
-- errores, seed del YT Master Spreadsheet y géneros configurables.
--
-- REGLAS DE GOBIERNO (CRV_IMPLEMENTATION_CONTRACT.md):
--   * El schema `public` (core canónico, crv_simple_v1.sql) NO se toca.
--   * Solo se crean objetos nuevos en schemas separados (ingest / media).
--   * Idempotente: puede re-ejecutarse sin efectos (IF NOT EXISTS / DO guards).
--   * Reversible: ver 0001_ingest_core.down.sql
-- ============================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS ingest;

-- ---------------------------------------------------------------------------
-- Enums base de ingest
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'trust_level') THEN
    EXECUTE 'CREATE TYPE ingest.trust_level AS ENUM (''high'', ''medium'', ''low'', ''api'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'run_kind') THEN
    EXECUTE 'CREATE TYPE ingest.run_kind AS ENUM (''scrape_source'', ''seed_yt'', ''yt_api_sync'', ''enrich_artist'', ''merge_run'', ''manual'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'run_status') THEN
    EXECUTE 'CREATE TYPE ingest.run_status AS ENUM (''running'', ''ok'', ''partial'', ''failed'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'confidence_level') THEN
    EXECUTE 'CREATE TYPE ingest.confidence_level AS ENUM (''high'', ''medium'', ''low'')';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- sources: registro de fuentes autorizadas (conjunto cerrado; altas con
-- aprobación manual). enabled=false = no se scrapea.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.sources (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug            VARCHAR(80) NOT NULL,
  name            VARCHAR(200) NOT NULL,
  url             TEXT,
  site_type       VARCHAR(40) NOT NULL DEFAULT 'website'
                  CHECK (site_type IN ('blogspot','wordpress','website','database',
                                       'instagram','spreadsheet','youtube_api')),
  access_strategy TEXT,                       -- estrategia esperada (SOURCES.md)
  requires_js     BOOLEAN NOT NULL DEFAULT false,
  trust_level     ingest.trust_level NOT NULL DEFAULT 'low',
  enabled         BOOLEAN NOT NULL DEFAULT false,
  public_display  BOOLEAN NOT NULL DEFAULT false,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT sources_slug_uk UNIQUE (slug)
);

-- ---------------------------------------------------------------------------
-- raw_pages: páginas concretas procesadas. Una fila por snapshot descargado.
-- El contenido vive en disco (stored_path); aquí los metadatos.
-- La re-descarga de una misma URL genera una fila nueva (historia); el par
-- (source_id, sha256) evita almacenar el mismo contenido dos veces.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.raw_pages (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id     BIGINT NOT NULL REFERENCES ingest.sources(id) ON DELETE RESTRICT,
  url           TEXT NOT NULL,                -- URL solicitada
  canonical_url TEXT,                         -- URL canónica (tras redirects)
  http_status   SMALLINT CHECK (http_status IS NULL OR http_status BETWEEN 100 AND 599),
  content_type  VARCHAR(120),
  sha256        VARCHAR(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  byte_size     BIGINT CHECK (byte_size IS NULL OR byte_size > 0),
  stored_path   TEXT NOT NULL,                -- ubicación del snapshot crudo
  fetched_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  headers       JSONB,                        -- payload original HTTP (JSONB justificado)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT raw_pages_source_hash_uk UNIQUE (source_id, sha256)
);

CREATE INDEX IF NOT EXISTS raw_pages_source_url_idx     ON ingest.raw_pages (source_id, canonical_url);
CREATE INDEX IF NOT EXISTS raw_pages_source_fetched_idx ON ingest.raw_pages (source_id, fetched_at DESC);

-- ---------------------------------------------------------------------------
-- scrape_runs: ejecuciones (scrape masivo por fuente, importación del seed,
-- sync de YouTube Data API, enriquecimiento por artista, merge, manual).
-- params/counters varían por kind → JSONB justificado.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.scrape_runs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind        ingest.run_kind NOT NULL,
  source_id   BIGINT REFERENCES ingest.sources(id) ON DELETE SET NULL,
  status      ingest.run_status NOT NULL DEFAULT 'running',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  params      JSONB,                            -- parámetros del run (varían por kind)
  counters    JSONB,                            -- total/created/updated/skipped/failed/queued_review
  error_log   TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT scrape_runs_time_chk CHECK (finished_at IS NULL OR finished_at >= started_at)
);

CREATE INDEX IF NOT EXISTS scrape_runs_kind_idx      ON ingest.scrape_runs (kind, started_at DESC);
CREATE INDEX IF NOT EXISTS scrape_runs_source_idx    ON ingest.scrape_runs (source_id, started_at DESC);
CREATE INDEX IF NOT EXISTS scrape_runs_status_idx    ON ingest.scrape_runs (status) WHERE status = 'running';

-- ---------------------------------------------------------------------------
-- scrape_errors: errores por página dentro de un run.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.scrape_errors (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       BIGINT NOT NULL REFERENCES ingest.scrape_runs(id) ON DELETE CASCADE,
  raw_page_id  BIGINT REFERENCES ingest.raw_pages(id) ON DELETE SET NULL,
  url          TEXT NOT NULL,
  error_kind   VARCHAR(40) NOT NULL
               CHECK (error_kind IN ('http_error','network','parse','validation','extraction','other')),
  message      TEXT NOT NULL,
  retry_count  SMALLINT NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
  occurred_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scrape_errors_run_idx ON ingest.scrape_errors (run_id);

-- ---------------------------------------------------------------------------
-- seed_uploads: copia verbatim e inmutable de las filas del
-- YT Master Spreadsheet. upload_order se conserva exacto (sin renumerar).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.seed_uploads (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  upload_order    SMALLINT NOT NULL,
  artist_name_raw VARCHAR(200),
  album_name_raw  VARCHAR(250),
  album_year_raw  SMALLINT,
  type_raw        VARCHAR(200),
  url_raw         TEXT,
  status_raw      VARCHAR(40),
  video_id        VARCHAR(11)
                  CHECK (video_id IS NULL OR video_id ~ '^[A-Za-z0-9_-]{11}$'),
  row_number      SMALLINT,                    -- fila física del XLSX (trazabilidad)
  row_hash        VARCHAR(64) NOT NULL CHECK (row_hash ~ '^[0-9a-f]{64}$'),
  run_id          BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  imported_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT seed_uploads_order_uk UNIQUE (upload_order)
);

CREATE INDEX IF NOT EXISTS seed_uploads_row_hash_idx ON ingest.seed_uploads (row_hash);
CREATE INDEX IF NOT EXISTS seed_uploads_video_id_idx ON ingest.seed_uploads (video_id) WHERE video_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- genres: géneros aceptados (configurables). albums.genre (core) se valida
-- contra esta tabla; un valor no listado no bloquea la ingesta (review).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.genres (
  id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name   VARCHAR(100) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT true,
  notes  TEXT,
  CONSTRAINT genres_name_uk UNIQUE (name)
);

COMMIT;
