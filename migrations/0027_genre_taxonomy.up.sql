-- ============================================================================
-- CRV · Migración 0027_genre_taxonomy (UP)
-- PLAN_GENEROS_CATALOGO_Y_RADIO_CRV §4 y etapa 2: taxonomía de géneros en dos
-- niveles (familia → género), alias normalizados, asignaciones por artista y
-- por álbum con evidencia y estado, y el registro de cambios de la taxonomía.
--
--   * `ingest.genres` (0001, vacía hasta hoy) gana slug estable, nivel,
--     familia, descripción, reemplazo al desactivarse y quién/cuándo/por qué.
--   * `ingest.genre_aliases`: texto de fuente ya normalizado (en TypeScript con
--     NFD: la base es SQL_ASCII y aquí no se pueden quitar tildes) → género, o
--     marca `not_a_genre` (formato, sello, lugar…).
--   * `ingest.artist_genres` / `ingest.album_genres`: asignaciones. Un género
--     de artista NUNCA genera filas de álbum. `decision_kind` separa lo que
--     escribe una regla (recalculable) de lo que decide una persona (intocable
--     para los procesos automáticos).
--   * `ingest.genre_taxonomy_changes`: cada cambio de género o alias, con
--     antes/después, actor y motivo.
--
-- Las asignaciones NO se borran en cascada: la FK a `public` es NO ACTION.
-- Las fusiones las trasladan (src/genres/merge.ts) y el retiro auditado las
-- copia a la ficha padre antes de soltarlas (src/merge/removals.ts).
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ingest.genres) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns WHERE table_schema='ingest' AND table_name='genres' AND column_name='slug'
  ) THEN
    RAISE EXCEPTION 'ingest.genres tiene filas sin slug: la taxonomía se carga con `crv genres taxonomy-apply`, no a mano';
  END IF;
END $$;

ALTER TABLE ingest.genres
  ADD COLUMN IF NOT EXISTS slug                 VARCHAR(100),
  ADD COLUMN IF NOT EXISTS level                VARCHAR(10) NOT NULL DEFAULT 'genre',
  ADD COLUMN IF NOT EXISTS parent_genre_id      BIGINT,
  ADD COLUMN IF NOT EXISTS description          TEXT,
  ADD COLUMN IF NOT EXISTS replaced_by_genre_id BIGINT,
  ADD COLUMN IF NOT EXISTS created_by           VARCHAR(120),
  ADD COLUMN IF NOT EXISTS created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by           VARCHAR(120),
  ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS change_reason        TEXT;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='genres_slug_uk') THEN
    ALTER TABLE ingest.genres ALTER COLUMN slug SET NOT NULL;
    ALTER TABLE ingest.genres ADD CONSTRAINT genres_slug_uk UNIQUE (slug);
    ALTER TABLE ingest.genres ADD CONSTRAINT genres_slug_format_chk CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
    ALTER TABLE ingest.genres ADD CONSTRAINT genres_level_chk CHECK (level IN ('family','genre'));
    -- Solo las familias carecen de familia; un género siempre cuelga de una.
    ALTER TABLE ingest.genres ADD CONSTRAINT genres_parent_level_chk CHECK ((level='family') = (parent_genre_id IS NULL));
    ALTER TABLE ingest.genres ADD CONSTRAINT genres_parent_fk
      FOREIGN KEY (parent_genre_id) REFERENCES ingest.genres(id) ON DELETE RESTRICT;
    ALTER TABLE ingest.genres ADD CONSTRAINT genres_replaced_by_fk
      FOREIGN KEY (replaced_by_genre_id) REFERENCES ingest.genres(id) ON DELETE RESTRICT;
    -- Un género solo se desactiva indicando su reemplazo (PLAN §4 «Cambios en la taxonomía»).
    ALTER TABLE ingest.genres ADD CONSTRAINT genres_inactive_replacement_chk
      CHECK (active OR replaced_by_genre_id IS NOT NULL);
    ALTER TABLE ingest.genres ADD CONSTRAINT genres_not_self_replaced_chk
      CHECK (replaced_by_genre_id IS NULL OR replaced_by_genre_id <> id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS genres_parent_idx ON ingest.genres (parent_genre_id);
CREATE INDEX IF NOT EXISTS genres_replaced_by_idx ON ingest.genres (replaced_by_genre_id);

-- El padre de un género es siempre una familia: dos niveles, nunca tres.
CREATE OR REPLACE FUNCTION ingest.genres_parent_is_family() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_genre_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM ingest.genres g WHERE g.id = NEW.parent_genre_id AND g.level = 'family'
  ) THEN
    RAISE EXCEPTION 'el padre del género % debe ser una familia', NEW.slug;
  END IF;
  IF NEW.level = 'genre' AND TG_OP = 'UPDATE' AND OLD.level = 'family'
     AND EXISTS (SELECT 1 FROM ingest.genres g WHERE g.parent_genre_id = NEW.id) THEN
    RAISE EXCEPTION 'la familia % tiene géneros hijos y no puede pasar a género', NEW.slug;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS genres_parent_is_family_trg ON ingest.genres;
