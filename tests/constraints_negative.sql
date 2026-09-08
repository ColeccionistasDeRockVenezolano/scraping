-- ============================================================================
-- CRV · Tests negativos de constraints y FKs sobre las migraciones auxiliares.
-- Cada caso va en un DO block: si la operación NO falla, el test falla en
-- voz alta (RAISE EXCEPTION); si falla con el SQLSTATE esperado, imprime PASS.
-- Se ejecuta tras fixtures_ok.sql (IDs referenciados: ver fixtures).
-- ============================================================================

\set QUIET 1

-- N1: claims con DOS destinos a la vez (viola exactly-one)
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.claims (source_id, entity_kind, artist_id, album_id, field,
                               raw_value, raw_hash, confidence)
    VALUES (1, 'artist', 1, 1, 'name', '{"name":"x"}'::jsonb,
            '7777777777777777777777777777777777777777777777777777777777777777', 'low');
    RAISE EXCEPTION 'FAIL N1: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N1 claims dos destinos';
  END;
END $$;

-- N2: claims con FK que no coincide con entity_kind
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.claims (source_id, entity_kind, artist_id, field,
                               raw_value, raw_hash)
    VALUES (1, 'album', 1, 'title', '{"title":"x"}'::jsonb,
            '7777777777777777777777777777777777777777777777777777777777777778');
    RAISE EXCEPTION 'FAIL N2: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N2 claims kind/FK incoherente';
  END;
END $$;

-- N3: claims duplicado (dedupe por source+page+kind+entidad+field+raw_hash)
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.claims (source_id, raw_page_id, entity_kind, album_id, field,
                               raw_value, normalized_value, raw_hash, extractor,
                               confidence, status)
    VALUES (1, 1, 'album', 1, 'release_year',
            '{"year":1993}'::jsonb, '{"year":1993}'::jsonb,
            '1111111111111111111111111111111111111111111111111111111111111111',
            'blogger', 'medium', 'conflict');
    RAISE EXCEPTION 'FAIL N3: se esperaba unique_violation';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS N3 claims dedupe';
  END;
END $$;

-- N4: alias duplicado para el mismo artista
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.artist_aliases (artist_id, alias, normalized_alias)
    VALUES (1, 'CDC', 'cdc');
    RAISE EXCEPTION 'FAIL N4: se esperaba unique_violation';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS N4 alias duplicado';
  END;
END $$;

-- N5: segundo alias primario para el mismo artista
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.artist_aliases (artist_id, alias, normalized_alias, is_primary)
    VALUES (1, 'Otro Primario', 'otro primario', true);
    RAISE EXCEPTION 'FAIL N5: se esperaba unique_violation';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS N5 segundo alias primario';
  END;
END $$;

-- N6: segundo enlace principal de video para el mismo álbum
DO $$ BEGIN
  BEGIN
    INSERT INTO media.video_albums (video_id, album_id, album_kind, is_primary_link, confidence)
    VALUES (3, 1, 'other', true, 'high');
    RAISE EXCEPTION 'FAIL N6: se esperaba unique_violation';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS N6 un solo primary por álbum';
  END;
END $$;

-- N7: ocurrencia duplicada (mismo video+track+start)
DO $$ BEGIN
  BEGIN
    INSERT INTO media.video_tracks (video_id, track_id, start_seconds, end_seconds, confidence)
    VALUES (1, 1, 0, 200, 'high');
    RAISE EXCEPTION 'FAIL N7: se esperaba unique_violation';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS N7 ocurrencia duplicada';
  END;
END $$;

-- N8: ocurrencia con end <= start
DO $$ BEGIN
  BEGIN
    INSERT INTO media.video_tracks (video_id, track_id, start_seconds, end_seconds, confidence)
    VALUES (3, 2, 100, 100, 'medium');
    RAISE EXCEPTION 'FAIL N8: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N8 end > start';
  END;
END $$;

-- N9: conflicto consigo mismo
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.conflicts (claim_a_id, claim_b_id, entity_kind, field, value_a, value_b)
    VALUES (1, 1, 'album', 'release_year', '{"year":1993}'::jsonb, '{"year":1992}'::jsonb);
    RAISE EXCEPTION 'FAIL N9: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N9 conflicto claim_a<>claim_b';
  END;
END $$;

-- N10: review_queue con claim_a = claim_b
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.review_queue (kind, claim_a_id, claim_b_id)
    VALUES ('field_conflict', 1, 1);
    RAISE EXCEPTION 'FAIL N10: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N10 review claim_a<>claim_b';
  END;
END $$;

-- N11: merge_audit sin destino
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.merge_audit (entity_kind, field, old_value, new_value, reason, confidence)
    VALUES ('album', 'release_year', '{"year":1993}'::jsonb, '{"year":1992}'::jsonb, 'test', 'high');
    RAISE EXCEPTION 'FAIL N11: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N11 merge_audit exactamente un destino';
  END;
END $$;

-- N12: merge_audit con dos destinos
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.merge_audit (entity_kind, artist_id, album_id, field, old_value, new_value, reason, confidence)
    VALUES ('artist', 1, 1, 'name', '{"name":"a"}'::jsonb, '{"name":"b"}'::jsonb, 'test', 'high');
    RAISE EXCEPTION 'FAIL N12: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N12 merge_audit dos destinos';
  END;
END $$;

-- N13: merge_audit con FK que no coincide con entity_kind
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.merge_audit (entity_kind, artist_id, field, old_value, new_value, reason, confidence)
    VALUES ('album', 1, 'title', '{"title":"a"}'::jsonb, '{"title":"b"}'::jsonb, 'test', 'high');
    RAISE EXCEPTION 'FAIL N13: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N13 merge_audit kind/FK incoherente';
  END;
