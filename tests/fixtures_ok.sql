-- ============================================================================
-- CRV · Fixtures válidos para probar las migraciones auxiliares.
-- Datos SINTÉTICOS de prueba (no son afirmaciones reales sobre la música).
-- Se asume base fresca: core + migraciones 0001..0003 aplicadas, sin datos.
-- Los IDs usados son deterministas por orden de inserción.
-- ============================================================================

BEGIN;

-- --- fuentes (2) ------------------------------------------------------------
INSERT INTO ingest.sources (slug, name, url, site_type, trust_level, enabled)
VALUES ('rockzuela', 'Rockzuela', 'https://rockzuela.blogspot.com/', 'blogspot', 'medium', true),
       ('yt_master_seed', 'YT Master Spreadsheet (seed)', NULL, 'spreadsheet', 'high', true);

-- --- run + página cruda + error --------------------------------------------
INSERT INTO ingest.scrape_runs (kind, source_id, status, params, counters)
VALUES ('scrape_source', 1, 'ok', '{"limit":10}', '{"fetched":1,"errors":1}');
UPDATE ingest.scrape_runs SET finished_at = now() WHERE id = 1;

INSERT INTO ingest.raw_pages
  (source_id, url, canonical_url, http_status, content_type, sha256, byte_size,
   stored_path, fetched_at, headers)
VALUES (1,
        'https://rockzuela.blogspot.com/2020/01/ejemplo.html',
        'https://rockzuela.blogspot.com/2020/01/ejemplo.html',
        200, 'text/html; charset=UTF-8',
        'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        1024, '/data/raw/rockzuela/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.html',
        now(), '{"server":"GSE"}'::jsonb);

INSERT INTO ingest.scrape_errors (run_id, url, error_kind, message, retry_count)
VALUES (1, 'https://rockzuela.blogspot.com/p/roto', 'http_error', 'HTTP 404', 1);

-- --- seed (1 fila) ----------------------------------------------------------
INSERT INTO ingest.seed_uploads
  (upload_order, artist_name_raw, album_name_raw, album_year_raw, type_raw,
   url_raw, status_raw, video_id, row_number, row_hash, run_id)
