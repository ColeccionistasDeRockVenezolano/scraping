-- ============================================================================
-- CRV · Migración 0020_curation_durable_decisions (UP)
-- Decisiones duraderas de Curaduría (PLAN_CURADURIA E2: A5, M4).
--
-- POR QUÉ:
--   * `ignore_reason`: «no es un problema» dice por qué —falso positivo,
--     correcto a propósito o fuera de alcance—. Sin motivo no hay dato para
--     medir la precisión de cada detector. La API lo exige; la columna admite
--     NULL solo para lo ignorado antes de esta migración (no hay forma honesta
--     de reconstruir el motivo). Un ignorado cuyo problema desaparece ya no
--     queda ignorado para siempre: pasa a `resolved` y conserva quién lo
--     ignoró y por qué.
--   * `ingest.curation_distinct_pairs`: «son fichas distintas» para un par de
--     artistas, personas, organizaciones, discos o pistas. El detector de
--     duplicados no vuelve a proponer ese par aunque cambie el grupo. Sin FK
--     al core a propósito: si una ficha se retira o se fusiona, el par
--     declarado no estorba (los ids nunca se reutilizan) y el core no gana
--     dependencias hacia `ingest`.
--   * `declared_distinct`: el motivo con que se resuelve el hallazgo de un par
--     que una persona declaró distinto.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente y
-- reversible.
-- ============================================================================

BEGIN;

ALTER TABLE ingest.curation_findings ADD COLUMN IF NOT EXISTS ignore_reason VARCHAR(30);

ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_ignore_reason_chk;
ALTER TABLE ingest.curation_findings ADD CONSTRAINT curation_findings_ignore_reason_chk
  CHECK (ignore_reason IS NULL OR ignore_reason IN ('falso_positivo', 'correcto_a_proposito', 'fuera_de_alcance'));

COMMENT ON COLUMN ingest.curation_findings.ignore_reason IS
  'Por qué una persona dijo «no es un problema»: falso_positivo, correcto_a_proposito o fuera_de_alcance. NULL si nunca se ignoró o se ignoró antes de 0020. Se conserva si el hallazgo pasa a resolved.';

ALTER TABLE ingest.curation_findings DROP CONSTRAINT IF EXISTS curation_findings_resolution_chk;
ALTER TABLE ingest.curation_findings ADD CONSTRAINT curation_findings_resolution_chk
  CHECK (resolution IS NULL OR resolution IN ('fixed_by_curation', 'changed_elsewhere', 'entity_removed', 'rules_changed', 'declared_distinct'));

CREATE TABLE IF NOT EXISTS ingest.curation_distinct_pairs (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind VARCHAR(20) NOT NULL
    CONSTRAINT curation_distinct_pairs_kind_chk CHECK (kind IN ('artist', 'person', 'organization', 'album', 'track')),
  -- El par va ordenado: (a, b) y (b, a) son la misma decisión.
  a_id BIGINT NOT NULL,
  b_id BIGINT NOT NULL,
  decided_by TEXT NOT NULL,
  note TEXT NOT NULL
    CONSTRAINT curation_distinct_pairs_note_chk CHECK (btrim(note) <> ''),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curation_distinct_pairs_order_chk CHECK (a_id < b_id),
  CONSTRAINT curation_distinct_pairs_uk UNIQUE (kind, a_id, b_id)
);

COMMENT ON TABLE ingest.curation_distinct_pairs IS
  'Pares de fichas del mismo tipo que una persona declaró distintas: el detector de duplicados de Curaduría no los vuelve a proponer.';

COMMIT;
