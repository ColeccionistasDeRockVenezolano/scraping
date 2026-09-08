-- ============================================================================
-- CRV · Migración 0003_ingest_claims_identity (UP)
-- Identidad (aliases), claims/evidencia, conflictos, review queue y
-- auditoría de merge. Completa el schema ingest e incorpora el enlace de
-- procedencia claim_id a las tablas de media creadas en 0002.
--
-- DISEÑO (objetivo anti-polimorfismo del contrato):
--   * Cada tabla de aliases apunta con FK REAL a su entidad core.
--   * claims apunta a las 11 entidades posibles con 11 FKs reales y un CHECK
--     de "exactamente un destino o propuesta" (mismo patrón que el core usa
--     en album_credits). Los claims sin entidad canónica todavía (propuestas
--     de entidades nuevas) llevan todas las FKs NULL y se identifican por
--     entity_kind + raw_value/normalized_value (justificación documentada).
--   * merge_audit usa el mismo patrón con "exactamente un destino".
-- ============================================================================

BEGIN;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'claim_status') THEN
    EXECUTE 'CREATE TYPE ingest.claim_status AS ENUM (''candidate'', ''accepted'', ''rejected'', ''conflict'', ''superseded'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'claim_entity_kind') THEN
    EXECUTE 'CREATE TYPE ingest.claim_entity_kind AS ENUM (''artist'', ''person'', ''organization'', ''album'', ''track'', ''artist_membership'', ''person_organization'', ''album_credit'', ''track_credit'', ''album_format'', ''youtube_video'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'actor_kind') THEN
    EXECUTE 'CREATE TYPE ingest.actor_kind AS ENUM (''system'', ''ai'', ''human'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'review_kind') THEN
    EXECUTE 'CREATE TYPE ingest.review_kind AS ENUM (''possible_duplicate'', ''field_conflict'', ''ambiguous_alias'', ''album_match'', ''person_match'', ''organization_match'', ''youtube_match'', ''manual_review'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'review_status') THEN
    EXECUTE 'CREATE TYPE ingest.review_status AS ENUM (''open'', ''in_progress'', ''approved'', ''dismissed'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'alias_type') THEN
    EXECUTE 'CREATE TYPE ingest.alias_type AS ENUM (''name_variant'', ''spelling_variant'', ''former_name'', ''stage_name'', ''acronym'', ''misspelling'', ''alternate_title'', ''other'')';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
                 WHERE n.nspname = 'ingest' AND t.typname = 'conflict_status') THEN
    EXECUTE 'CREATE TYPE ingest.conflict_status AS ENUM (''open'', ''resolved_a'', ''resolved_b'', ''both_kept'', ''dismissed'')';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- claims: "La fuente X afirma el valor Y sobre el campo Z de la entidad E".