CREATE TRIGGER genres_parent_is_family_trg
  BEFORE INSERT OR UPDATE OF parent_genre_id, level ON ingest.genres
  FOR EACH ROW EXECUTE FUNCTION ingest.genres_parent_is_family();

CREATE TABLE IF NOT EXISTS ingest.genre_aliases (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  alias_normalized VARCHAR(200) NOT NULL,
  kind             VARCHAR(20)  NOT NULL DEFAULT 'genre',
  genre_id         BIGINT REFERENCES ingest.genres(id) ON DELETE RESTRICT,
  notes            TEXT,
  created_by       VARCHAR(120) NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_by       VARCHAR(120),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  change_reason    TEXT,
  CONSTRAINT genre_aliases_alias_uk UNIQUE (alias_normalized),
  CONSTRAINT genre_aliases_kind_chk CHECK (kind IN ('genre','not_a_genre')),
  CONSTRAINT genre_aliases_target_chk CHECK ((kind = 'genre') = (genre_id IS NOT NULL)),
  CONSTRAINT genre_aliases_normalized_chk CHECK (alias_normalized = btrim(alias_normalized) AND alias_normalized <> '' AND alias_normalized = lower(alias_normalized))
);
CREATE INDEX IF NOT EXISTS genre_aliases_genre_idx ON ingest.genre_aliases (genre_id) WHERE genre_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ingest.genre_taxonomy_changes (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  change_kind VARCHAR(40)  NOT NULL,
  target_kind VARCHAR(10)  NOT NULL,
  target_key  TEXT         NOT NULL,
  before      JSONB,
  after       JSONB,
  affected    JSONB,
  actor       VARCHAR(120) NOT NULL,
  reason      TEXT         NOT NULL,
  run_id      BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT genre_taxonomy_changes_target_chk CHECK (target_kind IN ('genre','alias')),
  CONSTRAINT genre_taxonomy_changes_reason_chk CHECK (btrim(reason) <> '' AND btrim(actor) <> '')
);
CREATE INDEX IF NOT EXISTS genre_taxonomy_changes_run_idx ON ingest.genre_taxonomy_changes (run_id) WHERE run_id IS NOT NULL;

-- Asignaciones. Mismas columnas para artista y álbum; `track_genres` queda
-- diferida (ninguna fuente publica géneros por pista: la pista hereda del álbum).
DO $$
DECLARE
  target TEXT;
  parent TEXT;
