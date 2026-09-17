-- ============================================================================
-- CRV · Migración 0021_curation_fix_batches (UP)
-- Marco de acciones de corrección de Curaduría (PLAN_CURADURIA E4: A1, A8, M6, M1).
--
-- POR QUÉ:
--   * `ingest.curation_fix_batches`: toda corrección desde Curaduría es un lote
--     —de uno, de una selección o de un grupo filtrado— con vista previa,
--     hash, nota, quién lo pidió, quién lo aplicó, recuentos y la verificación
--     dirigida posterior. Antes, `fix-group` creaba hasta 500 runs sueltos sin
--     nada que los agrupara y nada se podía deshacer (A8).
--   * `ingest.curation_fix_items`: un ítem por hallazgo, con la acción tipada,
--     sus parámetros, el antes/después de la vista previa, su hash (la vista
--     previa que la persona confirmó) y el run de escritura que lo aplicó.
--     Deshacer recorre los ítems aplicados en orden inverso; un deshacer es a
--     su vez un lote (`mode = 'undo'`) cuyos ítems apuntan al ítem que revierten.
--   * `curation_scans.scope`: `dirigido` es la verificación tras aplicar un
--     lote, que solo guarda lo que toca a las fichas del lote. No cuenta como
--     «último análisis» del catálogo ni como firma para el vigilante.
--
-- Estados de un ítem: pending (se aplicará) · blocked (la vista previa ya dice
-- que no se puede: no abierto, obsoleto, colisión…) · excluded (la persona lo
-- quitó al aplicar) · applied · skipped_stale (la ficha cambió desde la vista
-- previa) · failed · undone · not_undoable (el CAS inverso falló: algo cambió
-- después de la corrección y deshacerla pisaría ese cambio).
--
-- Sin FK al core a propósito (los ids de fichas viven en jsonb): el core no
-- gana dependencias hacia `ingest`. El hallazgo y el run se referencian con
-- ON DELETE SET NULL: la poda de hallazgos resueltos no borra la historia.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente y
-- reversible.
-- ============================================================================

BEGIN;

ALTER TABLE ingest.curation_scans ADD COLUMN IF NOT EXISTS scope VARCHAR(12) NOT NULL DEFAULT 'completo';
ALTER TABLE ingest.curation_scans DROP CONSTRAINT IF EXISTS curation_scans_scope_chk;
ALTER TABLE ingest.curation_scans ADD CONSTRAINT curation_scans_scope_chk CHECK (scope IN ('completo', 'dirigido'));

COMMENT ON COLUMN ingest.curation_scans.scope IS
  'completo: todo el catálogo. dirigido: verificación tras un lote de correcciones; solo guarda y resuelve lo que toca a las fichas del lote.';

CREATE TABLE IF NOT EXISTS ingest.curation_fix_batches (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  mode VARCHAR(12) NOT NULL
    CONSTRAINT curation_fix_batches_mode_chk CHECK (mode IN ('individual', 'selected', 'group', 'auto', 'undo')),
  -- Lo que se pidió: filtro exacto de grupo, ids elegidos o el lote que se deshace.
  filter JSONB NOT NULL DEFAULT '{}'::jsonb,
  action_key VARCHAR(60),
  requested_by TEXT NOT NULL,
  applied_by TEXT,
  note TEXT,
  preview_hash TEXT NOT NULL
    CONSTRAINT curation_fix_batches_hash_chk CHECK (preview_hash ~ '^[0-9a-f]{64}$'),
  status VARCHAR(12) NOT NULL DEFAULT 'previewed'
    CONSTRAINT curation_fix_batches_status_chk CHECK (status IN ('previewed', 'running', 'done', 'partial', 'failed', 'undone')),
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Resultado de la verificación dirigida: análisis, resueltos, nuevos y desencadenados.
  verification JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  undo_of_batch_id BIGINT REFERENCES ingest.curation_fix_batches(id) ON DELETE SET NULL,
  undone_by_batch_id BIGINT REFERENCES ingest.curation_fix_batches(id) ON DELETE SET NULL,
  -- Una vista previa no escribe nada; aplicar sí, y exige nota.
  CONSTRAINT curation_fix_batches_note_chk CHECK (status = 'previewed' OR (note IS NOT NULL AND btrim(note) <> '')),
  -- Solo un deshacer apunta al lote que revierte.
  CONSTRAINT curation_fix_batches_undo_chk CHECK (mode = 'undo' OR undo_of_batch_id IS NULL)
);

