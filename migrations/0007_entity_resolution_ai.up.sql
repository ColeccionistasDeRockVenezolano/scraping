-- CRV · 0007_entity_resolution_ai
-- Auditoria explicable de ER + gateway DeepSeek + biografias editoriales.
-- Solo toca ingest; el core public permanece inmutable.
BEGIN;

-- Conserva la identidad recibida aun cuando el valor del claim sea otro
-- campo (origen, ano, rol...). Las claves son derivadas, nunca sustituyen raw.
ALTER TABLE ingest.claims
  ADD COLUMN IF NOT EXISTS identity_raw TEXT,
  ADD COLUMN IF NOT EXISTS identity_key TEXT,
  ADD COLUMN IF NOT EXISTS identity_secondary_key TEXT;

CREATE TABLE IF NOT EXISTS ingest.ai_runs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  prompt_hash VARCHAR(64) NOT NULL UNIQUE CHECK (prompt_hash ~ '^[0-9a-f]{64}$'),
  task_kind VARCHAR(40) NOT NULL CHECK (task_kind IN (
    'cheap_classification', 'narrative_extraction', 'semantic_normalization',
    'hard_entity_resolution', 'conflict_arbitration',
    'historical_interpretation', 'biography', 'vision_analysis'
  )),
  model TEXT NOT NULL,
  schema_version VARCHAR(30) NOT NULL,
  status VARCHAR(12) NOT NULL CHECK (status IN ('validated', 'rejected', 'failed')),
  input_summary JSONB NOT NULL,
  output_summary JSONB,
  request_payload JSONB NOT NULL,
  response_payload JSONB,
  raw_response TEXT,
  tokens_in INTEGER CHECK (tokens_in IS NULL OR tokens_in >= 0),
  tokens_out INTEGER CHECK (tokens_out IS NULL OR tokens_out >= 0),
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ai_runs_task_created_idx
  ON ingest.ai_runs(task_kind, created_at DESC);

CREATE TABLE IF NOT EXISTS ingest.entity_resolution_decisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  decision_hash VARCHAR(64) NOT NULL UNIQUE CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
  run_id BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  claim_id BIGINT REFERENCES ingest.claims(id) ON DELETE SET NULL,
  ai_run_id BIGINT REFERENCES ingest.ai_runs(id) ON DELETE SET NULL,
  entity_kind VARCHAR(20) NOT NULL CHECK (entity_kind IN ('ARTIST','PERSON','ALBUM','TRACK','ORGANIZATION')),
  artist_id BIGINT REFERENCES public.artists(id) ON DELETE SET NULL,
  person_id BIGINT REFERENCES public.persons(id) ON DELETE SET NULL,
  album_id BIGINT REFERENCES public.albums(id) ON DELETE SET NULL,
  track_id BIGINT REFERENCES public.tracks(id) ON DELETE SET NULL,
  organization_id BIGINT REFERENCES public.organizations(id) ON DELETE SET NULL,
  input_name_original TEXT NOT NULL,
  input_name_normalized TEXT NOT NULL,
  input_context JSONB NOT NULL,
  score REAL NOT NULL CHECK (score >= 0 AND score <= 1),
  action VARCHAR(20) NOT NULL CHECK (action IN ('AUTO_MATCH','POSSIBLE_MATCH','REVIEW','NO_MATCH')),
  features JSONB NOT NULL CHECK (jsonb_typeof(features) = 'array'),
  candidates JSONB NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
  thresholds JSONB NOT NULL CHECK (jsonb_typeof(thresholds) = 'object'),
  explanation TEXT NOT NULL,
  decided_by VARCHAR(20) NOT NULL CHECK (decided_by IN ('deterministic','deepseek','human')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT er_decisions_one_target_chk CHECK (
    (artist_id IS NOT NULL)::int + (person_id IS NOT NULL)::int +
    (album_id IS NOT NULL)::int + (track_id IS NOT NULL)::int +
    (organization_id IS NOT NULL)::int IN (0, 1)
  ),
  CONSTRAINT er_decisions_kind_matches_target_chk CHECK (
    (artist_id IS NULL OR entity_kind='ARTIST') AND
    (person_id IS NULL OR entity_kind='PERSON') AND
    (album_id IS NULL OR entity_kind='ALBUM') AND
    (track_id IS NULL OR entity_kind='TRACK') AND
    (organization_id IS NULL OR entity_kind='ORGANIZATION')
  )
);

CREATE INDEX IF NOT EXISTS er_decisions_input_idx
  ON ingest.entity_resolution_decisions(entity_kind, input_name_normalized, created_at DESC);
CREATE INDEX IF NOT EXISTS er_decisions_action_idx
  ON ingest.entity_resolution_decisions(action, created_at DESC);

CREATE TABLE IF NOT EXISTS ingest.ai_biographies (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_kind VARCHAR(12) NOT NULL CHECK (entity_kind IN ('ARTIST','PERSON')),
  artist_id BIGINT REFERENCES public.artists(id) ON DELETE CASCADE,
  person_id BIGINT REFERENCES public.persons(id) ON DELETE CASCADE,
  ai_run_id BIGINT NOT NULL REFERENCES ingest.ai_runs(id) ON DELETE RESTRICT,
  body TEXT NOT NULL CHECK (length(btrim(body)) > 0),
  facts_snapshot JSONB NOT NULL CHECK (jsonb_typeof(facts_snapshot) = 'array'),
  model TEXT NOT NULL,
  prompt_version VARCHAR(30) NOT NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','rejected')),
  review_queue_id BIGINT REFERENCES ingest.review_queue(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ai_biographies_one_target_chk CHECK (
    (artist_id IS NOT NULL)::int + (person_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT ai_biographies_kind_matches_target_chk CHECK (
    (artist_id IS NULL OR entity_kind='ARTIST') AND
    (person_id IS NULL OR entity_kind='PERSON')
  ),
  CONSTRAINT ai_biographies_run_target_uk UNIQUE (ai_run_id, entity_kind, artist_id, person_id)
);

CREATE TABLE IF NOT EXISTS ingest.ai_biography_claims (
  biography_id BIGINT NOT NULL REFERENCES ingest.ai_biographies(id) ON DELETE CASCADE,
  claim_id BIGINT NOT NULL REFERENCES ingest.claims(id) ON DELETE RESTRICT,
  PRIMARY KEY (biography_id, claim_id)
);

CREATE INDEX IF NOT EXISTS ai_biography_claims_claim_idx
  ON ingest.ai_biography_claims(claim_id);

COMMIT;