-- Conserva valores contradictorios simultáneamente sin tocar el dato
-- canónico (el merge engine decide según confianza y estado).
--
-- Estados: candidate → accepted | rejected | conflict | superseded.
-- Política de gobierno:
--   high      → el merge engine puede aplicarlo y marcarlo accepted.
--   medium    → solo información nueva no conflictiva.
--   low       → nunca modifica datos canónicos (queda candidate hasta review).
--   conflict  → dos claims aceptables con valores distintos; el core no se toca.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.claims (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_id              BIGINT NOT NULL REFERENCES ingest.sources(id) ON DELETE RESTRICT,
  raw_page_id            BIGINT REFERENCES ingest.raw_pages(id)    ON DELETE SET NULL,
  seed_upload_id         BIGINT REFERENCES ingest.seed_uploads(id) ON DELETE SET NULL,
  entity_kind            ingest.claim_entity_kind NOT NULL,
  -- Destino: exactamente una FK o ninguna (propuesta de entidad nueva).
  artist_id              BIGINT REFERENCES public.artists(id)             ON DELETE CASCADE,
  person_id              BIGINT REFERENCES public.persons(id)             ON DELETE CASCADE,
  organization_id        BIGINT REFERENCES public.organizations(id)       ON DELETE CASCADE,
  album_id               BIGINT REFERENCES public.albums(id)              ON DELETE CASCADE,
  track_id               BIGINT REFERENCES public.tracks(id)              ON DELETE CASCADE,
  artist_membership_id   BIGINT REFERENCES public.artist_members(id)      ON DELETE CASCADE,
  person_organization_id BIGINT REFERENCES public.person_organizations(id) ON DELETE CASCADE,
  album_credit_id        BIGINT REFERENCES public.album_credits(id)       ON DELETE CASCADE,
  track_credit_id        BIGINT REFERENCES public.track_credits(id)       ON DELETE CASCADE,
  album_format_id        BIGINT REFERENCES public.album_formats(id)       ON DELETE CASCADE,
  video_id               BIGINT REFERENCES media.youtube_videos(id)       ON DELETE CASCADE,
  field                  VARCHAR(80) NOT NULL,
  raw_value              JSONB NOT NULL,          -- valor estructurado original
  normalized_value       JSONB,                   -- valor normalizado por el pipeline
  raw_hash               VARCHAR(64) NOT NULL CHECK (raw_hash ~ '^[0-9a-f]{64}$'),
  extractor              VARCHAR(80),             -- parser/adaptador
  extractor_version      VARCHAR(40),             -- versión del adaptador
  confidence             ingest.confidence_level NOT NULL DEFAULT 'low',
  status                 ingest.claim_status NOT NULL DEFAULT 'candidate',
  created_by             ingest.actor_kind NOT NULL DEFAULT 'system',
  run_id                 BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  notes                  TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claims_one_target_chk CHECK (
    (artist_id IS NOT NULL)::int + (person_id IS NOT NULL)::int +
    (organization_id IS NOT NULL)::int + (album_id IS NOT NULL)::int +
    (track_id IS NOT NULL)::int + (artist_membership_id IS NOT NULL)::int +
    (person_organization_id IS NOT NULL)::int + (album_credit_id IS NOT NULL)::int +
    (track_credit_id IS NOT NULL)::int + (album_format_id IS NOT NULL)::int +
    (video_id IS NOT NULL)::int IN (0, 1)
  ),
  CONSTRAINT claims_kind_matches_target_chk CHECK (
    (artist_id              IS NULL OR entity_kind = 'artist') AND
    (person_id              IS NULL OR entity_kind = 'person') AND
    (organization_id        IS NULL OR entity_kind = 'organization') AND
    (album_id               IS NULL OR entity_kind = 'album') AND
    (track_id               IS NULL OR entity_kind = 'track') AND
    (artist_membership_id   IS NULL OR entity_kind = 'artist_membership') AND
    (person_organization_id IS NULL OR entity_kind = 'person_organization') AND
    (album_credit_id        IS NULL OR entity_kind = 'album_credit') AND
    (track_credit_id        IS NULL OR entity_kind = 'track_credit') AND
    (album_format_id        IS NULL OR entity_kind = 'album_format') AND
    (video_id               IS NULL OR entity_kind = 'youtube_video')
  )
);

-- Dedupe de claims (idempotencia). COALESCE normaliza NULLs para que la
-- unicidad también aplique a claims de seed (raw_page_id NULL) y propuestas
-- (todas las FKs NULL). Limitación documentada: dos propuestas distintas del
-- mismo source+página+campo+valor crudo idéntico colisionan; el pipeline lo
-- evita incluyendo contexto en raw_value.
CREATE UNIQUE INDEX IF NOT EXISTS claims_dedupe_uk ON ingest.claims (
  source_id,
  COALESCE(raw_page_id, 0),
  COALESCE(seed_upload_id, 0),
  entity_kind,
  (COALESCE(artist_id, person_id, organization_id, album_id, track_id,
            artist_membership_id, person_organization_id, album_credit_id,
            track_credit_id, album_format_id, video_id, 0)),
  field,
  raw_hash
);

