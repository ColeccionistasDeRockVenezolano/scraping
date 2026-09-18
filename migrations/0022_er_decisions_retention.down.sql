-- ============================================================================
-- CRV · Migración 0022_er_decisions_retention (DOWN)
-- Revierte la retención de decisiones de resolución.
--
-- Reversible sin pérdida: `compacted_at` y `candidates_count` son metadatos de
-- mantenimiento y el índice parcial es derivable. OJO: las filas ya
-- compactadas NO recuperan su dossier completo (esa información se descartó a
-- propósito); el down no la puede reconstruir.
-- ============================================================================

DROP INDEX IF EXISTS ingest.er_decisions_pending_compaction_idx;

ALTER TABLE ingest.entity_resolution_decisions
  DROP COLUMN IF EXISTS candidates_count;
ALTER TABLE ingest.entity_resolution_decisions
  DROP COLUMN IF EXISTS compacted_at;
