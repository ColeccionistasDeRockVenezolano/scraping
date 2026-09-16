#!/usr/bin/env bash
# CRV · db:restore-check — prueba que un backup se restaura de verdad (PHASES E11).
#
#   uso: scripts/db-restore-check.sh <backups/crv-...>
#
# Levanta un PostgreSQL DESECHABLE en 127.0.0.1 (misma imagen que crv-postgres),
# restaura con scripts/db-restore.sh —el mismo camino que una recuperación
# real— y verifica, sin tocar la base de desarrollo ni data/raw:
#   1. codificación y locale iguales a los del origen;
#   2. filas exactas por tabla idénticas a counts.tsv;
#   3. cada ingest.raw_pages.stored_path existe en el crudo restaurado y su
#      sha256 coincide con el registrado;
#   4. `doctor` en verde contra la base restaurada.
# El contenedor y el directorio temporal se eliminan al salir, pase lo que pase.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

BACKUP="${1:-}"
[[ -n "$BACKUP" && -d "$BACKUP" ]] || fail "uso: scripts/db-restore-check.sh <backups/crv-...>"
BACKUP="$(cd "$BACKUP" && pwd)"
manifest() { grep -m1 "^$1=" "$BACKUP/manifest.txt" | cut -d= -f2-; }

IMAGE="${CRV_RESTORE_IMAGE:-$(docker inspect -f '{{.Config.Image}}' crv-postgres 2>/dev/null || echo postgres:16-alpine)}"
NAME="crv-restore-check-$$"
PORT="${CRV_RESTORE_PORT:-55498}"
PASSWORD="restore-check-$$"
OWNER="$(manifest db_owner)"
DATABASE="$(manifest db_name)"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/crv-restore-check.XXXXXX")"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

say "1/5 PostgreSQL desechable ($IMAGE en 127.0.0.1:$PORT)"
docker run -d --name "$NAME" -e POSTGRES_USER="$OWNER" -e POSTGRES_PASSWORD="$PASSWORD" -e POSTGRES_DB=postgres \
  -p "127.0.0.1:$PORT:5432" "$IMAGE" >/dev/null
# Por TCP: el servidor temporal del entrypoint solo escucha en el socket.
ready=no
for _ in $(seq 1 90); do
  if docker exec "$NAME" pg_isready -h 127.0.0.1 -U "$OWNER" -d postgres >/dev/null 2>&1; then ready=yes; break; fi
  sleep 1
done
[[ "$ready" == yes ]] || fail "el contenedor desechable no quedó listo"

say "2/5 restauración"
"$ROOT/scripts/db-restore.sh" "$BACKUP" --container "$NAME" --data-dir "$WORK/data"
psql_r() { docker exec -i "$NAME" psql -X -v ON_ERROR_STOP=1 -U "$OWNER" -d "$DATABASE" -tA "$@"; }

say "3/5 codificación y filas por tabla"
IFS='|' read -r encoding collate ctype < <(psql_r -c "SELECT pg_encoding_to_char(encoding)||'|'||datcollate||'|'||datctype FROM pg_database WHERE datname=current_database()")
[[ "$encoding|$collate|$ctype" == "$(manifest db_encoding)|$(manifest db_collate)|$(manifest db_ctype)" ]] \
  || fail "codificación/locale distintos: $encoding/$collate/$ctype"
echo "   $encoding / $collate / $ctype"
psql_r -F $'\t' < scripts/sql/table-counts.sql > "$WORK/counts.tsv"
if ! diff -u "$BACKUP/counts.tsv" "$WORK/counts.tsv"; then fail "las filas restauradas no coinciden con counts.tsv"; fi
echo "   $(wc -l < "$WORK/counts.tsv" | tr -d ' ') tablas, $(awk -F'\t' '{ total += $2 } END { print total }' "$WORK/counts.tsv") filas: idénticas al origen"
[[ "$(psql_r -c "SELECT string_agg(version, ',' ORDER BY version) FROM ingest.schema_migrations")" == "$(manifest migrations)" ]] \
  || fail "las migraciones restauradas no coinciden con el manifest"

say "4/5 crudo: existencia y sha256"
missing=0; mismatched=0; checked=0
while IFS='|' read -r rel sha; do
  [[ -n "$rel" ]] || continue
  checked=$((checked + 1))
  if [[ ! -f "$WORK/data/$rel" ]]; then missing=$((missing + 1)); continue; fi
  [[ "$(sha256sum "$WORK/data/$rel" | cut -d' ' -f1)" == "$sha" ]] || mismatched=$((mismatched + 1))
done < <(psql_r -c "SELECT stored_path||'|'||sha256 FROM ingest.raw_pages")
echo "   $checked raw_pages revisadas; $missing sin archivo; $mismatched con hash distinto"
(( mismatched == 0 )) || fail "hay crudos cuyo contenido no coincide con su sha256"
(( missing == $(manifest raw_missing) )) || fail "faltan $missing crudos (el origen registraba $(manifest raw_missing))"

say "5/5 doctor contra la base restaurada"
DATABASE_URL="postgresql://$OWNER:$PASSWORD@127.0.0.1:$PORT/$DATABASE" npm run --silent doctor

printf '\n\033[1mRESTORE VERIFICADO\033[0m: %s\n' "$BACKUP"
