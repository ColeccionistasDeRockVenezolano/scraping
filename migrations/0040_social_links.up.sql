-- ============================================================================
-- CRV · Migración 0040_social_links (UP)
-- Redes sociales del artista en su propio campo (Brian, 2026-10-05: «las redes
-- sociales deben tener su campo en la base de datos»).
-- **Séptima excepción aprobada al core**: una tabla nueva en `public`, hermana
-- de `streaming_links` (0039), solo para perfiles sociales del artista. Las
-- plataformas de escucha (Spotify, Deezer, YouTube…) siguen en streaming_links.
--
-- Cada fila es UN perfil de UNA red para UN artista:
--   * `platform` — vocabulario cerrado (CHECK): instagram · facebook · x ·
--                  tiktok · threads · bluesky.
--   * `handle`   — el usuario sin «@», si la URL lo deja leer.
--   * `method`   — cómo se casó la ficha con el perfil: exact | fuzzy.
--   * `source`   — de dónde salió (musicbrainz-url-rels, wikidata-Q…).
--   * `verified` — identidad confirmada (país o disco en común en la fuente);
--                  la web pública solo muestra las verificadas.
--
-- UNIQUE (artista, red): un perfil por red y ficha. Si la ficha se borra o se
-- fusiona, sus redes se van con ella.
--
-- REGLAS DE GOBIERNO: en el diario (0028, `soft`) para que deshacer el run que
-- las escribió las retire. El diff de `public` (tests/run_all.sh,
-- core-and-schema) y la huella de `crv doctor` (APPROVED_CORE_ADDITIONS)
-- aceptan solo esta tabla.
-- ============================================================================

BEGIN;
SET LOCAL crv.journal = 'off';

CREATE TABLE IF NOT EXISTS public.social_links (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artist_id   BIGINT NOT NULL REFERENCES public.artists(id) ON DELETE CASCADE,
  platform    VARCHAR(24) NOT NULL,
  url         TEXT NOT NULL,
  handle      VARCHAR(120),
  method      VARCHAR(16) NOT NULL,
  source      VARCHAR(40) NOT NULL,
  verified    BOOLEAN NOT NULL DEFAULT false,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT social_links_platform_ck CHECK (platform IN ('instagram', 'facebook', 'x', 'tiktok', 'threads', 'bluesky'))
);
CREATE UNIQUE INDEX IF NOT EXISTS social_links_artist_uk ON public.social_links (artist_id, platform);

INSERT INTO ingest.change_journal_tables(table_name, mode, policy)
VALUES ('public.social_links', 'full', 'soft')
ON CONFLICT (table_name) DO NOTHING;
SELECT ingest.crv_journal_attach_all();

COMMIT;