CREATE INDEX IF NOT EXISTS curation_fix_batches_created_idx ON ingest.curation_fix_batches (created_at DESC);
CREATE INDEX IF NOT EXISTS curation_fix_batches_undo_of_idx ON ingest.curation_fix_batches (undo_of_batch_id) WHERE undo_of_batch_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS curation_fix_batches_undone_by_idx ON ingest.curation_fix_batches (undone_by_batch_id) WHERE undone_by_batch_id IS NOT NULL;

COMMENT ON TABLE ingest.curation_fix_batches IS
  'Lotes de correcciones de Curaduría (individual, selección, grupo, automático o deshacer): vista previa con hash, nota, recuentos y verificación dirigida.';

CREATE TABLE IF NOT EXISTS ingest.curation_fix_items (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  batch_id BIGINT NOT NULL REFERENCES ingest.curation_fix_batches(id) ON DELETE CASCADE,
  -- Orden de aplicación; deshacer va al revés.
  position INTEGER NOT NULL CONSTRAINT curation_fix_items_position_chk CHECK (position >= 0),
  finding_id BIGINT REFERENCES ingest.curation_findings(id) ON DELETE SET NULL,
  action_key VARCHAR(60),
  level SMALLINT CONSTRAINT curation_fix_items_level_chk CHECK (level BETWEEN 0 AND 3),
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Fichas tocadas, colisiones, avisos, bloqueo y propuesta de la vista previa.
  preview JSONB NOT NULL DEFAULT '{}'::jsonb,
  preview_hash TEXT
    CONSTRAINT curation_fix_items_hash_chk CHECK (preview_hash IS NULL OR preview_hash ~ '^[0-9a-f]{64}$'),
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CONSTRAINT curation_fix_items_status_chk CHECK (status IN ('pending', 'blocked', 'excluded', 'applied', 'skipped_stale', 'failed', 'undone', 'not_undoable')),
  run_id BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  undo_of_item_id BIGINT REFERENCES ingest.curation_fix_items(id) ON DELETE SET NULL,
  -- Por qué no se aplicó o no se deshizo: código estable (stale, not_open, invalid…) y mensaje legible.
  error_code VARCHAR(40),
  error TEXT,
  before JSONB,
  after JSONB,
  applied_at TIMESTAMPTZ,
  CONSTRAINT curation_fix_items_position_uk UNIQUE (batch_id, position)
);

CREATE INDEX IF NOT EXISTS curation_fix_items_finding_idx ON ingest.curation_fix_items (finding_id) WHERE finding_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS curation_fix_items_run_idx ON ingest.curation_fix_items (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS curation_fix_items_undo_of_idx ON ingest.curation_fix_items (undo_of_item_id) WHERE undo_of_item_id IS NOT NULL;

COMMENT ON TABLE ingest.curation_fix_items IS
  'Un hallazgo dentro de un lote de correcciones: acción tipada, parámetros, antes/después, hash de la vista previa, estado y run que lo aplicó.';
COMMENT ON COLUMN ingest.curation_fix_items.preview_hash IS
  'sha256 de lo que la persona vio (hallazgo, acción, parámetros, antes, después, bloqueo). Al aplicar se recalcula dentro de la transacción del ítem: si difiere, el ítem queda skipped_stale.';

COMMIT;
