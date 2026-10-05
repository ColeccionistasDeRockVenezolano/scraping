-- ============================================================================
-- CRV · Migración 0039_streaming_links (UP)
-- Links a plataformas de streaming por artista (perfil) y por álbum
-- (Brian, 2026-10-04: «implementa todas las etapas» del plan de enlaces).
-- **Sexta excepción aprobada al core**: una tabla nueva en `public` con las
-- URLs de Spotify / Apple Music / Deezer / YouTube / Tidal / Bandcamp /
-- SoundCloud / Amazon Music que la campaña de enlaces cosecha y verifica.
--
-- Cada fila es UN link de UNA plataforma para UN artista (perfil) o UN álbum:
--   * `platform`    — vocabulario: spotify · apple_music · deezer · youtube ·
--                     tidal · bandcamp · soundcloud · amazon_music.
--   * `method`      — cómo se casó la ficha con la plataforma: exact | fuzzy.
--   * `source`      — de dónde salió (spotify-search, itunes-albums,
--                     musicbrainz-url-rels, wikidata-Q123…).
--   * `verified`    — visto/confirmado en revisión; la web puede filtrar por él.
--
-- Exactamente uno de `artist_id` / `album_id` por fila; si la ficha se borra
-- o se fusiona, sus links se van con ella. UNIQUE parcial (entidad, plataforma):
-- un solo link por plataforma y ficha — las campañas posteriores actualizan.
--
-- REGLAS DE GOBIERNO: en el diario (0028, `soft`) para que deshacer el run que
-- los escribió los retire. El diff de `public` (tests/run_all.sh,
-- core-and-schema) y la huella de `crv doctor` (APPROVED_CORE_ADDITIONS)
-- aceptan solo esta tabla.
-- ============================================================================

BEGIN;
SET LOCAL crv.journal = 'off';

CREATE TABLE IF NOT EXISTS public.streaming_links (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  artist_id   BIGINT REFERENCES public.artists(id) ON DELETE CASCADE,
  album_id    BIGINT REFERENCES public.albums(id) ON DELETE CASCADE,
  platform    VARCHAR(24) NOT NULL,
  url         TEXT NOT NULL,
  external_id VARCHAR(120),
  method      VARCHAR(16) NOT NULL,
  source      VARCHAR(40) NOT NULL,
  verified    BOOLEAN NOT NULL DEFAULT false,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT streaming_links_entity_ck CHECK (num_nonnulls(artist_id, album_id) = 1)
);
CREATE UNIQUE INDEX IF NOT EXISTS streaming_links_artist_uk ON public.streaming_links (artist_id, platform) WHERE artist_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS streaming_links_album_uk ON public.streaming_links (album_id, platform) WHERE album_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS streaming_links_album_idx ON public.streaming_links (album_id) WHERE album_id IS NOT NULL;

INSERT INTO ingest.change_journal_tables(table_name, mode, policy)
VALUES ('public.streaming_links', 'full', 'soft')
ON CONFLICT (table_name) DO NOTHING;
SELECT ingest.crv_journal_attach_all();

COMMIT;