END $$;

-- N14: merge_audit sin cambio (old = new)
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.merge_audit (entity_kind, album_id, field, old_value, new_value, reason, confidence)
    VALUES ('album', 1, 'release_year', '{"year":1992}'::jsonb, '{"year":1992}'::jsonb, 'test', 'high');
    RAISE EXCEPTION 'FAIL N14: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N14 merge_audit old<>new';
  END;
END $$;

-- N15: FK de claims a video inexistente
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.claims (source_id, entity_kind, video_id, field, raw_value, raw_hash)
    VALUES (1, 'youtube_video', 999999, 'title', '{"title":"x"}'::jsonb,
            '7777777777777777777777777777777777777777777777777777777777777779');
    RAISE EXCEPTION 'FAIL N15: se esperaba foreign_key_violation';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS N15 FK claims→video';
  END;
END $$;

-- N16: FK de alias a artista inexistente
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.artist_aliases (artist_id, alias, normalized_alias)
    VALUES (999999, 'Fantasma', 'fantasma');
    RAISE EXCEPTION 'FAIL N16: se esperaba foreign_key_violation';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS N16 FK alias→artista';
  END;
END $$;

-- N17: upload_order duplicado en seed_uploads
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.seed_uploads (upload_order, row_hash)
    VALUES (28, 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
    RAISE EXCEPTION 'FAIL N17: se esperaba unique_violation';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS N17 seed upload_order único';
  END;
END $$;

-- N18: video_id de seed con formato inválido
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.seed_uploads (upload_order, video_id, row_hash)
    VALUES (29, 'abc', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd');
    RAISE EXCEPTION 'FAIL N18: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N18 seed video_id 11 chars';
  END;
END $$;

-- N19: scrape_runs con finished_at < started_at
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.scrape_runs (kind, status, started_at, finished_at)
    VALUES ('scrape_source', 'ok', now(), now() - interval '1 day');
    RAISE EXCEPTION 'FAIL N19: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N19 run finished>=started';
  END;
END $$;

-- N20: video_id de youtube_videos con formato inválido
DO $$ BEGIN
  BEGIN
    INSERT INTO media.youtube_videos (video_id) VALUES ('corto');
    RAISE EXCEPTION 'FAIL N20: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N20 video_id 11 chars';
  END;
END $$;

-- N21: publication_status con valor fuera del enum core (sin tocar el enum)
DO $$ BEGIN
  BEGIN
    INSERT INTO media.youtube_videos (video_id, publication_status)
    VALUES ('AAAAAAAAAAA', 'bogus'::public.publication_status);
    RAISE EXCEPTION 'FAIL N21: se esperaba invalid_text_representation';
  EXCEPTION WHEN invalid_text_representation THEN RAISE NOTICE 'PASS N21 enum core respetado';
  END;
END $$;

-- N22: raw_hash de claims con formato inválido
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.claims (source_id, entity_kind, album_id, field, raw_value, raw_hash)
    VALUES (1, 'album', 1, 'genre', '{"genre":"rock"}'::jsonb, 'zzz');
    RAISE EXCEPTION 'FAIL N22: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N22 raw_hash hex64';
  END;
END $$;

-- N23: media_links con dos destinos
DO $$ BEGIN
  BEGIN
    INSERT INTO media.media_links (entity_kind, artist_id, album_id, url)
    VALUES ('artist', 1, 1, 'https://example.com/x.jpg');
    RAISE EXCEPTION 'FAIL N23: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N23 media_links un destino';
  END;
END $$;

-- N24: media_links sin destino
DO $$ BEGIN
  BEGIN
    INSERT INTO media.media_links (entity_kind, url)
    VALUES ('album', 'https://example.com/y.jpg');
    RAISE EXCEPTION 'FAIL N24: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N24 media_links destino obligatorio';
  END;
END $$;

-- N25: video_albums con primary de confianza baja (álbum 3 aún sin primary)
DO $$ BEGIN
  BEGIN
    INSERT INTO media.video_albums (video_id, album_id, album_kind, is_primary_link, confidence)
    VALUES (2, 3, 'other', true, 'low');
    RAISE EXCEPTION 'FAIL N25: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N25 primary no-low';
  END;
END $$;

-- N26: review_queue con prioridad fuera de rango
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.review_queue (kind, priority) VALUES ('manual_review', 0);
    RAISE EXCEPTION 'FAIL N26: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N26 prioridad 1..10';
  END;
END $$;

-- N27: género duplicado
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.genres (name) VALUES ('Rock');
    RAISE EXCEPTION 'FAIL N27: se esperaba unique_violation';
  EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'PASS N27 género único';
  END;
END $$;

-- N28: scrape_errors con error_kind inválido
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.scrape_errors (run_id, url, error_kind, message)
    VALUES (1, 'https://example.com/', 'bogus', 'x');
    RAISE EXCEPTION 'FAIL N28: se esperaba check_violation';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'PASS N28 error_kind válido';
  END;
END $$;

-- N29: claims con source inexistente
DO $$ BEGIN
  BEGIN
    INSERT INTO ingest.claims (source_id, entity_kind, album_id, field, raw_value, raw_hash)
    VALUES (999999, 'album', 1, 'notes', '{"notes":"x"}'::jsonb,
            '7777777777777777777777777777777777777777777777777777777777777780');
    RAISE EXCEPTION 'FAIL N29: se esperaba foreign_key_violation';
  EXCEPTION WHEN foreign_key_violation THEN RAISE NOTICE 'PASS N29 FK claims→source';
  END;
END $$;

\echo '--- fin tests negativos ---'
