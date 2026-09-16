-- ============================================================================
-- CRV · Migración 0017_curation_findings (UP)
-- Detector de conflictos de Curaduría: análisis y hallazgos persistidos.
--
-- POR QUÉ: el detector (src/curation/) recorre el catálogo entero y agrupa
--   por categoría lo que encuentra —nombres sucios, mal segmentados, fichas de
--   otro tipo, repetidas, datos incoherentes, valores en disputa—. Sin tabla,
--   cada análisis olvidaría lo que una persona ya decidió («no es un problema»)
--   y no habría forma de saber cuándo apareció un caso ni cuándo se corrigió.
--
-- CICLO DE VIDA: cada hallazgo tiene una huella estable (`fingerprint`:
--   detector + entidad + valor). Un análisis nuevo:
--     * inserta lo que no existía (open),
--     * refresca lo que sigue presente (last_seen_*),
--     * marca `resolved` lo que ya no detecta (se corrigió en el catálogo),
--     * reabre lo resuelto que vuelve a aparecer,
--     * NUNCA reabre lo que una persona marcó `ignored`.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente y
--   reversible.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.curation_scans (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  status VARCHAR(12) NOT NULL DEFAULT 'running'
    CONSTRAINT curation_scans_status_chk CHECK (status IN ('running', 'ok', 'failed')),
  trigger VARCHAR(40) NOT NULL,
  requested_by TEXT,
  catalog_signature TEXT,
  counters JSONB NOT NULL DEFAULT '{}'::jsonb,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS curation_scans_started_idx ON ingest.curation_scans (started_at DESC);

CREATE TABLE IF NOT EXISTS ingest.curation_findings (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  category VARCHAR(60) NOT NULL,
  detector VARCHAR(80) NOT NULL,
  -- Subgrupo dentro del detector (p. ej. el carácter infrecuente en «Otros»).
  signature TEXT NOT NULL,
  severity VARCHAR(8) NOT NULL
    CONSTRAINT curation_findings_severity_chk CHECK (severity IN ('high', 'medium', 'low')),
  entity_kind VARCHAR(30) NOT NULL,
  entity_id BIGINT,
  entity_label TEXT,
  field VARCHAR(60),
  value TEXT,
  title TEXT NOT NULL,
  suggestion TEXT,
  related JSONB NOT NULL DEFAULT '[]'::jsonb,
  evidence JSONB NOT NULL DEFAULT '{}'::jsonb,
  status VARCHAR(10) NOT NULL DEFAULT 'open'
    CONSTRAINT curation_findings_status_chk CHECK (status IN ('open', 'ignored', 'resolved')),
  first_seen_scan_id BIGINT REFERENCES ingest.curation_scans(id) ON DELETE SET NULL,
  last_seen_scan_id BIGINT REFERENCES ingest.curation_scans(id) ON DELETE SET NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  ignored_at TIMESTAMPTZ,
  ignored_by TEXT,
  ignore_note TEXT,
  CONSTRAINT curation_findings_fingerprint_uk UNIQUE (fingerprint),
  CONSTRAINT curation_findings_ignored_chk CHECK (status <> 'ignored' OR (ignored_at IS NOT NULL AND ignored_by IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS curation_findings_status_category_idx ON ingest.curation_findings (status, category, detector);
CREATE INDEX IF NOT EXISTS curation_findings_entity_idx ON ingest.curation_findings (entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS curation_findings_first_seen_scan_idx ON ingest.curation_findings (first_seen_scan_id) WHERE first_seen_scan_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS curation_findings_last_seen_scan_idx ON ingest.curation_findings (last_seen_scan_id) WHERE last_seen_scan_id IS NOT NULL;

COMMIT;
