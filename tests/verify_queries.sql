-- ============================================================================
-- CRV · Queries de verificación (tras fixtures + tests negativos).
-- Comprueban: conteos, preservación de valores contradictorios, N:N de
-- videos, ocurrencias multi-video, procedencia del merge y estado del core.
-- ============================================================================

SELECT '== 1. Conteos (ingest) ==' AS seccion;
SELECT 'sources' t, count(*) n FROM ingest.sources
UNION ALL SELECT 'raw_pages', count(*) FROM ingest.raw_pages
UNION ALL SELECT 'scrape_runs', count(*) FROM ingest.scrape_runs
UNION ALL SELECT 'scrape_errors', count(*) FROM ingest.scrape_errors
UNION ALL SELECT 'seed_uploads', count(*) FROM ingest.seed_uploads
UNION ALL SELECT 'genres', count(*) FROM ingest.genres
UNION ALL SELECT 'claims', count(*) FROM ingest.claims
UNION ALL SELECT 'claim_evidence', count(*) FROM ingest.claim_evidence
UNION ALL SELECT 'artist_aliases', count(*) FROM ingest.artist_aliases
UNION ALL SELECT 'person_aliases', count(*) FROM ingest.person_aliases
UNION ALL SELECT 'organization_aliases', count(*) FROM ingest.organization_aliases
UNION ALL SELECT 'album_aliases', count(*) FROM ingest.album_aliases
UNION ALL SELECT 'track_aliases', count(*) FROM ingest.track_aliases
UNION ALL SELECT 'conflicts', count(*) FROM ingest.conflicts
UNION ALL SELECT 'review_queue', count(*) FROM ingest.review_queue
UNION ALL SELECT 'merge_audit', count(*) FROM ingest.merge_audit
UNION ALL SELECT 'merge_audit_claims', count(*) FROM ingest.merge_audit_claims
ORDER BY t;

SELECT '== 2. Conteos (media + core) ==' AS seccion;
SELECT 'youtube_videos' t, count(*) n FROM media.youtube_videos
UNION ALL SELECT 'video_artists', count(*) FROM media.video_artists
UNION ALL SELECT 'video_albums', count(*) FROM media.video_albums
UNION ALL SELECT 'video_tracks', count(*) FROM media.video_tracks
UNION ALL SELECT 'media_links', count(*) FROM media.media_links
UNION ALL SELECT 'artists(core)', count(*) FROM public.artists
UNION ALL SELECT 'albums(core)', count(*) FROM public.albums
UNION ALL SELECT 'tracks(core)', count(*) FROM public.tracks
ORDER BY t;

SELECT '== 3. Valores contradictorios conservados simultáneamente ==' AS seccion;
SELECT c.id, s.slug AS fuente, c.field, c.raw_value->>'year' AS year,
       c.confidence, c.status
FROM ingest.claims c JOIN ingest.sources s ON s.id = c.source_id
WHERE c.album_id = 1 AND c.field = 'release_year'
ORDER BY c.id;

SELECT '== 4. Conflicto conserva ambas afirmaciones ==' AS seccion;
SELECT cf.id, cf.field, cf.value_a->>'year' AS valor_a,
       cf.value_b->>'year' AS valor_b, cf.status
FROM ingest.conflicts cf;

SELECT '== 5. Un álbum con MÚLTIPLES videos (N:N) ==' AS seccion;
SELECT a.title AS album, v.video_id, va.album_kind, va.is_primary_link
FROM media.video_albums va
JOIN media.youtube_videos v ON v.id = va.video_id
JOIN public.albums a ON a.id = va.album_id
ORDER BY a.id, va.is_primary_link DESC;

SELECT '== 6. La MISMA canción en VARIOS videos (occurrencias) ==' AS seccion;
SELECT t.title AS track, v.video_id, vt.start_seconds, vt.end_seconds, vt.confidence
FROM media.video_tracks vt
JOIN media.youtube_videos v ON v.id = vt.video_id
JOIN public.tracks t ON t.id = vt.track_id
WHERE t.id = 1
ORDER BY v.video_id;

SELECT '== 7. Procedencia del merge (audit → claims → fuentes) ==' AS seccion;
SELECT ma.id AS audit_id, ma.entity_kind, ma.field,
       ma.old_value, ma.new_value, ma.reason, ma.confidence,
       s.slug AS fuente
FROM ingest.merge_audit ma
JOIN ingest.merge_audit_claims mac ON mac.merge_audit_id = ma.id
JOIN ingest.claims c ON c.id = mac.claim_id
JOIN ingest.sources s ON s.id = c.source_id;

SELECT '== 8. Review queue por kind ==' AS seccion;
SELECT kind, status, count(*) AS n FROM ingest.review_queue GROUP BY kind, status ORDER BY kind;

SELECT '== 9. Evidencia por claim ==' AS seccion;
SELECT ce.claim_id, ce.url, ce.selector, ce.position, ce.seed_upload_id
FROM ingest.claim_evidence ce ORDER BY ce.claim_id;

SELECT '== 10. Claim propuesta (sin FK canónica todavía) ==' AS seccion;
SELECT c.id, c.entity_kind, c.raw_value, c.status
FROM ingest.claims c
WHERE c.artist_id IS NULL AND c.person_id IS NULL AND c.album_id IS NULL
  AND c.track_id IS NULL AND c.video_id IS NULL;

SELECT '== 11. Core intacto: enlace principal albums.youtube_url ==' AS seccion;
SELECT a.id, a.title, a.youtube_url
FROM public.albums a ORDER BY a.id;