BEGIN
  FOREACH target IN ARRAY ARRAY['artist','album'] LOOP
    parent := CASE target WHEN 'artist' THEN 'public.artists' ELSE 'public.albums' END;
    EXECUTE format($ddl$
      CREATE TABLE IF NOT EXISTS ingest.%1$s_genres (
        id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        %1$s_id          BIGINT NOT NULL REFERENCES %2$s(id) ON DELETE NO ACTION,
        genre_id         BIGINT NOT NULL REFERENCES ingest.genres(id) ON DELETE RESTRICT,
        role             VARCHAR(10)  NOT NULL DEFAULT 'secondary',
        status           VARCHAR(12)  NOT NULL,
        confidence       VARCHAR(6)   NOT NULL DEFAULT 'medium',
        source_kind      VARCHAR(20)  NOT NULL,
        source_id        BIGINT REFERENCES ingest.sources(id) ON DELETE RESTRICT,
        claim_ids        BIGINT[]     NOT NULL DEFAULT '{}',
        raw_value        TEXT,
        evidence         JSONB        NOT NULL DEFAULT '[]'::jsonb,
        decided_by       VARCHAR(120),
        decided_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
        decision_rule    VARCHAR(60)  NOT NULL,
        decision_kind    VARCHAR(10)  NOT NULL,
        decision_note    TEXT,
        superseded_by_id BIGINT,
        created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
        updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
        CONSTRAINT %1$s_genres_pair_uk UNIQUE (%1$s_id, genre_id),
        CONSTRAINT %1$s_genres_role_chk CHECK (role IN ('primary','secondary')),
        CONSTRAINT %1$s_genres_status_chk CHECK (status IN ('suggested','confirmed','rejected','superseded')),
        CONSTRAINT %1$s_genres_confidence_chk CHECK (confidence IN ('high','medium','low')),
        CONSTRAINT %1$s_genres_source_kind_chk CHECK (source_kind IN ('catalog_source','editorial','external','ai')),
        CONSTRAINT %1$s_genres_decision_kind_chk CHECK (decision_kind IN ('rule','human')),
        -- Una decisión humana siempre tiene a alguien detrás.
        CONSTRAINT %1$s_genres_human_by_chk CHECK (decision_kind = 'rule' OR (decided_by IS NOT NULL AND btrim(decided_by) <> '')),
        -- Solo lo vigente puede ser principal.
        CONSTRAINT %1$s_genres_primary_chk CHECK (role = 'secondary' OR status IN ('confirmed','suggested')),
        -- `superseded` no es un rechazo: siempre dice qué fila lo reemplazó.
        CONSTRAINT %1$s_genres_superseded_chk CHECK ((status = 'superseded') = (superseded_by_id IS NOT NULL)),
        CONSTRAINT %1$s_genres_not_self_chk CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
        CONSTRAINT %1$s_genres_superseded_fk FOREIGN KEY (superseded_by_id)
          REFERENCES ingest.%1$s_genres(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
      )$ddl$, target, parent);
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %1$s_genres_one_primary_uk ON ingest.%1$s_genres (%1$s_id) WHERE role = ''primary'' AND status = ''confirmed''', target);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %1$s_genres_genre_idx ON ingest.%1$s_genres (genre_id)', target);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %1$s_genres_superseded_idx ON ingest.%1$s_genres (superseded_by_id) WHERE superseded_by_id IS NOT NULL', target);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %1$s_genres_source_idx ON ingest.%1$s_genres (source_id) WHERE source_id IS NOT NULL', target);
  END LOOP;
END $$;

-- Historial de las decisiones humanas sobre asignaciones (confirmar, rechazar,
-- revertir): quién, cuándo, por qué y la fila antes/después. Las filas `rule`
-- no se registran aquí: se recalculan desde los claims y el reporte del
-- backfill las cuenta.
CREATE TABLE IF NOT EXISTS ingest.genre_assignment_log (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_kind VARCHAR(10)  NOT NULL,
  entity_id   BIGINT       NOT NULL,
  genre_id    BIGINT REFERENCES ingest.genres(id) ON DELETE RESTRICT,
  action      VARCHAR(30)  NOT NULL,
  before      JSONB,
  after       JSONB,
  actor       VARCHAR(120) NOT NULL,
  reason      TEXT         NOT NULL,
  run_id      BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT genre_assignment_log_kind_chk CHECK (entity_kind IN ('artist','album')),
  CONSTRAINT genre_assignment_log_reason_chk CHECK (btrim(reason) <> '' AND btrim(actor) <> '')
);
CREATE INDEX IF NOT EXISTS genre_assignment_log_entity_idx ON ingest.genre_assignment_log (entity_kind, entity_id);
CREATE INDEX IF NOT EXISTS genre_assignment_log_genre_idx ON ingest.genre_assignment_log (genre_id);
CREATE INDEX IF NOT EXISTS genre_assignment_log_run_idx ON ingest.genre_assignment_log (run_id) WHERE run_id IS NOT NULL;

-- Solo los géneros activos reciben asignaciones nuevas (o se reapuntan a uno).
CREATE OR REPLACE FUNCTION ingest.genre_assignment_active_genre() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Deshacer una fusión o un retiro devuelve las filas tal como estaban,
  -- aunque su género se haya desactivado después: no son asignaciones nuevas.
  IF current_setting('crv.genres_restore', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' OR NEW.genre_id IS DISTINCT FROM OLD.genre_id)
     AND NOT EXISTS (SELECT 1 FROM ingest.genres g WHERE g.id = NEW.genre_id AND g.active) THEN
    RAISE EXCEPTION 'el género % está inactivo y no admite asignaciones nuevas', NEW.genre_id;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS artist_genres_active_genre_trg ON ingest.artist_genres;
CREATE TRIGGER artist_genres_active_genre_trg BEFORE INSERT OR UPDATE OF genre_id ON ingest.artist_genres
  FOR EACH ROW EXECUTE FUNCTION ingest.genre_assignment_active_genre();
DROP TRIGGER IF EXISTS album_genres_active_genre_trg ON ingest.album_genres;
CREATE TRIGGER album_genres_active_genre_trg BEFORE INSERT OR UPDATE OF genre_id ON ingest.album_genres
  FOR EACH ROW EXECUTE FUNCTION ingest.genre_assignment_active_genre();

COMMIT;
