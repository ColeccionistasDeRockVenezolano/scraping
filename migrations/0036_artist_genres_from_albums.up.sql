-- ============================================================================
-- CRV · Migración 0036_artist_genres_from_albums (UP)
-- El artista suma los géneros de sus discos (Brian, 2026-10-01).
--
-- REGLA (decisiones del propietario):
--   * Todo artista recibe, como COMPLEMENTO, los géneros confirmados de sus
--     discos que no tenga. Su género propio (fuente, persona, externo) manda:
--     la regla nunca toca una fila que no sea suya.
--   * Es AUTOAJUSTABLE: si ningún disco conserva un género derivado, el
--     artista lo pierde; si un disco gana uno, el artista lo gana.
--   * PRINCIPAL: solo si el artista no tiene principal propio. Es el género que
--     es principal en más discos; en empate, el del disco más reciente. Si ese
--     género ya es del artista por otra vía (p. ej. secundario propio), la regla
--     no elige principal: lo decide una persona en la Mesa.
--   * LAYA: un género de disco elegido por Laya también pasa; si fue el único
--     origen, la fila lleva `decision_rule = 'de_sus_discos_laya'` y el
--     artista se marca «Género por Laya» (solo con sesión).
--   * Various Artists (marcador de recopilatorio) no recibe nada.
--   * Una familia no se deriva si el artista ya tiene (propio o de sus discos)
--     un subgénero de ella: sería perder precisión.
--   * Una persona manda: confirmar una fila derivada la vuelve humana, y un
--     rechazo humano impide que la regla la vuelva a crear.
--
-- CÓMO:
--   * Filas derivadas = `source_kind = 'albums'` y `decision_kind = 'rule'`.
--   * `ingest.crv_derive_artist_genres(artista, aplicar)` recalcula las filas
--     derivadas de un artista (o solo cuenta cuántas cambiarían).
--   * Disparadores livianos anotan al artista afectado en
--     `ingest.artist_genres_pending` (uno por artista y transacción); un
--     disparador DIFERIDO lo recalcula al confirmar, cuando todo el cambio ya
--     está hecho. Las escrituras quedan en el diario (0028) con el run de la
--     transacción; recalcular es determinista, así que deshacer un run deja
--     las filas derivadas como estaban.
--   * `crv.artist_genres_from_albums = off` apaga la regla en una transacción
--     (mantenimiento a sabiendas; `crv genres derive-artists` reconcilia).
--
-- QUINTA EXCEPCIÓN APROBADA AL CORE (Brian, 2026-10-01): disparador
--   `crv_artist_genres_from_albums` en `public.albums` (borrar un disco o
--   cambiarlo de artista). No cambia columnas ni datos de `public`; el diff de
--   `pg_dump --schema=public` lo filtra por nombre y el down lo quita.
--
-- REGLAS DE GOBIERNO: idempotente y reversible (0036 down).
-- ============================================================================

BEGIN;

ALTER TABLE ingest.artist_genres DROP CONSTRAINT IF EXISTS artist_genres_source_kind_chk;
ALTER TABLE ingest.artist_genres ADD CONSTRAINT artist_genres_source_kind_chk
  CHECK (source_kind IN ('catalog_source', 'editorial', 'external', 'ai', 'albums'));

CREATE TABLE IF NOT EXISTS ingest.artist_genres_pending (
  artist_id BIGINT PRIMARY KEY   -- sin FK: el artista puede haberse borrado en la misma transacción
);
COMMENT ON TABLE ingest.artist_genres_pending IS
  'Artistas cuyos géneros derivados de sus discos hay que recalcular al confirmar la transacción (0036). Vacía fuera de una transacción.';

-- ---------------------------------------------------------------------------
-- Recalcular las filas derivadas de un artista
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ingest.crv_derive_artist_genres(p_artist BIGINT, p_apply BOOLEAN DEFAULT true)
RETURNS INTEGER
LANGUAGE plpgsql AS $fn$
DECLARE
  v_name        TEXT;
  v_own_primary BOOLEAN;
  v_primary     BIGINT;
  v_want        JSONB := '{}'::jsonb;  -- genre_id → {role, rule, evidence}
  v_have        JSONB := '{}'::jsonb;  -- genre_id → fila derivada actual
  v_key         TEXT;
  v_changes     INTEGER := 0;
  r             RECORD;
