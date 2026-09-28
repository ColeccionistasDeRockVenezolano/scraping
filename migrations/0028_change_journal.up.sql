-- ============================================================================
-- CRV · Migración 0028_change_journal (UP)
-- Diario de cambios por fila para deshacer cualquier run.
--
-- POR QUÉ: cada acción tenía que programar su propia inversa, y no todas la
--   tenían (dividir y convertir personas anunciaban deshacer y no podían; las
--   ediciones directas y los procesos de la CLI no tenían ninguna). Con el
--   diario, deshacer un run es devolver cada fila que tocó a como estaba antes,
--   sin conocer la acción: sirve igual para la API, Curaduría y la CLI.
--
-- CÓMO:
--   * `ingest.change_journal`: una fila por cambio de fila, con la imagen de
--     antes y la de después (en un UPDATE, solo las columnas que cambiaron) y
--     el run al que pertenece. El run sale de `crv.run_id`, una variable de la
--     transacción (o de la sesión) que fija `src/db/run-binding.ts`.
--   * `ingest.crv_journal()`: el disparador AFTER de cada tabla registrada.
--   * `ingest.crv_bind_run()`: al crear un run, la transacción que lo crea
--     queda ligada a él. Así toda escritura hecha en la misma transacción que
--     su run entra al diario sin que el código tenga que recordarlo.
--   * `ingest.change_journal_tables`: qué tablas se registran, cómo (`mode`) y
--     qué hace el deshacer si la fila cambió después (`policy`).
--   * `ingest.run_undos`: qué run deshizo a cuál. Deshacer un deshacer es
--     rehacer.
--
-- DECISIONES:
--   * EXCEPCIÓN APROBADA AL CORE (2026-09-22, el propietario): se añaden
--     disparadores a las tablas de `public`. No cambia ni una columna ni un
--     dato; el diff de `pg_dump --schema=public` de tests/run_all.sh los
--     filtra por nombre (`crv_journal`) y el down los quita.
--   * `mode`: `full` registra altas, cambios y bajas; `no_insert` no registra
--     altas (los claims: el deshacer los encuentra por `claims.run_id` y los
--     deja `superseded`, nunca los borra); `delete_only` solo las bajas (la
--     auditoría es de solo añadir, pero un borrado en cascada se la lleva y
--     el deshacer tiene que devolverla).
--   * `policy`: `strict` si la fila cambió después, el run no se deshace
--     (deshacerlo pisaría ese cambio); `soft` la fila se deja como está y se
--     informa (colas, conflictos, claims: estado de trabajo, no catálogo).
--   * `run_id` sin FK a propósito: el disparador corre en cada escritura del
--     catálogo y no debe pagar ni fallar por esa comprobación.
--   * `crv.journal = off` apaga el diario en una transacción (mantenimiento
--     masivo a sabiendas). Nada del código de la app lo usa.
--
-- REGLAS DE GOBIERNO: idempotente y reversible (0028_change_journal.down.sql).
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.change_journal (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id     BIGINT,                                   -- sin FK a propósito
  txid       XID8 NOT NULL DEFAULT pg_current_xact_id(),
  table_name TEXT NOT NULL,                            -- esquema.tabla
  op         CHAR(1) NOT NULL CONSTRAINT change_journal_op_chk CHECK (op IN ('I', 'U', 'D')),
  row_pk     JSONB NOT NULL,                           -- {"id": 5} o la clave compuesta
  old_data   JSONB,                                    -- D: fila entera; U: columnas que cambiaron
  new_data   JSONB,                                    -- I: fila entera; U: columnas que cambiaron
  at         TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

-- Deshacer lee el run entero en orden; la ficha lee su historia por fila.
CREATE INDEX IF NOT EXISTS change_journal_run_idx ON ingest.change_journal (run_id, id) WHERE run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS change_journal_row_idx ON ingest.change_journal (table_name, row_pk, id);
-- Escrituras que no quedaron ligadas a ningún run (doctor las cuenta).
CREATE INDEX IF NOT EXISTS change_journal_unbound_idx ON ingest.change_journal (at) WHERE run_id IS NULL;

COMMENT ON TABLE ingest.change_journal IS
  'Un cambio de fila por registro (antes/después) ligado a su run. Lo escribe el disparador crv_journal; lo lee el deshacer de runs.';

CREATE TABLE IF NOT EXISTS ingest.change_journal_tables (
  table_name TEXT PRIMARY KEY,
  mode       VARCHAR(12) NOT NULL CONSTRAINT change_journal_tables_mode_chk CHECK (mode IN ('full', 'no_insert', 'delete_only')),
  policy     VARCHAR(6)  NOT NULL CONSTRAINT change_journal_tables_policy_chk CHECK (policy IN ('strict', 'soft'))
);

COMMENT ON TABLE ingest.change_journal_tables IS
  'Tablas con disparador crv_journal: qué se registra (mode) y qué hace el deshacer si la fila cambió después (policy).';

INSERT INTO ingest.change_journal_tables(table_name, mode, policy) VALUES
  -- Catálogo (core)
  ('public.artists', 'full', 'strict'),
  ('public.persons', 'full', 'strict'),
  ('public.organizations', 'full', 'strict'),
  ('public.albums', 'full', 'strict'),
  ('public.tracks', 'full', 'strict'),
  ('public.album_credits', 'full', 'strict'),
  ('public.track_credits', 'full', 'strict'),
  ('public.artist_members', 'full', 'strict'),
  ('public.person_organizations', 'full', 'strict'),
  ('public.album_formats', 'full', 'strict'),
  -- Enlaces del catálogo con YouTube y la web
  ('media.media_links', 'full', 'strict'),
  ('media.video_albums', 'full', 'strict'),
  ('media.video_artists', 'full', 'strict'),
  ('media.video_tracks', 'full', 'strict'),
  -- Estado auxiliar que forma parte de la ficha
  ('ingest.artist_aliases', 'full', 'strict'),
  ('ingest.person_aliases', 'full', 'strict'),
  ('ingest.organization_aliases', 'full', 'strict'),
  ('ingest.album_aliases', 'full', 'strict'),
  ('ingest.track_aliases', 'full', 'strict'),
  ('ingest.entity_redirects', 'full', 'strict'),
  ('ingest.album_classifications', 'full', 'strict'),
  ('ingest.seed_uploads', 'full', 'strict'),
  ('ingest.genres', 'full', 'strict'),
  ('ingest.genre_aliases', 'full', 'strict'),
  ('ingest.artist_genres', 'full', 'strict'),
  ('ingest.album_genres', 'full', 'strict'),
  -- Estado de trabajo: si cambió después, se deja y se informa
  ('ingest.claims', 'no_insert', 'soft'),
  ('ingest.conflicts', 'full', 'soft'),
  ('ingest.review_queue', 'full', 'soft'),
  ('ingest.review_decisions', 'full', 'soft'),
  ('ingest.ambiguity_resolutions', 'full', 'soft'),
  ('ingest.curation_distinct_pairs', 'full', 'soft'),
  -- Historia: solo se devuelve lo que un borrado en cascada se llevó
  ('ingest.merge_audit', 'delete_only', 'soft'),
  ('ingest.merge_audit_claims', 'delete_only', 'soft')
ON CONFLICT (table_name) DO UPDATE SET mode = EXCLUDED.mode, policy = EXCLUDED.policy;

CREATE TABLE IF NOT EXISTS ingest.run_undos (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      BIGINT NOT NULL REFERENCES ingest.scrape_runs(id) ON DELETE CASCADE,  -- el run deshecho
  undo_run_id BIGINT NOT NULL REFERENCES ingest.scrape_runs(id) ON DELETE CASCADE,  -- el run que lo deshizo
  -- journal: con el diario; legacy: con la inversa propia de la acción (runs anteriores al diario).
  method      VARCHAR(8) NOT NULL CONSTRAINT run_undos_method_chk CHECK (method IN ('journal', 'legacy')),
  summary     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT run_undos_undo_uk UNIQUE (undo_run_id),
  CONSTRAINT run_undos_not_self_chk CHECK (run_id <> undo_run_id)
);
CREATE INDEX IF NOT EXISTS run_undos_run_idx ON ingest.run_undos (run_id);

COMMENT ON TABLE ingest.run_undos IS
  'Qué run deshizo a cuál. Un run está deshecho si tiene un deshacer que no fue a su vez deshecho (rehacer).';

-- Los deshacer anteriores al diario (fusiones deshechas desde la API, lotes de
-- Curaduría deshechos) dejaron el run deshecho en sus params: se registran
-- para que el historial los muestre como deshechos.
INSERT INTO ingest.run_undos(run_id, undo_run_id, method)
SELECT DISTINCT ON (u.id) target.id, u.id, 'legacy'
  FROM ingest.scrape_runs u
  JOIN ingest.scrape_runs target
    ON target.id = COALESCE((u.params->>'undoesRunId')::BIGINT,
                            CASE WHEN u.params->>'action' = 'api:merge:undo' THEN (u.params->>'mergeRunId')::BIGINT END)
 WHERE u.status = 'ok' AND target.id <> u.id
ON CONFLICT (undo_run_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Disparador del diario
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ingest.crv_journal() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_mode   TEXT := TG_ARGV[0];
  v_pkcols TEXT[] := TG_ARGV[1:TG_NARGS - 1];
  v_table  TEXT := TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME;
  v_run    BIGINT;
  v_oldrow JSONB;
  v_newrow JSONB;
  v_oldpk  JSONB;
  v_newpk  JSONB;
  v_old    JSONB;
  v_new    JSONB;
BEGIN
  IF current_setting('crv.journal', true) = 'off' THEN
    RETURN NULL;
  END IF;
  v_run := NULLIF(current_setting('crv.run_id', true), '')::BIGINT;

  IF TG_OP = 'INSERT' THEN
    IF v_mode <> 'full' THEN
      RETURN NULL;
    END IF;
    v_newrow := to_jsonb(NEW);
    SELECT jsonb_object_agg(k, v_newrow -> k) INTO v_newpk FROM unnest(v_pkcols) AS k;
    INSERT INTO ingest.change_journal(run_id, table_name, op, row_pk, new_data)
    VALUES (v_run, v_table, 'I', v_newpk, v_newrow);

  ELSIF TG_OP = 'DELETE' THEN
    v_oldrow := to_jsonb(OLD);
    SELECT jsonb_object_agg(k, v_oldrow -> k) INTO v_oldpk FROM unnest(v_pkcols) AS k;
    INSERT INTO ingest.change_journal(run_id, table_name, op, row_pk, old_data)
    VALUES (v_run, v_table, 'D', v_oldpk, v_oldrow);

  ELSE
    IF v_mode = 'delete_only' THEN
      RETURN NULL;
    END IF;
    v_oldrow := to_jsonb(OLD);
    v_newrow := to_jsonb(NEW);
    IF v_oldrow = v_newrow THEN
      RETURN NULL;
    END IF;
    SELECT jsonb_object_agg(k, v_oldrow -> k), jsonb_object_agg(k, v_newrow -> k)
      INTO v_oldpk, v_newpk
      FROM unnest(v_pkcols) AS k;
    IF v_oldpk IS DISTINCT FROM v_newpk THEN
      -- Cambió la clave (p. ej. media.video_albums al fusionar discos): para
      -- el diario es una baja y un alta, cada una con su fila entera.
      INSERT INTO ingest.change_journal(run_id, table_name, op, row_pk, old_data)
      VALUES (v_run, v_table, 'D', v_oldpk, v_oldrow);
      INSERT INTO ingest.change_journal(run_id, table_name, op, row_pk, new_data)
      VALUES (v_run, v_table, 'I', v_newpk, v_newrow);
    ELSE
      SELECT jsonb_object_agg(o.key, o.value), jsonb_object_agg(o.key, v_newrow -> o.key)
        INTO v_old, v_new
        FROM jsonb_each(v_oldrow) o
       WHERE o.value IS DISTINCT FROM v_newrow -> o.key;
      INSERT INTO ingest.change_journal(run_id, table_name, op, row_pk, old_data, new_data)
      VALUES (v_run, v_table, 'U', v_oldpk, v_old, v_new);
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;

COMMENT ON FUNCTION ingest.crv_journal() IS
  'Disparador AFTER del diario de cambios. Argumentos: mode (full|no_insert|delete_only) y las columnas de la clave primaria.';

-- Pone o repone el disparador de una tabla con su clave primaria actual.
CREATE OR REPLACE FUNCTION ingest.crv_journal_attach(p_table REGCLASS, p_mode TEXT) RETURNS VOID
LANGUAGE plpgsql AS $fn$
DECLARE
  v_pk   TEXT[];
  v_args TEXT;
BEGIN
  SELECT array_agg(a.attname::TEXT ORDER BY array_position(i.indkey::INT2[], a.attnum))
    INTO v_pk
    FROM pg_index i
    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
   WHERE i.indrelid = p_table AND i.indisprimary;
  IF v_pk IS NULL THEN
    RAISE EXCEPTION '% no tiene clave primaria: no puede entrar al diario de cambios', p_table;
  END IF;
  SELECT string_agg(quote_literal(x), ', ') INTO v_args FROM unnest(ARRAY[p_mode] || v_pk) AS x;
  EXECUTE format('DROP TRIGGER IF EXISTS crv_journal ON %s', p_table);
  EXECUTE format(
    'CREATE TRIGGER crv_journal AFTER INSERT OR UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION ingest.crv_journal(%s)',
    p_table, v_args);
END
$fn$;

-- Pone el disparador en toda tabla registrada que exista. Idempotente: una
-- migración posterior que cree una de las tablas (p. ej. las de géneros) la
-- vuelve a llamar, y `crv doctor` avisa si alguna quedó sin disparador.
CREATE OR REPLACE FUNCTION ingest.crv_journal_attach_all() RETURNS INTEGER
LANGUAGE plpgsql AS $fn$
DECLARE
  r RECORD;
  n INTEGER := 0;
BEGIN
  FOR r IN SELECT table_name, mode FROM ingest.change_journal_tables ORDER BY table_name LOOP
    IF to_regclass(r.table_name) IS NOT NULL THEN
      PERFORM ingest.crv_journal_attach(to_regclass(r.table_name), r.mode);
      n := n + 1;
    END IF;
  END LOOP;
  RETURN n;
END
$fn$;

SELECT ingest.crv_journal_attach_all();

-- ---------------------------------------------------------------------------
-- Enlace automático al run
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ingest.crv_bind_run() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  PERFORM set_config('crv.run_id', NEW.id::TEXT, true);
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS crv_bind_run ON ingest.scrape_runs;
CREATE TRIGGER crv_bind_run AFTER INSERT ON ingest.scrape_runs
  FOR EACH ROW EXECUTE FUNCTION ingest.crv_bind_run();

COMMIT;
