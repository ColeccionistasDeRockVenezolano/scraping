-- ============================================================================
-- CRV · Migración 0038_image_candidates (UP)
-- Elegir portada o foto de artista a ojo en Curaduría (Brian, 2026-10-04).
--
-- La mejora de portadas pequeñas (runs 11979 y 12002) aplicó sola las
-- coincidencias claras; las dudosas (misma portada con otro recorte, otra
-- edición, escaneo distinto…) esperan que una persona las mire. Lo mismo con
-- los artistas que tienen más de una foto de perfil en las fuentes. Cada fila
-- es UNA imagen candidata para una ficha:
--
--   * `current_url`  — la imagen que tenía la ficha cuando se propuso; si la
--                      ficha cambió entre medias, la API no aplica la elección.
--   * `status`       — open (pendiente), chosen (la elegida), rejected (se
--                      descartó: se eligió otra o se dejó la actual).
--   * `decision_run_id` — run de operador que aplicó la decisión; deshacer ese
--                      run devuelve la portada y reabre las candidatas.
--
-- Una sola de `album_id` / `artist_id` según `entity_kind`. Si la ficha se
-- borra o se fusiona en otra, sus candidatas se van con ella.
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca; en el diario
-- (0028, `soft`) para que deshacer el run que la escribió la retire.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.image_candidates (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_kind      VARCHAR(10)  NOT NULL CHECK (entity_kind IN ('album', 'artist')),
  album_id         BIGINT       REFERENCES public.albums(id) ON DELETE CASCADE,
  artist_id        BIGINT       REFERENCES public.artists(id) ON DELETE CASCADE,
  current_url      TEXT,
  candidate_url    TEXT         NOT NULL,
  source           VARCHAR(40)  NOT NULL,
  page_url         TEXT,
  width            INTEGER,
  height           INTEGER,
  -- Parecido con la imagen actual (0–1), cuando se calculó; NULL en fotos de artista.
  score            NUMERIC(4, 3),
  -- Tanda que la propuso («portadas-mejora-2026-10-03», «fotos-artista-2026-10-04»…).
  origin           VARCHAR(80)  NOT NULL,
  status           VARCHAR(10)  NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'chosen', 'rejected')),
  decided_by       TEXT,
  decided_at       TIMESTAMPTZ,
  decision_run_id  BIGINT       REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  run_id           BIGINT       REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT image_candidates_entity_ck CHECK (
    (entity_kind = 'album' AND album_id IS NOT NULL AND artist_id IS NULL)
    OR (entity_kind = 'artist' AND artist_id IS NOT NULL AND album_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS image_candidates_album_uk ON ingest.image_candidates (album_id, candidate_url) WHERE album_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS image_candidates_artist_uk ON ingest.image_candidates (artist_id, candidate_url) WHERE artist_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS image_candidates_open_idx ON ingest.image_candidates (entity_kind, status);
CREATE INDEX IF NOT EXISTS image_candidates_decision_run_idx ON ingest.image_candidates (decision_run_id) WHERE decision_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS image_candidates_run_idx ON ingest.image_candidates (run_id) WHERE run_id IS NOT NULL;

INSERT INTO ingest.change_journal_tables(table_name, mode, policy)
VALUES ('ingest.image_candidates', 'full', 'soft')
ON CONFLICT (table_name) DO NOTHING;
SELECT ingest.crv_journal_attach_all();

COMMIT;
