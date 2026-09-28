#!/usr/bin/env bash
# Volcado SOLO LECTURA (2ª parte): alias y claims de otras fuentes por disco.
set -euo pipefail
cd "$(dirname "$0")"
OUT=tmp-analysis/ingesta-review
PSQL=(docker exec -i crv-postgres psql -U crv -d crv -X -q -A -F $'\t' -t)

"${PSQL[@]}" > "$OUT/core_person_aliases.tsv" <<'SQL'
\copy (SELECT person_id, alias FROM ingest.person_aliases) TO STDOUT
SQL

"${PSQL[@]}" > "$OUT/core_org_aliases.tsv" <<'SQL'
\copy (SELECT organization_id, alias FROM ingest.organization_aliases) TO STDOUT
SQL

# Claims de fuentes NO-YouTube sobre los discos enlazados a los videos de la cola.
"${PSQL[@]}" > "$OUT/sincopa_persons.tsv" <<'SQL'
\copy (WITH low AS (
  SELECT DISTINCT replace(replace(e.url,'https://www.youtube.com/watch?v=',''),'&','') AS vid
    FROM ingest.review_queue r JOIN ingest.claims c ON c.id=r.claim_a_id
    LEFT JOIN ingest.claim_evidence e ON e.claim_id=c.id
   WHERE r.kind='low_confidence' AND r.status='open'),
albums AS (
  SELECT DISTINCT va.album_id FROM media.youtube_videos v JOIN media.video_albums va ON va.video_id=v.id
   WHERE v.video_id IN (SELECT vid FROM low))
SELECT c.id AS claim_id, c.entity_kind, c.field, c.identity_key, c.status, s.slug, c.person_id, c.organization_id, c.album_id, c.album_credit_id, c.track_credit_id
  FROM ingest.claims c JOIN ingest.sources s ON s.id=c.source_id
 WHERE s.slug <> 'youtube-data-api' AND c.album_id IN (SELECT album_id FROM albums)) TO STDOUT
SQL

echo "== conteos =="
wc -l "$OUT"/core_person_aliases.tsv "$OUT"/core_org_aliases.tsv "$OUT"/sincopa_persons.tsv