BEGIN
  SELECT lower(btrim(name)) INTO v_name FROM public.artists WHERE id = p_artist;
  IF NOT FOUND THEN
    RETURN 0;
  END IF;

  IF v_name NOT IN ('various artists', 'varios artistas', 'v.a.', 'va') THEN
    v_own_primary := EXISTS (
      SELECT 1 FROM ingest.artist_genres
       WHERE artist_id = p_artist AND role = 'primary' AND status = 'confirmed'
         AND NOT (source_kind = 'albums' AND decision_kind = 'rule'));

    FOR r IN
      WITH alb AS (
        SELECT x.genre_id, x.role, x.decided_by, al.id AS album_id, COALESCE(al.release_year, -1)::BIGINT AS yr
          FROM public.albums al
          JOIN ingest.album_genres x ON x.album_id = al.id AND x.status = 'confirmed'
          JOIN ingest.genres g ON g.id = x.genre_id AND g.active
         WHERE al.artist_id = p_artist),
      own AS (
        SELECT genre_id, status FROM ingest.artist_genres
         WHERE artist_id = p_artist AND NOT (source_kind = 'albums' AND decision_kind = 'rule')),
      per AS (
        SELECT a.genre_id,
               count(*) FILTER (WHERE a.role = 'primary') AS n_primary,
               count(*) AS n_albums,
               max(ARRAY[a.yr, a.album_id]) FILTER (WHERE a.role = 'primary') AS last_primary,
               max(ARRAY[a.yr, a.album_id]) AS last_any,
               bool_and(a.decided_by IS NOT DISTINCT FROM 'auto:laya') AS only_laya,
               jsonb_agg(jsonb_build_object('albumId', a.album_id, 'role', a.role) ORDER BY a.album_id) AS evidence
          FROM alb a
         GROUP BY a.genre_id),
      pool AS (
        -- Lo que el artista podría tener por sus discos: fuera lo que una
        -- persona rechazó o quedó reemplazado, y las familias con un hijo.
        SELECT p.*, o.status AS own_status
          FROM per p
          JOIN ingest.genres g ON g.id = p.genre_id
          LEFT JOIN own o ON o.genre_id = p.genre_id
         WHERE COALESCE(o.status, 'confirmed') IN ('confirmed', 'suggested')
           AND NOT (g.level = 'family' AND EXISTS (
                 SELECT 1 FROM ingest.genres c
                  WHERE c.parent_genre_id = g.id
                    AND (c.id IN (SELECT genre_id FROM per)
                         OR c.id IN (SELECT genre_id FROM own WHERE status = 'confirmed')))))
      SELECT genre_id, own_status, only_laya, evidence,
             row_number() OVER (ORDER BY n_primary DESC, last_primary DESC NULLS LAST, n_albums DESC, last_any DESC, genre_id) AS rank
        FROM pool
       ORDER BY rank
    LOOP
      IF r.rank = 1 AND NOT v_own_primary AND r.own_status IS NULL THEN
        v_primary := r.genre_id;
      END IF;
      IF r.own_status IS NULL THEN
        v_want := v_want || jsonb_build_object(r.genre_id::TEXT, jsonb_build_object(
          'role', CASE WHEN r.genre_id = v_primary THEN 'primary' ELSE 'secondary' END,
          'rule', CASE WHEN r.only_laya THEN 'de_sus_discos_laya' ELSE 'de_sus_discos' END,
          'evidence', r.evidence));
      END IF;
    END LOOP;
  END IF;

  SELECT COALESCE(jsonb_object_agg(genre_id::TEXT, jsonb_build_object(
           'id', id, 'role', role, 'status', status, 'rule', decision_rule, 'evidence', evidence, 'sup', superseded_by_id)), '{}'::jsonb)
    INTO v_have
    FROM ingest.artist_genres
   WHERE artist_id = p_artist AND source_kind = 'albums' AND decision_kind = 'rule';

  -- Cuántas filas cambian (también sirve sin aplicar: `crv doctor`).
  FOR v_key IN SELECT jsonb_object_keys(v_have) LOOP
    IF NOT v_want ? v_key THEN v_changes := v_changes + 1; END IF;
  END LOOP;
  FOR v_key IN SELECT jsonb_object_keys(v_want) LOOP
    IF NOT v_have ? v_key
       OR v_have -> v_key ->> 'role' IS DISTINCT FROM v_want -> v_key ->> 'role'
       OR v_have -> v_key ->> 'status' <> 'confirmed'
       OR v_have -> v_key ->> 'rule' IS DISTINCT FROM v_want -> v_key ->> 'rule'
       OR v_have -> v_key -> 'evidence' IS DISTINCT FROM v_want -> v_key -> 'evidence'
       OR jsonb_typeof(v_have -> v_key -> 'sup') <> 'null' THEN
      v_changes := v_changes + 1;
    END IF;
  END LOOP;

  IF NOT p_apply OR v_changes = 0 THEN
    RETURN v_changes;
  END IF;

  -- 1. Fuera lo que ningún disco sostiene ya.
  DELETE FROM ingest.artist_genres
   WHERE artist_id = p_artist AND source_kind = 'albums' AND decision_kind = 'rule'
     AND NOT v_want ? genre_id::TEXT;
  -- 2. Un principal derivado que deja de serlo se suelta antes (índice único inmediato).
  UPDATE ingest.artist_genres SET role = 'secondary', updated_at = now()
   WHERE artist_id = p_artist AND source_kind = 'albums' AND decision_kind = 'rule'
     AND role = 'primary' AND genre_id IS DISTINCT FROM v_primary;
  -- 3. Altas y cambios.
  FOR v_key IN SELECT jsonb_object_keys(v_want) LOOP
    IF v_have ? v_key THEN
      UPDATE ingest.artist_genres
         SET role = v_want -> v_key ->> 'role', status = 'confirmed', superseded_by_id = NULL,
             decision_rule = v_want -> v_key ->> 'rule', evidence = v_want -> v_key -> 'evidence',
             decided_at = now(), updated_at = now()
       WHERE id = (v_have -> v_key ->> 'id')::BIGINT
         AND (role IS DISTINCT FROM v_want -> v_key ->> 'role' OR status <> 'confirmed' OR superseded_by_id IS NOT NULL
              OR decision_rule IS DISTINCT FROM v_want -> v_key ->> 'rule' OR evidence IS DISTINCT FROM v_want -> v_key -> 'evidence');
    ELSE
      INSERT INTO ingest.artist_genres(artist_id, genre_id, role, status, confidence, source_kind, evidence,
                                       decided_by, decision_rule, decision_kind)
      VALUES (p_artist, v_key::BIGINT, v_want -> v_key ->> 'role', 'confirmed', 'medium', 'albums', v_want -> v_key -> 'evidence',
              'sistema:discos-del-artista', v_want -> v_key ->> 'rule', 'rule')
      ON CONFLICT (artist_id, genre_id) DO NOTHING;
    END IF;
  END LOOP;
  RETURN v_changes;
