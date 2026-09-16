-- ============================================================================
-- CRV · Migración 0014_entity_redirects (UP)
-- Redirecciones de ids fusionados (PHASES E11.2; plan E11, problema P5).
--
-- POR QUÉ: al fusionar dos fichas, el id que desaparece deja de existir y
--   `/personas/<id>` (o `/artistas/<id>`, …) pasaba a responder 404. Los
--   enlaces guardados, las exportaciones y la mesa de cotejo apuntaban a
--   nada. Esta tabla guarda «id borrado → id que quedó» para que la API
--   pueda responder 404 con `movedTo` y la web navegue a la ficha viva.
--
-- CÓMO: la escribe `mergeInto` (src/review/duplicates.ts) en la misma
--   transacción de la fusión, tras insertar la auditoría. Se comprime al
--   fusionar en cadena: si A→B y luego B→C, la fila A pasa a A→C.
--
-- DECISIONES:
--   * `from_id` NO tiene FK a propósito: apunta a una fila que ya no existe
--     (el duplicado borrado); una FK lo haría imposible.
--   * `to_id` se valida en código (la fila destino existe en la misma
--     transacción) y `merge_audit_id`/`run_id` enlazan el rastro para poder
--     auditar —o deshacer— la redirección.
--   * `entity_kind` reutiliza `ingest.claim_entity_kind` (el mismo dominio de
--     entidades que claims y merge_audit) y el CHECK lo acota a los cinco
--     tipos que tienen página propia y fusión de identidad.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente y
--   reversible (0014_entity_redirects.down.sql).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.entity_redirects (
  entity_kind    ingest.claim_entity_kind NOT NULL,
  from_id        BIGINT NOT NULL,          -- id borrado: sin FK a propósito
  to_id          BIGINT NOT NULL,          -- id vivo (se valida en código)
  merge_audit_id BIGINT REFERENCES ingest.merge_audit(id) ON DELETE SET NULL,
  run_id         BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_kind, from_id),
  CONSTRAINT entity_redirects_not_self_chk CHECK (from_id <> to_id),
  CONSTRAINT entity_redirects_kind_chk CHECK (entity_kind IN ('artist','person','organization','album','track'))
);

-- Consulta de la compresión de la cadena (to_id = dropId) y de las
-- redirecciones que apuntan a una ficha viva.
CREATE INDEX IF NOT EXISTS entity_redirects_to_idx ON ingest.entity_redirects(entity_kind, to_id);
-- Las dos FKs con ON DELETE SET NULL: un borrado de auditoría o de run
-- (poco frecuente, pero posible al purgar) no debe recorrer la tabla.
CREATE INDEX IF NOT EXISTS entity_redirects_merge_audit_id_fk_idx ON ingest.entity_redirects(merge_audit_id) WHERE merge_audit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS entity_redirects_run_id_fk_idx ON ingest.entity_redirects(run_id) WHERE run_id IS NOT NULL;

COMMENT ON TABLE ingest.entity_redirects IS
  'Id fusionado → id que quedó. La escribe mergeInto en la transacción de la fusión; se comprime al fusionar en cadena.';

COMMIT;
