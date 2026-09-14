-- ============================================================================
-- CRV · Migración 0012_ambiguity_resolutions (UP)
-- Decisiones explicables sobre los casos ambiguos de la cola (PHASES.md E10;
-- plan de implementación, FASE 10B).
--
-- QUÉ GUARDA: una fila por pregunta de una revisión (¿son el mismo disco?,
--   ¿qué pista es este videoclip?, ¿esta entrada del tracklist es una pista?),
--   con la decisión MATCH_HIGH_CONFIDENCE / KEEP_SEPARATE / NEEDS_HUMAN /
--   CONFLICT, la regla que la tomó, los hechos verificables que se miraron y
--   la evidencia que cita esos hechos.
--
-- POR QUÉ NO BASTA review_queue: una decisión no es la aplicación. El
--   resolutor decide; nada llega al core hasta que una persona ejecuta
--   `crv ambiguity:apply --confirm`, y lo aplicado queda marcado aquí.
--
-- INVARIANTES EN EL DDL (no solo en el código):
--   * Ninguna resolución distinta de NEEDS_HUMAN sin evidencia.
--   * Solo MATCH_HIGH_CONFIDENCE lleva algo que aplicar.
--   * Una decisión de IA nombra a su árbitro.
--   * Solo se aplica MATCH_HIGH_CONFIDENCE o KEEP_SEPARATE.
--   * Una sola decisión viva por pregunta; las anteriores quedan `superseded`.
--
-- REGLAS DE GOBIERNO: el schema `public` NO se toca. Idempotente y reversible.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.ambiguity_resolutions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_id BIGINT NOT NULL REFERENCES ingest.review_queue(id) ON DELETE CASCADE,
  question_key VARCHAR(80) NOT NULL CHECK (btrim(question_key) <> ''),
  question TEXT NOT NULL CHECK (btrim(question) <> ''),
  -- sha256 del dosier (hechos, opciones y versión de las reglas): la misma
  -- evidencia produce la misma fila y una evidencia nueva, una fila nueva.
  dossier_hash VARCHAR(64) NOT NULL CHECK (dossier_hash ~ '^[0-9a-f]{64}$'),
  decision VARCHAR(24) NOT NULL CHECK (decision IN ('MATCH_HIGH_CONFIDENCE','KEEP_SEPARATE','NEEDS_HUMAN','CONFLICT')),
  deterministic_decision VARCHAR(24) NOT NULL CHECK (deterministic_decision IN ('MATCH_HIGH_CONFIDENCE','KEEP_SEPARATE','NEEDS_HUMAN','CONFLICT')),
  decided_by VARCHAR(16) NOT NULL CHECK (decided_by IN ('deterministic','ai')),
  rule VARCHAR(80) NOT NULL CHECK (btrim(rule) <> ''),
  reasoning TEXT NOT NULL CHECK (btrim(reasoning) <> ''),
  facts JSONB NOT NULL CHECK (jsonb_typeof(facts) = 'array'),
  evidence JSONB NOT NULL CHECK (jsonb_typeof(evidence) = 'array'),
  options JSONB NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(options) = 'array'),
  target JSONB CHECK (target IS NULL OR jsonb_typeof(target) = 'object'),
  arbiter TEXT,
  ai_proposal JSONB,
  ai_run_id BIGINT REFERENCES ingest.ai_runs(id) ON DELETE SET NULL,
  ai_failure TEXT,
  run_id BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  status VARCHAR(12) NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed','applied','superseded')),
  applied_at TIMESTAMPTZ,
  applied_run_id BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  applied_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ambiguity_resolutions_evidence_chk CHECK (decision = 'NEEDS_HUMAN' OR jsonb_array_length(evidence) > 0),
  CONSTRAINT ambiguity_resolutions_target_chk CHECK (target IS NULL OR decision = 'MATCH_HIGH_CONFIDENCE'),
  CONSTRAINT ambiguity_resolutions_match_target_chk CHECK (decision <> 'MATCH_HIGH_CONFIDENCE' OR target IS NOT NULL),
  CONSTRAINT ambiguity_resolutions_arbiter_chk CHECK (decided_by = 'deterministic' OR arbiter IS NOT NULL),
  CONSTRAINT ambiguity_resolutions_applied_chk CHECK ((status = 'applied') = (applied_at IS NOT NULL)),
  CONSTRAINT ambiguity_resolutions_applicable_chk CHECK (status <> 'applied' OR decision IN ('MATCH_HIGH_CONFIDENCE','KEEP_SEPARATE'))
);

CREATE UNIQUE INDEX IF NOT EXISTS ambiguity_resolutions_live_uk
  ON ingest.ambiguity_resolutions(review_id, question_key)
  WHERE status IN ('proposed','applied');
CREATE INDEX IF NOT EXISTS ambiguity_resolutions_review_idx ON ingest.ambiguity_resolutions(review_id);
CREATE INDEX IF NOT EXISTS ambiguity_resolutions_pending_idx
  ON ingest.ambiguity_resolutions(decision, created_at DESC) WHERE status = 'proposed';

COMMIT;
