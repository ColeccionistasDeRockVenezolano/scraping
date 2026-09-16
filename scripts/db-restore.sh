#!/usr/bin/env bash
# CRV · db:restore — restaura un backup de scripts/db-backup.sh (PHASES E11).
#
#   uso: scripts/db-restore.sh <backups/crv-...> [--container NOMBRE] [--database NOMBRE] [--data-dir DIR]
#
# Por diseño NUNCA sobrescribe ni borra nada:
#   * si la base destino ya existe en el contenedor, se detiene (renombra la
#     vieja primero: ALTER DATABASE crv RENAME TO crv_antes_AAAAMMDD);
#   * si <data-dir>/raw ya existe y no está vacío, se detiene.
# La base se crea con la codificación y el locale del manifest (SQL_ASCII, C):
# restaurar en UTF8 rompería bytes que el core guarda tal como llegaron.
#
# scripts/db-restore-check.sh usa este mismo script contra un contenedor
# desechable: el camino probado es el mismo que el de una recuperación real.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

BACKUP="${1:-}"
[[ -n "$BACKUP" && -d "$BACKUP" ]] || fail "uso: scripts/db-restore.sh <backups/crv-...> [--container NOMBRE] [--database NOMBRE] [--data-dir DIR]"
BACKUP="$(cd "$BACKUP" && pwd)"
shift
CONTAINER="${CRV_PG_CONTAINER:-crv-postgres}"
DATABASE=""
DATA_DIR_="$ROOT/data"
while (( $# > 0 )); do
  case "$1" in
    --container) CONTAINER="${2:?--container requiere un nombre}"; shift 2 ;;
    --database) DATABASE="${2:?--database requiere un nombre}"; shift 2 ;;
    --data-dir) DATA_DIR_="${2:?--data-dir requiere un directorio}"; shift 2 ;;
    *) fail "argumento desconocido: $1" ;;
  esac
done

manifest() { grep -m1 "^$1=" "$BACKUP/manifest.txt" | cut -d= -f2-; }
[[ "$(manifest format)" == "crv-backup-1" ]] || fail "$BACKUP no parece un backup de scripts/db-backup.sh (manifest.txt)"
OWNER="${CRV_PG_USER:-$(manifest db_owner)}"
DATABASE="${DATABASE:-$(manifest db_name)}"
[[ "$DATABASE" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "nombre de base inválido: $DATABASE"
[[ "$OWNER" =~ ^[a-z_][a-z0-9_]*$ ]] || fail "rol inválido: $OWNER"
psql_admin() { docker exec "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$OWNER" -d postgres -tA "$@"; }

say "1/4 integridad del backup"
(cd "$BACKUP" && sha256sum -c SHA256SUMS)

say "2/4 destino"
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true || fail "el contenedor $CONTAINER no está corriendo"
if [[ "$(psql_admin -c "SELECT count(*) FROM pg_database WHERE datname='$DATABASE'")" != "0" ]]; then
  fail "la base $DATABASE ya existe en $CONTAINER. Este script no borra datos: renómbrala (ALTER DATABASE $DATABASE RENAME TO ${DATABASE}_antes_$(date +%Y%m%d)) o usa --database otro_nombre."
fi
if [[ -d "$DATA_DIR_/raw" ]] && [[ -n "$(ls -A "$DATA_DIR_/raw" 2>/dev/null)" ]]; then
  fail "$DATA_DIR_/raw ya existe y no está vacío. Muévelo antes o usa --data-dir otro_directorio."
fi
echo "   contenedor=$CONTAINER base=$DATABASE data-dir=$DATA_DIR_"

say "3/4 base de datos"
encoding="$(manifest db_encoding)"; collate="$(manifest db_collate)"; ctype="$(manifest db_ctype)"
psql_admin -c "CREATE DATABASE \"$DATABASE\" WITH TEMPLATE template0 OWNER \"$OWNER\" ENCODING '$encoding' LC_COLLATE '$collate' LC_CTYPE '$ctype'" >/dev/null
docker exec -i "$CONTAINER" pg_restore -U "$OWNER" -d "$DATABASE" --exit-on-error < "$BACKUP/crv.dump"
echo "   pg_restore completado ($(manifest tables) tablas, $(manifest rows_total) filas en el origen)"

say "4/4 crudo"
mkdir -p "$DATA_DIR_"
tar -C "$DATA_DIR_" -xzf "$BACKUP/raw.tar.gz"
echo "   data/raw restaurado en $DATA_DIR_/raw ($(find "$DATA_DIR_/raw" -type f | wc -l | tr -d ' ') archivos)"
echo "   verifica con: DATABASE_URL=postgresql://<usuario>:<pass>@<host>:<puerto>/$DATABASE npm run doctor"
