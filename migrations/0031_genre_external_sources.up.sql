-- ============================================================================
-- CRV · Migración 0031_genre_external_sources (UP)
-- PLAN_GENEROS_CATALOGO_Y_RADIO_CRV etapa 4: enriquecimiento de géneros con
-- fuentes musicales externas autorizadas (MusicBrainz, Discogs, Wikidata…).
--
--   * `ingest.genre_external_sources`: la FICHA DE EVALUACIÓN Y AUTORIZACIÓN
--     de cada fuente candidata (acceso, licencia, atribución, límites, niveles
--     que publica, cobertura venezolana, estabilidad de identificadores). Una
--     fuente no importa nada mientras no esté autorizada, y no importa en
--     volumen mientras su muestra no alcance el umbral de precisión: las dos
--     cosas las exige la base, no solo el código.
--   * `ingest.genre_external_cache`: respuestas crudas con su URL y su fecha.
--     Caché y trazabilidad: toda sugerencia puede volver a la respuesta exacta
--     que la originó. (`ingest.raw_pages` no sirve: cuelga de `ingest.sources`,
--     que es el catálogo de fuentes que SÍ se raspan.)
--   * `ingest.genre_external_identities`: la resolución de identidad, auditable
--     y por fuente. Una coincidencia solo por nombre no basta: `signals` guarda
--     con qué señales se decidió y `score` cuánto sumaron.
--   * `ingest.genre_external_imports`: qué aportó cada importación (cobertura
--     añadida, acuerdos, desacuerdos, ruido), en seco o aplicada.
--
-- Las sugerencias viven en `ingest.artist_genres` / `ingest.album_genres` con
-- `source_kind = 'external'` y `status = 'suggested'` (la cola de la etapa 3 ya
-- las muestra como `external_suggestion`); aquí solo se les añade de qué fuente
-- externa y con qué identificador vienen. Nunca se crean como `confirmed`: una
-- fuente externa no decide nada.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.genre_external_sources (
  id                    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug                  VARCHAR(40)  NOT NULL,
  name                  VARCHAR(120) NOT NULL,
  homepage              TEXT,
  api_base              TEXT,
  -- Cómo se accede: la ficha dice por qué ese mecanismo está permitido.
  access_mode           VARCHAR(20)  NOT NULL,
  access_note           TEXT         NOT NULL,
  license               VARCHAR(120) NOT NULL,
  attribution           TEXT         NOT NULL,
  terms_url             TEXT,
  rate_limit_per_minute INTEGER      NOT NULL DEFAULT 30,
  -- Niveles que publica la fuente: un género de artista nunca cruza a un disco.
  levels                VARCHAR(10)  NOT NULL,
  coverage_note         TEXT         NOT NULL,
  identifier_stability  TEXT         NOT NULL,
  -- Qué clase de etiquetas se aceptan de esta fuente y cuáles se descartan
  -- (comunitarias, editoriales, técnicas): se mantienen separadas.
  tag_policy            JSONB        NOT NULL DEFAULT '{}'::jsonb,
  status                VARCHAR(12)  NOT NULL DEFAULT 'evaluating',
  import_enabled        BOOLEAN      NOT NULL DEFAULT false,
  bulk_enabled          BOOLEAN      NOT NULL DEFAULT false,
  precision_threshold   NUMERIC(4,3) NOT NULL DEFAULT 0.850,
  precision_measured    NUMERIC(4,3),
  sample_size           INTEGER      NOT NULL DEFAULT 0,
  sample_report         TEXT,
  measured_at           TIMESTAMPTZ,
  evaluated_by          VARCHAR(120),
  evaluated_at          TIMESTAMPTZ,
  authorized_by         VARCHAR(120),
  authorized_at         TIMESTAMPTZ,
  reason                TEXT         NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT genre_external_sources_slug_uk UNIQUE (slug),
  CONSTRAINT genre_external_sources_slug_format_chk CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT genre_external_sources_access_chk CHECK (access_mode IN ('api','dump','sparql')),
  CONSTRAINT genre_external_sources_levels_chk CHECK (levels IN ('artist','album','both')),
  CONSTRAINT genre_external_sources_status_chk CHECK (status IN ('evaluating','authorized','blocked')),
  CONSTRAINT genre_external_sources_rate_chk CHECK (rate_limit_per_minute > 0),
  CONSTRAINT genre_external_sources_threshold_chk CHECK (precision_threshold > 0 AND precision_threshold <= 1),
  CONSTRAINT genre_external_sources_measured_chk CHECK (precision_measured IS NULL OR (precision_measured >= 0 AND precision_measured <= 1)),
  -- Solo una fuente autorizada importa (punto 1 y 2 de la etapa 4).
  CONSTRAINT genre_external_sources_import_chk CHECK (NOT import_enabled OR status = 'authorized'),
  -- Y solo se habilita la carga masiva si la muestra alcanzó el umbral.
  CONSTRAINT genre_external_sources_bulk_chk CHECK (
    NOT bulk_enabled OR (import_enabled AND precision_measured IS NOT NULL AND precision_measured >= precision_threshold)),
  CONSTRAINT genre_external_sources_reason_chk CHECK (btrim(reason) <> '')
);