VALUES (28, 'Caramelos De Cianuro', 'Las Paticas De La Abuela', 1992, 'EP',
        'https://www.youtube.com/watch?v=Q-pRpO2sYSI&t=11s', NULL,
        'Q-pRpO2sYSI', 68,
        'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 1);

-- --- géneros (configurables) ------------------------------------------------
INSERT INTO ingest.genres (name) VALUES ('Rock'), ('Heavy Metal'), ('Rumba');

-- --- entidades core (fixtures) ----------------------------------------------
INSERT INTO public.artists (name, artist_type, origin_city)
VALUES ('Caramelos De Cianuro', 'band', 'Caracas'),
       ('Caramelos De Cyanuro', 'band', NULL);          -- duplicado sintético

INSERT INTO public.persons (name, nationality, is_venezuelan)
VALUES ('Persona Prueba', 'Venezuela', true);

INSERT INTO public.organizations (name, organization_type, country)
VALUES ('Sello Prueba', 'record_label', 'Venezuela');

INSERT INTO public.albums (artist_id, title, release_year, album_type, youtube_url)
VALUES (1, 'Las Paticas De La Abuela', 1992, 'ep', 'https://www.youtube.com/watch?v=Q-pRpO2sYSI'),
       (1, 'En Vivo', 2009, 'live_album', 'https://youtu.be/1ij7EFYxRlc'),
       (1, 'Frisbee', 2002, 'studio_album', NULL);

INSERT INTO public.tracks (album_id, disc_number, track_number, title, duration_seconds)
VALUES (1, 1, 1, 'Track Uno', 180),
       (1, 1, 2, 'Track Dos', 200),
       (2, 1, 1, 'En Vivo Track Uno', 240);

-- --- videos YouTube (3) -----------------------------------------------------
INSERT INTO media.youtube_videos (video_id, url, title, channel_id, published_at,
                                  duration_seconds, publication_status)
VALUES ('Q-pRpO2sYSI', 'https://www.youtube.com/watch?v=Q-pRpO2sYSI',
        'Las Paticas De La Abuela (Full Album)', 'UCtest01', '2015-01-01T00:00:00Z',
        1500, 'published'),
       ('1ij7EFYxRlc', 'https://youtu.be/1ij7EFYxRlc',
        'Caramelos De Cianuro - En Vivo', 'UCtest01', '2016-01-01T00:00:00Z',
        7200, 'published'),
       ('CI31AGZQe0c', 'https://youtu.be/CI31AGZQe0c',
        'Live Sessions At Equilibrio.Net', 'UCtest02', '2017-01-01T00:00:00Z',
        3600, 'unlisted');

-- --- claims: valores contradictorios conservados simultáneamente ------------
INSERT INTO ingest.claims
  (source_id, raw_page_id, seed_upload_id, entity_kind, album_id, field, raw_value,
   normalized_value, raw_hash, extractor, extractor_version, confidence,
   status, created_by, run_id)
VALUES
  (1, 1, NULL, 'album', 1, 'release_year',
   '{"year":1993}'::jsonb, '{"year":1993}'::jsonb,
   '1111111111111111111111111111111111111111111111111111111111111111',
   'blogger', '0.1.0', 'medium', 'conflict', 'system', 1),
  (2, NULL, 1, 'album', 1, 'release_year',
   '{"year":1992}'::jsonb, '{"year":1992}'::jsonb,
   '2222222222222222222222222222222222222222222222222222222222222222',
   'yt_seed', '0.1.0', 'high', 'accepted', 'system', 1);

-- claim propuesta (sin FK: entidad todavía no canónica)
INSERT INTO ingest.claims
  (source_id, raw_page_id, entity_kind, field, raw_value, raw_hash,
   extractor, confidence, status, created_by, run_id)
VALUES
  (1, 1, 'artist', 'name',
   '{"name":"Nueva Banda XYZ"}'::jsonb,
   '3333333333333333333333333333333333333333333333333333333333333333',
   'blogger', 'low', 'candidate', 'system', 1);

-- claim sobre persona (bio, low, ai) y claim sobre video (youtube_video)
INSERT INTO ingest.claims
  (source_id, raw_page_id, entity_kind, person_id, field, raw_value, raw_hash,
   extractor, confidence, status, created_by)
VALUES
  (1, 1, 'person', 1, 'biography',
   '{"biography":"Texto largo sin revisar..."}'::jsonb,
   '4444444444444444444444444444444444444444444444444444444444444444',
   'blogger', 'low', 'candidate', 'ai');

INSERT INTO ingest.claims
  (source_id, raw_page_id, entity_kind, video_id, field, raw_value, raw_hash,
   extractor, confidence, status, created_by)
VALUES
  (1, 1, 'youtube_video', 1, 'title',
   '{"title":"Las Paticas De La Abuela (Full Album)"}'::jsonb,
   '5555555555555555555555555555555555555555555555555555555555555555',
   'blogger', 'low', 'candidate', 'system');

-- --- evidencias --------------------------------------------------------------
INSERT INTO ingest.claim_evidence (claim_id, raw_page_id, url, excerpt, selector, position, evidence_hash)
VALUES (1, 1, 'https://rockzuela.blogspot.com/2020/01/ejemplo.html',
        '...lanzado en 1993...', '.post-body', 3,
        '6666666666666666666666666666666666666666666666666666666666666661'),
       (2, NULL, NULL, NULL, NULL, NULL,
        '6666666666666666666666666666666666666666666666666666666666666662');
UPDATE ingest.claim_evidence SET seed_upload_id = 1 WHERE id = 2;

-- --- conflicto: ambas afirmaciones + snapshots -------------------------------
INSERT INTO ingest.conflicts (claim_a_id, claim_b_id, entity_kind, field,
                              value_a, value_b, status)
VALUES (1, 2, 'album', 'release_year',
        '{"year":1993}'::jsonb, '{"year":1992}'::jsonb, 'open');

-- --- review queue (varios kinds) ---------------------------------------------
INSERT INTO ingest.review_queue (kind, status, priority, claim_a_id, claim_b_id, conflict_id)
VALUES ('field_conflict', 'open', 8, 1, 2, 1);

INSERT INTO ingest.review_queue (kind, status, priority, artist_a_id, artist_b_id)
VALUES ('possible_duplicate', 'open', 7, 1, 2);

INSERT INTO ingest.review_queue (kind, status, priority, claim_a_id, video_id, album_id)
VALUES ('youtube_match', 'open', 6, 5, 1, 1);

INSERT INTO ingest.review_queue (kind, status, priority, claim_a_id, payload)
VALUES ('manual_review', 'open', 3, 4, '{"note":"bio generada por IA"}'::jsonb);

INSERT INTO ingest.review_queue (kind, status, priority, claim_a_id, payload)
VALUES ('ambiguous_alias', 'open', 5, 3, '{"alias_candidates":["CDC","Caramelos de Cianuro"]}'::jsonb);

-- --- aliases (5 entidades) ---------------------------------------------------
INSERT INTO ingest.artist_aliases (artist_id, alias, alias_type, normalized_alias, is_primary, confidence, source_id)
VALUES (1, 'CDC', 'acronym', 'cdc', true, 'high', 1),
       (1, 'Caramelos De Cianuro Oficial', 'name_variant', 'caramelos de cianuro oficial', false, 'medium', 1);

INSERT INTO ingest.person_aliases (person_id, alias, alias_type, normalized_alias, confidence, source_id)
VALUES (1, 'Asier', 'stage_name', 'asier', 'medium', 1);

INSERT INTO ingest.organization_aliases (organization_id, alias, alias_type, normalized_alias, confidence, source_id)
VALUES (1, 'Sello P', 'acronym', 'sello p', 'medium', 1);

INSERT INTO ingest.album_aliases (album_id, alias, alias_type, normalized_alias, confidence, source_id)
VALUES (1, 'Las Paticas de la Abuela', 'spelling_variant', 'las paticas de la abuela', 'high', 1);

INSERT INTO ingest.track_aliases (track_id, alias, alias_type, normalized_alias, confidence, source_id)
VALUES (1, 'Track Uno (Version Alterna)', 'name_variant', 'track uno version alterna', 'low', 1);

-- --- merge audit + fuentes del cambio ----------------------------------------
INSERT INTO ingest.merge_audit (run_id, entity_kind, album_id, field, old_value,
                                new_value, reason, confidence, performed_by)
VALUES (1, 'album', 1, 'release_year', NULL, '{"year":1992}'::jsonb,
        'seed high confidence (yt_master_seed)', 'high', 'system');

INSERT INTO ingest.merge_audit_claims (merge_audit_id, claim_id) VALUES (1, 2);

-- --- relaciones N:N de media -------------------------------------------------
-- Un álbum con MÚLTIPLES videos (álbum 2 → videos 2 y 3); video 2 es el
-- enlace principal (proyecta albums.youtube_url, ya coherente con el core).
INSERT INTO media.video_albums (video_id, album_id, album_kind, is_primary_link, confidence, source_id)
VALUES (1, 1, 'full_album', true,  'high',   2),
       (2, 2, 'live_concert', true, 'high',   2),
       (3, 2, 'other',        false,'medium', 1);

INSERT INTO media.video_artists (video_id, artist_id, relation_kind, confidence, source_id)
VALUES (1, 1, 'performer', 'high', 2),
       (2, 1, 'performer', 'high', 2),
       (3, 1, 'performer', 'medium', 1);

-- Ocurrencias de tracks en videos. La MISMA canción (track 1) aparece en DOS
-- videos distintos: el core tracks.youtube_start_seconds no es la única
-- fuente de timestamps.
INSERT INTO media.video_tracks (video_id, track_id, start_seconds, end_seconds, confidence, source_id)
VALUES (1, 1, 0,   200, 'high', 2),
       (1, 2, 200, NULL, 'high', 2),
       (2, 3, 0,   NULL, 'medium', 1),
       (2, 1, 0,   NULL, 'low', 1);

-- --- media_links (URL + fuente + metadatos, sin descarga masiva) -------------
INSERT INTO media.media_links (entity_kind, album_id, url, media_type, source_id, meta)
VALUES ('album', 1, 'https://rockzuela.blogspot.com/img/portada.jpg', 'cover', 1,
        '{"title":"portada Las Paticas"}'::jsonb);

COMMIT;
