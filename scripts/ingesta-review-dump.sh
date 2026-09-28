#!/usr/bin/env bash
# Volcado SOLO LECTURA del estado de la revisión de ingesta pendiente (2026-09-23).
# Genera TSVs en tmp-analysis/ingesta-review/ para el cotejo.
set -euo pipefail
cd "$(dirname "$0")"
OUT=tmp-analysis/ingesta-review
mkdir -p "$OUT"
PSQL=(docker exec -i crv-postgres psql -U crv -d crv -X -q -A -F $'\t' -t)

# 1) Las 1221 revisiones low_confidence abiertas con su claim y evidencia.
"${PSQL[@]}" > "$OUT/lowconf.tsv" <<'SQL'
\copy (SELECT r.id AS review_id, c.id AS claim_id, c.entity_kind, c.field, c.identity_key, c.identity_raw, c.status AS claim_status, c.source_id, s.slug AS source_slug, e.url, e.selector, e.excerpt, r.priority, r.created_at FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id JOIN ingest.sources s ON s.id=c.source_id LEFT JOIN ingest.claim_evidence e ON e.claim_id=c.id WHERE r.kind='low_confidence' AND r.status='open' ORDER BY r.id) TO STDOUT
SQL

# 2) URLs de video involucradas
"${PSQL[@]}" > "$OUT/urls.tsv" <<'SQL'
\copy (WITH low AS (SELECT DISTINCT e.url FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id LEFT JOIN ingest.claim_evidence e ON e.claim_id=c.id WHERE r.kind='low_confidence' AND r.status='open') SELECT url FROM low) TO STDOUT
SQL

# 3) Siblings: TODOS los claims cuya evidencia apunta a esas URLs (cualquier estado, cualquier fuente).
"${PSQL[@]}" > "$OUT/siblings.tsv" <<'SQL'
\copy (WITH low AS (SELECT DISTINCT e.url FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id LEFT JOIN ingest.claim_evidence e ON e.claim_id=c.id WHERE r.kind='low_confidence' AND r.status='open') SELECT DISTINCT c.id AS claim_id, c.entity_kind, c.field, c.identity_key, c.status, c.source_id, s.slug, c.created_by, c.person_id, c.organization_id, c.album_id, c.track_id, c.album_credit_id, c.track_credit_id, e.url, e.selector, replace(replace(left(e.excerpt,220), E'\t',' '), E'\n',' ') AS excerpt FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id JOIN ingest.claim_evidence e ON e.claim_id=c.id WHERE e.url IN (SELECT url FROM low) ORDER BY c.id) TO STDOUT
SQL

# 4) video -> discos
"${PSQL[@]}" > "$OUT/video_albums.tsv" <<'SQL'
\copy (WITH low AS (SELECT DISTINCT replace(replace(e.url,'https://www.youtube.com/watch?v=',''),'&','') AS vid FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id LEFT JOIN ingest.claim_evidence e ON e.claim_id=c.id WHERE r.kind='low_confidence' AND r.status='open') SELECT v.video_id, v.id AS vid_pk, v.title, va.album_id, a.title AS album_title, ar.name AS artist_name, va.is_primary_link, va.album_kind FROM media.youtube_videos v LEFT JOIN media.video_albums va ON va.video_id=v.id LEFT JOIN public.albums a ON a.id=va.album_id LEFT JOIN public.artists ar ON ar.id=a.artist_id WHERE v.video_id IN (SELECT vid FROM low)) TO STDOUT
SQL

# 5) claims del canal (youtube-data-api) ya aceptados/rechazados con esas URLs -> contexto de decisiones previas
"${PSQL[@]}" > "$OUT/core_persons.tsv" <<'SQL'
\copy (SELECT p.id, p.name, p.is_venezuelan, (SELECT count(*) FROM public.album_credits ac WHERE ac.person_id=p.id) AS album_credits, (SELECT count(*) FROM public.track_credits tc WHERE tc.person_id=p.id) AS track_credits, (SELECT count(*) FROM public.artist_members m WHERE m.person_id=p.id) AS bands FROM public.persons p) TO STDOUT
SQL

"${PSQL[@]}" > "$OUT/core_person_aliases.tsv" <<'SQL'
\copy (SELECT person_id, alias FROM public.person_aliases) TO STDOUT
SQL

"${PSQL[@]}" > "$OUT/core_orgs.tsv" <<'SQL'
\copy (SELECT o.id, o.name, o.organization_type, o.country, (SELECT count(*) FROM public.album_credits ac WHERE ac.organization_id=o.id) AS album_credits FROM public.organizations o) TO STDOUT
SQL

"${PSQL[@]}" > "$OUT/core_org_aliases.tsv" <<'SQL'
\copy (SELECT organization_id, alias FROM public.organization_aliases) TO STDOUT
SQL

# 6) claims de otras fuentes (sincopa etc.) para los discos involucrados: personas acreditadas
"${PSQL[@]}" > "$OUT/sincopa_persons.tsv" <<'SQL'
\copy (WITH low AS (SELECT DISTINCT replace(replace(e.url,'https://www.youtube.com/watch?v=',''),'&','') AS vid FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id LEFT JOIN ingest.claim_evidence e ON e.claim_id=c.id WHERE r.kind='low_confidence' AND r.status='open'), albums AS (SELECT DISTINCT va.album_id FROM media.youtube_videos v JOIN media.video_albums va ON va.video_id=v.id WHERE v.video_id IN (SELECT vid FROM low)) SELECT DISTINCT c.id AS claim_id, c.entity_kind, c.field, c.identity_key, c.status, c.source_id, s.slug, c.person_id, c.organization_id, c.album_id, c.album_credit_id, c.track_credit_id FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id WHERE c.source_id NOT IN (SELECT id FROM ingest.sources WHERE slug IN ('youtube-data-api')) AND (c.album_id IN (SELECT album_id FROM albums) OR EXISTS (SELECT 1 FROM ingest.claims c2 WHERE c2.id=c.id)) ORDER BY c.entity_kind, c.identity_key) TO STDOUT
SQL

# 7) Resumen de conteos por identidad (agrupado)
"${PSQL[@]}" > "$OUT/resumen_identidades.tsv" <<'SQL'
\copy (SELECT c.entity_kind, c.field, c.identity_key, count(*) AS reviews FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id WHERE r.kind='low_confidence' AND r.status='open' GROUP BY 1,2,3 ORDER BY 1,2,4 DESC,3) TO STDOUT
SQL

# 8) genre_unknown completas
"${PSQL[@]}" > "$OUT/genre_unknown.tsv" <<'SQL'
\copy (SELECT r.id, r.payload->>'entityKind' AS entity_kind, (r.payload->>'entityId') AS entity_id, r.payload->>'rawValue' AS raw_value, r.payload->>'genreCase' AS genre_case, r.payload->>'sourceSlug' AS source_slug, r.payload->'unresolved' AS unresolved, r.payload->>'primaryPending' AS primary_pending, r.album_id, r.artist_a_id, r.track_id, r.created_at FROM ingest.review_queue r WHERE r.kind='genre_unknown' AND r.status='open' ORDER BY r.id) TO STDOUT
SQL

echo "== conteos =="
wc -l "$OUT"/*.tsv
