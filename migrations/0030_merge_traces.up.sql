-- ============================================================================
-- CRV · Migración 0030_merge_traces (UP)
-- Rastro reconstruido de las fusiones anteriores a E11.1 (2026-09-15), que
-- guardaban cuántas filas movieron pero no cuáles: sin ese dato no se pueden
-- deshacer. `ingest.merge_traces` guarda, por fila de `ingest.merge_audit`,
-- la clave primaria de cada fila que la fusión movió, de dónde salió el dato
-- (un respaldo anterior al run, o la propia auditoría) y si cuadra con lo que
-- la fusión registró. SOLO SE DESHACE LO VERIFICADO: `verified` en falso deja
-- la fusión como no reversible, diciendo por qué.
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.merge_traces (
  audit_id      bigint PRIMARY KEY REFERENCES ingest.merge_audit(id) ON DELETE CASCADE,
  run_id        bigint NOT NULL REFERENCES ingest.scrape_runs(id),
  -- [{ table, column, keys: [{ pk: valor }] }], igual que `movedRefs` de E11.1.
  moved_refs    jsonb  NOT NULL,
  -- backup: instantánea anterior al run; audit: historia de la auditoría.
  source        text   NOT NULL CHECK (source IN ('backup', 'audit')),
  -- Qué respaldo o qué consulta lo produjo (para poder repetirlo).
  source_label  text,
  -- Cuántas filas dijo la fusión que movió y cuántas se reconstruyeron.
  moved_expected int   NOT NULL,
  moved_found    int   NOT NULL,
  verified      boolean NOT NULL,
  reason        text,
  built_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS merge_traces_run_idx ON ingest.merge_traces (run_id, audit_id);

COMMIT;