-- Respuestas crudas: caché (evita repetir la petición) y trazabilidad (la
-- sugerencia puede citar la respuesta exacta y su fecha).
CREATE TABLE IF NOT EXISTS ingest.genre_external_cache (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id   BIGINT       NOT NULL REFERENCES ingest.genre_external_sources(id) ON DELETE CASCADE,
  request_key VARCHAR(300) NOT NULL,
  url         TEXT         NOT NULL,
  status_code INTEGER      NOT NULL,
  payload     JSONB        NOT NULL,
  fetched_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT genre_external_cache_uk UNIQUE (source_id, request_key)
);
CREATE INDEX IF NOT EXISTS genre_external_cache_fetched_idx ON ingest.genre_external_cache (fetched_at);

-- Resolución de identidad, auditable y por fuente (puntos 3 y 4 de la etapa 4).
-- `entity_id` no lleva FK: la columna sirve para artistas y para álbumes; el
-- doctor detecta las que apunten a fichas inexistentes o fusionadas.
CREATE TABLE IF NOT EXISTS ingest.genre_external_identities (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_kind   VARCHAR(10)  NOT NULL,
  entity_id     BIGINT       NOT NULL,
  source_id     BIGINT       NOT NULL REFERENCES ingest.genre_external_sources(id) ON DELETE CASCADE,
  external_id   VARCHAR(160) NOT NULL,
  external_name TEXT         NOT NULL,
  external_url  TEXT,
  score         NUMERIC(4,3) NOT NULL,
  signals       JSONB        NOT NULL DEFAULT '[]'::jsonb,
  status        VARCHAR(10)  NOT NULL,
  decided_by    VARCHAR(120) NOT NULL,
  decision_kind VARCHAR(10)  NOT NULL DEFAULT 'rule',
  reason        TEXT         NOT NULL,
  run_id        BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT genre_external_identities_uk UNIQUE (entity_kind, entity_id, source_id, external_id),
  CONSTRAINT genre_external_identities_kind_chk CHECK (entity_kind IN ('artist','album')),
  CONSTRAINT genre_external_identities_status_chk CHECK (status IN ('matched','ambiguous','rejected')),
  CONSTRAINT genre_external_identities_decision_chk CHECK (decision_kind IN ('rule','human')),
  CONSTRAINT genre_external_identities_score_chk CHECK (score >= 0 AND score <= 1),
  CONSTRAINT genre_external_identities_reason_chk CHECK (btrim(reason) <> '' AND btrim(decided_by) <> '')
);
-- Una ficha tiene como mucho una identidad aceptada por fuente.
CREATE UNIQUE INDEX IF NOT EXISTS genre_external_identities_matched_uk
  ON ingest.genre_external_identities (entity_kind, entity_id, source_id) WHERE status = 'matched';
CREATE INDEX IF NOT EXISTS genre_external_identities_entity_idx
  ON ingest.genre_external_identities (entity_kind, entity_id);
-- Toda FK con su índice (0013): también las que casi nunca se consultan.
CREATE INDEX IF NOT EXISTS genre_external_identities_source_idx
  ON ingest.genre_external_identities (source_id);
CREATE INDEX IF NOT EXISTS genre_external_identities_run_idx
  ON ingest.genre_external_identities (run_id) WHERE run_id IS NOT NULL;

-- Qué aportó cada importación: cobertura añadida, acuerdos con CRV,
-- desacuerdos y ruido (punto 9 de la etapa 4).
CREATE TABLE IF NOT EXISTS ingest.genre_external_imports (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id  BIGINT      NOT NULL REFERENCES ingest.genre_external_sources(id) ON DELETE CASCADE,
  mode       VARCHAR(10) NOT NULL,
  level      VARCHAR(10) NOT NULL,
  dry_run    BOOLEAN     NOT NULL,
  stats      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  actor      VARCHAR(120) NOT NULL,
  reason     TEXT        NOT NULL,
  run_id     BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT genre_external_imports_mode_chk CHECK (mode IN ('sample','bulk')),
  CONSTRAINT genre_external_imports_level_chk CHECK (level IN ('artist','album')),
  CONSTRAINT genre_external_imports_reason_chk CHECK (btrim(reason) <> '' AND btrim(actor) <> '')
);
CREATE INDEX IF NOT EXISTS genre_external_imports_source_idx ON ingest.genre_external_imports (source_id, created_at DESC);
CREATE INDEX IF NOT EXISTS genre_external_imports_run_idx ON ingest.genre_external_imports (run_id) WHERE run_id IS NOT NULL;

-- De qué fuente externa y con qué identificador viene una sugerencia: el
-- valor externo conserva fuente, identificador, nivel (la tabla), fecha
-- (`decided_at`) y evidencia (`evidence`).
DO $$
DECLARE
  target TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['artist','album'] LOOP
    EXECUTE format($ddl$
      ALTER TABLE ingest.%1$s_genres
        ADD COLUMN IF NOT EXISTS external_source_id BIGINT REFERENCES ingest.genre_external_sources(id) ON DELETE RESTRICT,
        ADD COLUMN IF NOT EXISTS external_ref VARCHAR(160)$ddl$, target);
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = format('%s_genres_external_chk', target)) THEN
      EXECUTE format($ddl$
        ALTER TABLE ingest.%1$s_genres ADD CONSTRAINT %1$s_genres_external_chk
          CHECK (external_source_id IS NULL OR source_kind = 'external')$ddl$, target);
    END IF;
    EXECUTE format($ddl$
      CREATE INDEX IF NOT EXISTS %1$s_genres_external_idx ON ingest.%1$s_genres (external_source_id)
        WHERE external_source_id IS NOT NULL$ddl$, target);
  END LOOP;
END $$;

COMMIT;
