-- ============================================================================
-- CRV · Migración 0035_artist_relations (UP)
-- Relaciones explícitas entre artistas (Brian, 2026-10-01).
--
-- «Artistas relacionados» solo se calculaba al vuelo: dos bandas que comparten
-- dos o más integrantes. Los linajes documentados (investigación de cambios de
-- nombre del rock venezolano) no siempre se ven así: un proyecto sucesor puede
-- no tener aún sus integrantes cargados, o compartir uno solo. Esta tabla
-- guarda la relación afirmada por una fuente, con su evidencia:
--
--   * `successor`          — proyecto nuevo o reconfigurado que continúa de
--                            forma colectiva una etapa anterior (Radio Clip →
--                            RC2). NO es un renombre: los renombres van como
--                            alias de la misma ficha.
--   * `ex_member_project`  — proyecto distinto conectado por uno o varios
--                            exintegrantes (Zapato 3 → Solares).
--   * `temporary_name`     — nombre o fusión breve (Zignia → Los NoName).
--
-- `from_artist_id` es la banda de origen y `to_artist_id` la posterior; la
-- ficha muestra la relación en los dos sentidos. Sin CHECK from<>to a
-- propósito: si un día se fusionan las dos fichas, `mergeInto` reapunta la FK
-- y una relación consigo misma no debe hacer fallar la fusión (la API la
-- ignora).
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca; en el diario
-- (0028) para que deshacer el run que la escribió la retire.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.artist_relations (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  from_artist_id  BIGINT       NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,
  to_artist_id    BIGINT       NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,
  relation_type   VARCHAR(20)  NOT NULL,
  -- Integrantes puente tal como los nombra la fuente («Argel», «Félix Duque + Arturo Torres»).
  bridge_members  TEXT,
  start_year      SMALLINT,
  end_year        SMALLINT,
  evidence_note   TEXT,
  source_urls     TEXT[]       NOT NULL DEFAULT '{}',
  confidence      VARCHAR(12)  NOT NULL DEFAULT 'medium',
  run_id          BIGINT       REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  reviewed_by     VARCHAR(120),
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT artist_relations_type_chk CHECK (relation_type IN ('successor', 'ex_member_project', 'temporary_name')),
  CONSTRAINT artist_relations_confidence_chk CHECK (confidence IN ('high', 'medium_high', 'medium', 'low')),
  CONSTRAINT artist_relations_pair_uk UNIQUE (from_artist_id, to_artist_id, relation_type)
);

CREATE INDEX IF NOT EXISTS artist_relations_to_idx ON ingest.artist_relations (to_artist_id);
CREATE INDEX IF NOT EXISTS artist_relations_run_idx ON ingest.artist_relations (run_id) WHERE run_id IS NOT NULL;

INSERT INTO ingest.change_journal_tables(table_name, mode, policy)
VALUES ('ingest.artist_relations', 'full', 'strict')
ON CONFLICT (table_name) DO NOTHING;
SELECT ingest.crv_journal_attach_all();

COMMIT;
