-- ============================================================================
-- CRV · Migración 0022_er_decisions_retention (UP)
-- Retención de las decisiones de resolución de entidades (auditoría BD #1).
--
-- POR QUÉ:
--   * `ingest.entity_resolution_decisions` guarda, por cada resolución, el
--     dossier COMPLETO de candidatas que evaluó el ER. Con el catálogo crecido
--     (10k personas, 27k pistas) cada decisión evalúa miles de candidatas: las
--     últimas 1.000 filas medían 461 kB promedio (2026-09-18) y la tabla llegó
--     a 19 GB, 18 de ellos TOAST.
--   * Nada del código lee el dossier completo: los consumidores usan
--     `candidates->0` (mesa de cotejo, operator-review, dossiers de ambigüedad)
--     y `input_context` (aplicar decisiones pendientes de la Mesa). El resto es
--     valor forense, útil solo reciente.
--   * `src/er/retention.ts` compacta por edad: conserva las 20 mejores
--     candidatas {candidateId, canonicalName, score, action} y el conteo
--     original; la decisión (acción, score, features, explanation, decided_by)
--     y el `input_context` quedan intactos. Una decisión JAMÁS se borra.
--
-- QUÉ CREA:
--   * `compacted_at`: cuándo se compactó la fila (NULL = dossier intacto).
--   * `candidates_count`: cuántas candidatas evaluó (se conserva al compactar
--     porque el dossier ya no las lista todas).
--   * índice parcial `er_decisions_pending_compaction_idx` sobre `created_at`
--     limitado a las filas sin compactar: el barrido de pendientes cuesta lo
--     que queda por trabajar, no la tabla entera, y se encoge a medida que la
--     retención avanza.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente.
-- ============================================================================

ALTER TABLE ingest.entity_resolution_decisions
  ADD COLUMN IF NOT EXISTS compacted_at timestamp with time zone;
ALTER TABLE ingest.entity_resolution_decisions
  ADD COLUMN IF NOT EXISTS candidates_count integer;

COMMENT ON COLUMN ingest.entity_resolution_decisions.compacted_at IS
  'Momento en que la retención compactó el dossier de candidatas (NULL = dossier completo intacto).';
COMMENT ON COLUMN ingest.entity_resolution_decisions.candidates_count IS
  'Cuántas candidatas evaluó la decisión; se conserva al compactar porque el dossier ya no las lista todas.';

CREATE INDEX IF NOT EXISTS er_decisions_pending_compaction_idx
  ON ingest.entity_resolution_decisions (created_at)
  WHERE compacted_at IS NULL;
