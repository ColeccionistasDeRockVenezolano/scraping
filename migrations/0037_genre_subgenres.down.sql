-- ============================================================================
-- CRV · Migración 0037_genre_subgenres (DOWN)
-- Vuelve a dos niveles. Se niega si quedan subgéneros: antes hay que
-- desactivarlos o moverlos (`crv genres deactivate` / taxonomy-apply).
-- ============================================================================

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM ingest.genres WHERE level = 'subgenre') THEN
    RAISE EXCEPTION 'hay subgéneros en ingest.genres: quítalos antes de bajar la 0037';
  END IF;
END $$;

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

DROP VIEW IF EXISTS ingest.genre_lineage;

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

ALTER TABLE ingest.genres DROP CONSTRAINT IF EXISTS genres_level_chk;
ALTER TABLE ingest.genres ADD CONSTRAINT genres_level_chk CHECK (level IN ('family','genre'));

COMMIT;
