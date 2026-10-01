-- ============================================================================
-- CRV · Migración 0034_text_rewrites (UP)
-- Fusionar sin perder datos (Brian, 2026-10-01).
--
-- Hasta ahora, al fusionar dos fichas, el valor de la que desaparecía se
-- descartaba cuando contradecía al de la que queda: así se perdieron 569
-- biografías. Desde esta migración los textos largos de las dos fichas se
-- unen al fusionar y la ficha queda MARCADA para que la IA (DeepSeek flash)
-- los reescriba en uno solo. La marca vive aquí:
--
--   * `ingest.text_rewrites`: una fila por ficha y campo pendiente de
--     reescribir, con los textos originales (`sources`) que la IA debe unir.
--     Solo una pendiente por ficha y campo; una fusión posterior le añade
--     fuentes. Al reescribir se cierra con el run que escribió el texto.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.text_rewrites (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_kind      ingest.claim_entity_kind NOT NULL,
  entity_id        BIGINT       NOT NULL,
  field            VARCHAR(40)  NOT NULL,
  -- [{"label": "<nombre de la ficha de origen>", "text": "<texto original>"}]
  sources          JSONB        NOT NULL,
  reason           TEXT         NOT NULL,
  status           VARCHAR(12)  NOT NULL DEFAULT 'pending',
  -- La fusión que la abrió: deshacerla retira la marca.
  merge_audit_id   BIGINT       REFERENCES ingest.merge_audit(id) ON DELETE SET NULL,
  run_id           BIGINT       REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  resolved_run_id  BIGINT       REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  resolved_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT text_rewrites_status_chk CHECK (status IN ('pending', 'done', 'discarded')),
  CONSTRAINT text_rewrites_kind_chk CHECK (entity_kind IN ('person', 'artist', 'organization', 'album')),
  CONSTRAINT text_rewrites_sources_chk CHECK (jsonb_typeof(sources) = 'array' AND jsonb_array_length(sources) >= 2)
);

CREATE UNIQUE INDEX IF NOT EXISTS text_rewrites_one_pending_uk
  ON ingest.text_rewrites (entity_kind, entity_id, field) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS text_rewrites_merge_audit_idx
  ON ingest.text_rewrites (merge_audit_id) WHERE merge_audit_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS text_rewrites_run_idx ON ingest.text_rewrites (run_id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS text_rewrites_resolved_run_idx ON ingest.text_rewrites (resolved_run_id) WHERE resolved_run_id IS NOT NULL;

-- En el diario (0028): deshacer el run de una fusión o de una reescritura
-- devuelve también la marca.
INSERT INTO ingest.change_journal_tables(table_name, mode, policy)
VALUES ('ingest.text_rewrites', 'full', 'soft')
ON CONFLICT (table_name) DO NOTHING;
SELECT ingest.crv_journal_attach_all();

COMMIT;
