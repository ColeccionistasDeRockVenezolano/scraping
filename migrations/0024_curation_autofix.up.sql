-- ============================================================================
-- CRV · Migración 0024_curation_autofix (UP)
-- Autocorrección segura de Curaduría (PLAN_CURADURIA E10, §2.2).
--
-- POR QUÉ: la autocorrección escribe en el core SIN intervención humana. Solo
--   puede hacerlo lo que una persona autorizó antes, caso por caso, y todo
--   queda registrado:
--   * `curation_autofix_rules`: la lista blanca. Una regla = un detector, un
--     subgrupo (NULL = todos) y UNA acción, con su tope por análisis. Nace
--     apagada; encenderla es una decisión de un administrador. Solo se aplican
--     acciones de nivel 0 (deterministas y reversibles): el nivel lo comprueba
--     el marco de acciones al previsualizar, no esta tabla.
--   * `disabled_*`: el interruptor de emergencia. Si la verificación dirigida
--     de un lote automático encuentra hallazgos DESENCADENADOS —la corrección
--     abrió problemas nuevos—, el lote se deshace y la regla queda apagada con
--     el motivo y el lote culpable. Nadie la vuelve a encender por accidente.
--   * `curation_autofix_events`: la auditoría. Quién creó, cambió, encendió o
--     apagó cada regla y por qué, más lo que hizo el sistema solo. El detector
--     y la acción se copian en el evento para que sobreviva al borrado de la
--     regla.
--
-- Sin FK al core a propósito: `ingest` no le añade dependencias a `public`.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente y
-- reversible.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.curation_autofix_rules (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  detector VARCHAR(80) NOT NULL,
  -- NULL = todos los subgrupos de ese detector.
  signature TEXT,
  action_key VARCHAR(60) NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT false,
  -- Tope propio de la regla; NULL = el del entorno (CRV_CURATION_AUTOFIX_MAX_PER_SCAN).
  max_per_scan INTEGER
    CONSTRAINT curation_autofix_rules_max_chk CHECK (max_per_scan IS NULL OR max_per_scan > 0),
  note TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT,
  updated_at TIMESTAMPTZ,
  disabled_at TIMESTAMPTZ,
  disabled_reason TEXT,
  disabled_by_batch_id BIGINT REFERENCES ingest.curation_fix_batches(id) ON DELETE SET NULL,
  -- Una regla encendida no arrastra el motivo por el que estuvo apagada.
  CONSTRAINT curation_autofix_rules_disabled_chk
    CHECK (NOT enabled OR (disabled_at IS NULL AND disabled_reason IS NULL AND disabled_by_batch_id IS NULL))
);

-- El lote que apagó la regla: toda FK de `ingest` lleva índice por sus columnas
-- (regla de 0013), para que borrar un lote no recorra la tabla entera. Parcial
-- porque casi ninguna regla se apaga sola.
CREATE INDEX IF NOT EXISTS curation_autofix_rules_batch_idx
  ON ingest.curation_autofix_rules (disabled_by_batch_id) WHERE disabled_by_batch_id IS NOT NULL;

-- Una sola regla por detector + subgrupo + acción («*» representa el detector entero).
CREATE UNIQUE INDEX IF NOT EXISTS curation_autofix_rules_uk
  ON ingest.curation_autofix_rules (detector, coalesce(signature, '*'), action_key);

COMMENT ON TABLE ingest.curation_autofix_rules IS
  'Lista blanca de la autocorrección de Curaduría: qué acción de nivel 0 puede aplicarse sola sobre qué detector y subgrupo. Nace apagada; el interruptor de emergencia la apaga si un lote automático desencadena problemas.';

CREATE TABLE IF NOT EXISTS ingest.curation_autofix_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  rule_id BIGINT REFERENCES ingest.curation_autofix_rules(id) ON DELETE SET NULL,
  -- Copiados: el evento sobrevive al borrado de la regla.
  detector VARCHAR(80) NOT NULL,
  signature TEXT,
  action_key VARCHAR(60) NOT NULL,
  event VARCHAR(20) NOT NULL
    CONSTRAINT curation_autofix_events_event_chk
    CHECK (event IN ('created', 'updated', 'enabled', 'disabled', 'deleted', 'auto_disabled', 'applied', 'undone')),
  operator TEXT NOT NULL,
  note TEXT,
  batch_id BIGINT REFERENCES ingest.curation_fix_batches(id) ON DELETE SET NULL,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS curation_autofix_events_at_idx ON ingest.curation_autofix_events (at DESC);
CREATE INDEX IF NOT EXISTS curation_autofix_events_rule_idx ON ingest.curation_autofix_events (rule_id) WHERE rule_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS curation_autofix_events_batch_idx ON ingest.curation_autofix_events (batch_id) WHERE batch_id IS NOT NULL;

COMMENT ON TABLE ingest.curation_autofix_events IS
  'Auditoría de la autocorrección: alta, cambio, encendido y apagado de cada regla (quién y por qué), y lo que hizo el sistema solo (aplicado, apagado de emergencia, deshecho).';

COMMIT;