END
$fn$;

COMMENT ON FUNCTION ingest.crv_derive_artist_genres(BIGINT, BOOLEAN) IS
  'Recalcula los géneros que un artista recibe de sus discos (0036). Con p_apply=false solo cuenta las filas que cambiarían.';

-- ---------------------------------------------------------------------------
-- Disparadores: anotar al artista afectado y recalcularlo al confirmar
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION ingest.crv_artist_genres_mark() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  v_ids BIGINT[] := ARRAY[]::BIGINT[];
BEGIN
  IF current_setting('crv.artist_genres_from_albums', true) = 'off' THEN
    RETURN NULL;
  END IF;
  IF TG_TABLE_NAME = 'album_genres' THEN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
      v_ids := v_ids || (SELECT al.artist_id FROM public.albums al WHERE al.id = OLD.album_id);
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') THEN
      v_ids := v_ids || (SELECT al.artist_id FROM public.albums al WHERE al.id = NEW.album_id);
    END IF;
  ELSIF TG_TABLE_NAME = 'artist_genres' THEN
    -- Las filas de la propia regla no se anotan (sería un bucle); el género
    -- propio sí: ganarlo o perderlo cambia lo que se deriva.
    IF TG_OP IN ('UPDATE', 'DELETE') AND NOT (OLD.source_kind = 'albums' AND OLD.decision_kind = 'rule') THEN
      v_ids := v_ids || OLD.artist_id;
    END IF;
    IF TG_OP IN ('INSERT', 'UPDATE') AND NOT (NEW.source_kind = 'albums' AND NEW.decision_kind = 'rule') THEN
      v_ids := v_ids || NEW.artist_id;
    END IF;
  ELSE  -- public.albums: se borró o cambió de artista
    v_ids := v_ids || OLD.artist_id;
    IF TG_OP = 'UPDATE' THEN
      v_ids := v_ids || NEW.artist_id;
    END IF;
  END IF;
  INSERT INTO ingest.artist_genres_pending(artist_id)
  SELECT DISTINCT id FROM unnest(v_ids) AS id WHERE id IS NOT NULL
  ON CONFLICT (artist_id) DO NOTHING;
  RETURN NULL;
END
$fn$;

CREATE OR REPLACE FUNCTION ingest.crv_artist_genres_flush() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  DELETE FROM ingest.artist_genres_pending WHERE artist_id = NEW.artist_id;
  IF FOUND THEN
    PERFORM ingest.crv_derive_artist_genres(NEW.artist_id, true);
  END IF;
  RETURN NULL;
END
$fn$;

DROP TRIGGER IF EXISTS crv_artist_genres_from_albums ON ingest.album_genres;
CREATE TRIGGER crv_artist_genres_from_albums
  AFTER INSERT OR UPDATE OR DELETE ON ingest.album_genres
  FOR EACH ROW EXECUTE FUNCTION ingest.crv_artist_genres_mark();

DROP TRIGGER IF EXISTS crv_artist_genres_from_albums ON ingest.artist_genres;
CREATE TRIGGER crv_artist_genres_from_albums
  AFTER INSERT OR UPDATE OR DELETE ON ingest.artist_genres
  FOR EACH ROW EXECUTE FUNCTION ingest.crv_artist_genres_mark();

-- Quinta excepción al core: solo anota; no cambia columnas ni datos de public.
DROP TRIGGER IF EXISTS crv_artist_genres_from_albums ON public.albums;
CREATE TRIGGER crv_artist_genres_from_albums
  AFTER DELETE OR UPDATE OF artist_id ON public.albums
  FOR EACH ROW EXECUTE FUNCTION ingest.crv_artist_genres_mark();

DROP TRIGGER IF EXISTS crv_artist_genres_flush ON ingest.artist_genres_pending;
CREATE CONSTRAINT TRIGGER crv_artist_genres_flush
  AFTER INSERT ON ingest.artist_genres_pending
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION ingest.crv_artist_genres_flush();

COMMIT;