CREATE INDEX IF NOT EXISTS claims_status_idx        ON ingest.claims (entity_kind, field, status);
CREATE INDEX IF NOT EXISTS claims_artist_idx        ON ingest.claims (artist_id)        WHERE artist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_person_idx        ON ingest.claims (person_id)        WHERE person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_organization_idx  ON ingest.claims (organization_id)  WHERE organization_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_album_idx         ON ingest.claims (album_id)         WHERE album_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_track_idx         ON ingest.claims (track_id)         WHERE track_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS claims_video_idx         ON ingest.claims (video_id)         WHERE video_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- claim_evidence: dónde exactamente se vio el claim (fragmento, selector,
-- posición, hash). Un claim puede tener N evidencias.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.claim_evidence (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_id       BIGINT NOT NULL REFERENCES ingest.claims(id) ON DELETE CASCADE,
  raw_page_id    BIGINT REFERENCES ingest.raw_pages(id)    ON DELETE SET NULL,
  seed_upload_id BIGINT REFERENCES ingest.seed_uploads(id) ON DELETE SET NULL,
  url            TEXT,
  excerpt        TEXT,
  selector       VARCHAR(300),
  position       INTEGER,
  evidence_hash  VARCHAR(64) NOT NULL CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  captured_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT claim_evidence_dedupe_uk UNIQUE (claim_id, evidence_hash)
);

CREATE INDEX IF NOT EXISTS claim_evidence_claim_idx ON ingest.claim_evidence (claim_id);

-- ---------------------------------------------------------------------------
-- Tablas de aliases (identidad). Una por entidad core, con FK real.
-- Cubren: variantes ortográficas, nombres anteriores, nombres artísticos,
-- siglas y títulos alternativos, siempre con alias normalizado, confianza
-- y evidencia de origen (source_id / raw_page_id / claim_id).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.artist_aliases (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artist_id         BIGINT NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,
  alias             VARCHAR(200) NOT NULL,
  alias_type        ingest.alias_type NOT NULL DEFAULT 'name_variant',
  normalized_alias  VARCHAR(200) NOT NULL,
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  confidence        ingest.confidence_level NOT NULL DEFAULT 'medium',
  source_id         BIGINT REFERENCES ingest.sources(id)   ON DELETE SET NULL,
  raw_page_id       BIGINT REFERENCES ingest.raw_pages(id) ON DELETE SET NULL,
  claim_id          BIGINT REFERENCES ingest.claims(id)    ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT artist_aliases_alias_uk UNIQUE (artist_id, alias)
);
CREATE UNIQUE INDEX IF NOT EXISTS artist_aliases_one_primary_uk ON ingest.artist_aliases (artist_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS artist_aliases_norm_idx ON ingest.artist_aliases (normalized_alias);

CREATE TABLE IF NOT EXISTS ingest.person_aliases (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  person_id         BIGINT NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  alias             VARCHAR(200) NOT NULL,
  alias_type        ingest.alias_type NOT NULL DEFAULT 'name_variant',
  normalized_alias  VARCHAR(200) NOT NULL,
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  confidence        ingest.confidence_level NOT NULL DEFAULT 'medium',
  source_id         BIGINT REFERENCES ingest.sources(id)   ON DELETE SET NULL,
  raw_page_id       BIGINT REFERENCES ingest.raw_pages(id) ON DELETE SET NULL,
  claim_id          BIGINT REFERENCES ingest.claims(id)    ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT person_aliases_alias_uk UNIQUE (person_id, alias)
);
CREATE UNIQUE INDEX IF NOT EXISTS person_aliases_one_primary_uk ON ingest.person_aliases (person_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS person_aliases_norm_idx ON ingest.person_aliases (normalized_alias);

CREATE TABLE IF NOT EXISTS ingest.organization_aliases (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organization_id   BIGINT NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  alias             VARCHAR(200) NOT NULL,
  alias_type        ingest.alias_type NOT NULL DEFAULT 'name_variant',
  normalized_alias  VARCHAR(200) NOT NULL,
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  confidence        ingest.confidence_level NOT NULL DEFAULT 'medium',
  source_id         BIGINT REFERENCES ingest.sources(id)   ON DELETE SET NULL,
  raw_page_id       BIGINT REFERENCES ingest.raw_pages(id) ON DELETE SET NULL,
  claim_id          BIGINT REFERENCES ingest.claims(id)    ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT organization_aliases_alias_uk UNIQUE (organization_id, alias)
);
CREATE UNIQUE INDEX IF NOT EXISTS organization_aliases_one_primary_uk ON ingest.organization_aliases (organization_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS organization_aliases_norm_idx ON ingest.organization_aliases (normalized_alias);

CREATE TABLE IF NOT EXISTS ingest.album_aliases (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  album_id          BIGINT NOT NULL REFERENCES public.albums(id) ON DELETE CASCADE,
  alias             VARCHAR(250) NOT NULL,
  alias_type        ingest.alias_type NOT NULL DEFAULT 'name_variant',
  normalized_alias  VARCHAR(250) NOT NULL,
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  confidence        ingest.confidence_level NOT NULL DEFAULT 'medium',
  source_id         BIGINT REFERENCES ingest.sources(id)   ON DELETE SET NULL,
  raw_page_id       BIGINT REFERENCES ingest.raw_pages(id) ON DELETE SET NULL,
  claim_id          BIGINT REFERENCES ingest.claims(id)    ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT album_aliases_alias_uk UNIQUE (album_id, alias)
);
CREATE UNIQUE INDEX IF NOT EXISTS album_aliases_one_primary_uk ON ingest.album_aliases (album_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS album_aliases_norm_idx ON ingest.album_aliases (normalized_alias);

CREATE TABLE IF NOT EXISTS ingest.track_aliases (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  track_id          BIGINT NOT NULL REFERENCES public.tracks(id) ON DELETE CASCADE,
  alias             VARCHAR(250) NOT NULL,
  alias_type        ingest.alias_type NOT NULL DEFAULT 'name_variant',
  normalized_alias  VARCHAR(250) NOT NULL,
  is_primary        BOOLEAN NOT NULL DEFAULT false,
  confidence        ingest.confidence_level NOT NULL DEFAULT 'medium',
  source_id         BIGINT REFERENCES ingest.sources(id)   ON DELETE SET NULL,
  raw_page_id       BIGINT REFERENCES ingest.raw_pages(id) ON DELETE SET NULL,
  claim_id          BIGINT REFERENCES ingest.claims(id)    ON DELETE SET NULL,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT track_aliases_alias_uk UNIQUE (track_id, alias)
);
CREATE UNIQUE INDEX IF NOT EXISTS track_aliases_one_primary_uk ON ingest.track_aliases (track_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS track_aliases_norm_idx ON ingest.track_aliases (normalized_alias);

-- ---------------------------------------------------------------------------
-- conflicts: desacuerdos entre fuentes. AMBAS afirmaciones y sus evidencias
-- se conservan (value_a / value_b son snapshots). Mientras un conflicto esté
-- open, el campo canónico afectado no se modifica (regla del contrato).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.conflicts (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  claim_a_id       BIGINT NOT NULL REFERENCES ingest.claims(id) ON DELETE CASCADE,
  claim_b_id       BIGINT NOT NULL REFERENCES ingest.claims(id) ON DELETE CASCADE,
  entity_kind      ingest.claim_entity_kind NOT NULL,
  field            VARCHAR(80) NOT NULL,
  value_a          JSONB NOT NULL,
  value_b          JSONB NOT NULL,
  status           ingest.conflict_status NOT NULL DEFAULT 'open',
  resolution_note  TEXT,
  resolved_by      ingest.actor_kind,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  CONSTRAINT conflicts_distinct_chk CHECK (claim_a_id <> claim_b_id),
  CONSTRAINT conflicts_pair_field_uk UNIQUE (claim_a_id, claim_b_id, field)
);

CREATE INDEX IF NOT EXISTS conflicts_status_idx ON ingest.conflicts (entity_kind, field, status);

-- ---------------------------------------------------------------------------
-- review_queue: cola de revisión humana. Los kinds llenan columnas FK
-- distintas (documentado en docs/db/ER_INGEST_MEDIA.md §review_queue):
--   possible_duplicate → artist_a_id/artist_b_id (o person_a/b, organization_a/b)
--   field_conflict     → conflict_id (+ claim_a/claim_b)
--   ambiguous_alias    → claim_a_id (propuesta) + candidatos en payload
--   album_match        → claim_a_id + album_id
--   person_match       → claim_a_id + person_id
--   organization_match → claim_a_id + organization_id
--   youtube_match      → claim_a_id + video_id (+ album_id opcional)
--   manual_review      → claim_a_id o nada; detalles en payload
-- payload JSONB solo para extras específicos del kind (justificado).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.review_queue (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind             ingest.review_kind NOT NULL,
  status           ingest.review_status NOT NULL DEFAULT 'open',
  priority         SMALLINT NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  claim_a_id       BIGINT REFERENCES ingest.claims(id)       ON DELETE SET NULL,
  claim_b_id       BIGINT REFERENCES ingest.claims(id)       ON DELETE SET NULL,
  conflict_id      BIGINT REFERENCES ingest.conflicts(id)    ON DELETE SET NULL,
  artist_a_id      BIGINT REFERENCES public.artists(id)      ON DELETE SET NULL,
  artist_b_id      BIGINT REFERENCES public.artists(id)      ON DELETE SET NULL,
  person_a_id      BIGINT REFERENCES public.persons(id)      ON DELETE SET NULL,
  person_b_id      BIGINT REFERENCES public.persons(id)      ON DELETE SET NULL,
  organization_a_id BIGINT REFERENCES public.organizations(id) ON DELETE SET NULL,
  organization_b_id BIGINT REFERENCES public.organizations(id) ON DELETE SET NULL,
  album_id         BIGINT REFERENCES public.albums(id)       ON DELETE SET NULL,
  track_id         BIGINT REFERENCES public.tracks(id)       ON DELETE SET NULL,
  video_id         BIGINT REFERENCES media.youtube_videos(id) ON DELETE SET NULL,
  payload          JSONB,
  notes            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at      TIMESTAMPTZ,
  resolved_by      ingest.actor_kind,
  resolution_note  TEXT,
  CONSTRAINT review_queue_distinct_claims_chk
    CHECK (claim_a_id IS NULL OR claim_b_id IS NULL OR claim_a_id <> claim_b_id),
  CONSTRAINT review_queue_distinct_artists_chk
    CHECK (artist_a_id IS NULL OR artist_b_id IS NULL OR artist_a_id <> artist_b_id),
  CONSTRAINT review_queue_distinct_persons_chk
    CHECK (person_a_id IS NULL OR person_b_id IS NULL OR person_a_id <> person_b_id),
  CONSTRAINT review_queue_distinct_orgs_chk
    CHECK (organization_a_id IS NULL OR organization_b_id IS NULL OR organization_a_id <> organization_b_id)
);

CREATE INDEX IF NOT EXISTS review_queue_work_idx   ON ingest.review_queue (status, priority, created_at) WHERE status IN ('open','in_progress');
CREATE INDEX IF NOT EXISTS review_queue_kind_idx   ON ingest.review_queue (kind, status);

-- ---------------------------------------------------------------------------
-- merge_audit: registro de TODA modificación automática del pipeline sobre
-- el core: qué cambió, valor anterior, valor nuevo, razón, confianza,
-- fuentes (vía merge_audit_claims) y el run que la ejecutó.
-- Append-only: las filas no se modifican ni borran por el pipeline.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS ingest.merge_audit (
  id                     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id                 BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  entity_kind            ingest.claim_entity_kind NOT NULL
                         CHECK (entity_kind IN ('artist','person','organization','album','track',
                                                'artist_membership','person_organization',
                                                'album_credit','track_credit','album_format')),
  artist_id              BIGINT REFERENCES public.artists(id)             ON DELETE CASCADE,
  person_id              BIGINT REFERENCES public.persons(id)             ON DELETE CASCADE,
  organization_id        BIGINT REFERENCES public.organizations(id)       ON DELETE CASCADE,
  album_id               BIGINT REFERENCES public.albums(id)              ON DELETE CASCADE,
  track_id               BIGINT REFERENCES public.tracks(id)              ON DELETE CASCADE,
  artist_membership_id   BIGINT REFERENCES public.artist_members(id)      ON DELETE CASCADE,
  person_organization_id BIGINT REFERENCES public.person_organizations(id) ON DELETE CASCADE,
  album_credit_id        BIGINT REFERENCES public.album_credits(id)       ON DELETE CASCADE,
  track_credit_id        BIGINT REFERENCES public.track_credits(id)       ON DELETE CASCADE,
  album_format_id        BIGINT REFERENCES public.album_formats(id)       ON DELETE CASCADE,
  field                  VARCHAR(80) NOT NULL,
  old_value              JSONB,          -- NULL = inserción
  new_value              JSONB,          -- NULL = borrado
  reason                 TEXT NOT NULL,
  confidence             ingest.confidence_level NOT NULL,
  performed_by           ingest.actor_kind NOT NULL DEFAULT 'system',
  at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT merge_audit_one_target_chk CHECK (
    (artist_id IS NOT NULL)::int + (person_id IS NOT NULL)::int +
    (organization_id IS NOT NULL)::int + (album_id IS NOT NULL)::int +
    (track_id IS NOT NULL)::int + (artist_membership_id IS NOT NULL)::int +
    (person_organization_id IS NOT NULL)::int + (album_credit_id IS NOT NULL)::int +
    (track_credit_id IS NOT NULL)::int + (album_format_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT merge_audit_kind_matches_target_chk CHECK (
    (artist_id              IS NULL OR entity_kind = 'artist') AND
    (person_id              IS NULL OR entity_kind = 'person') AND
    (organization_id        IS NULL OR entity_kind = 'organization') AND
    (album_id               IS NULL OR entity_kind = 'album') AND
    (track_id               IS NULL OR entity_kind = 'track') AND
    (artist_membership_id   IS NULL OR entity_kind = 'artist_membership') AND
    (person_organization_id IS NULL OR entity_kind = 'person_organization') AND
    (album_credit_id        IS NULL OR entity_kind = 'album_credit') AND
    (track_credit_id        IS NULL OR entity_kind = 'track_credit') AND
    (album_format_id        IS NULL OR entity_kind = 'album_format')
  ),
  CONSTRAINT merge_audit_changed_chk CHECK (old_value IS DISTINCT FROM new_value)
);

CREATE INDEX IF NOT EXISTS merge_audit_entity_idx ON ingest.merge_audit (entity_kind, field, at DESC);
CREATE INDEX IF NOT EXISTS merge_audit_artist_idx ON ingest.merge_audit (artist_id) WHERE artist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS merge_audit_album_idx  ON ingest.merge_audit (album_id)  WHERE album_id IS NOT NULL;

-- Fuentes de una modificación (N claims por entrada de auditoría).
CREATE TABLE IF NOT EXISTS ingest.merge_audit_claims (
  merge_audit_id BIGINT NOT NULL REFERENCES ingest.merge_audit(id) ON DELETE CASCADE,
  claim_id       BIGINT NOT NULL REFERENCES ingest.claims(id)      ON DELETE RESTRICT,
  CONSTRAINT merge_audit_claims_pk PRIMARY KEY (merge_audit_id, claim_id)
);

CREATE INDEX IF NOT EXISTS merge_audit_claims_claim_idx ON ingest.merge_audit_claims (claim_id);

-- ---------------------------------------------------------------------------
-- Enlace de procedencia claim_id en las tablas de media (0002) — permite
-- rastrear qué claim produjo cada relación video<->entidad.
-- ---------------------------------------------------------------------------

ALTER TABLE media.video_artists
  ADD COLUMN IF NOT EXISTS claim_id BIGINT REFERENCES ingest.claims(id) ON DELETE SET NULL;

ALTER TABLE media.video_albums
  ADD COLUMN IF NOT EXISTS claim_id BIGINT REFERENCES ingest.claims(id) ON DELETE SET NULL;

ALTER TABLE media.video_tracks
  ADD COLUMN IF NOT EXISTS claim_id BIGINT REFERENCES ingest.claims(id) ON DELETE SET NULL;

COMMIT;
