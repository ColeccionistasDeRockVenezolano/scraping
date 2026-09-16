#!/usr/bin/env bash
# CRV · db:backup — respaldo de PostgreSQL y del crudo (PHASES E11).
#
#   backups/crv-<AAAAMMDDTHHMMSSZ>/
#     crv.dump      pg_dump --format=custom de la base completa (core + ingest + media)
#     raw.tar.gz    data/raw tal cual: el HTML/JSON crudo que respalda cada claim
#     counts.tsv    filas exactas por tabla (scripts/sql/table-counts.sql)
#     manifest.txt  commit, hash del core, codificación, migraciones, estado del crudo
#     SHA256SUMS    sumas de los artefactos
#
# Solo lee: no modifica la base ni data/raw. Restaurar: scripts/db-restore.sh;
# probar un backup sin tocar nada: scripts/db-restore-check.sh.
# Guía completa: docs/DATABASE_BACKUP_RESTORE.md.
#
#   uso: scripts/db-backup.sh [directorio-destino]      (por defecto ./backups)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CONTAINER="${CRV_PG_CONTAINER:-crv-postgres}"
PGUSER_="${CRV_PG_USER:-crv}"
PGDB="${CRV_PG_DB:-crv}"
DATA_DIR_="${CRV_DATA_DIR:-$ROOT/data}"
OUT_ROOT="${1:-$ROOT/backups}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FINAL_OUT="$OUT_ROOT/crv-$STAMP"
OUT="$OUT_ROOT/.crv-$STAMP.partial"
complete=no

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
fail() { printf '\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }
psql_q() { docker exec "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$PGUSER_" -d "$PGDB" -tA "$@"; }
table_counts() { docker exec -i "$CONTAINER" psql -X -v ON_ERROR_STOP=1 -U "$PGUSER_" -d "$PGDB" -tA -F $'\t' < scripts/sql/table-counts.sql; }
cleanup() {
  # Un directorio sin manifest/sumas no debe parecer un backup recuperable.
  # OUT siempre es el hijo timestampado `.crv-*.partial`, nunca OUT_ROOT.
  if [[ "$complete" != yes && -d "$OUT" ]]; then rm -rf -- "$OUT"; fi
}
trap cleanup EXIT

say "1/5 comprobaciones previas"
docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -qx true || fail "el contenedor $CONTAINER no está corriendo (npm run db:up)"
[[ -d "$DATA_DIR_/raw" ]] || fail "no existe $DATA_DIR_/raw"
[[ ! -e "$FINAL_OUT" && ! -e "$OUT" ]] || fail "el destino ya existe: $FINAL_OUT"
mkdir -p "$OUT"
echo "   destino final: $FINAL_OUT"

say "2/5 pg_dump (formato custom)"
table_counts > "$OUT/counts.before.tsv"
# El formato custom se transmite directamente al host. Sigue siendo un archivo
# buscable para pg_restore, pero evita mantener una segunda copia de varios GB
# dentro del volumen de Docker mientras se hace el respaldo.
docker exec "$CONTAINER" pg_dump -U "$PGUSER_" -d "$PGDB" --format=custom --compress=zstd:3 > "$OUT/crv.dump"
docker exec -i "$CONTAINER" pg_restore --list < "$OUT/crv.dump" > "$OUT/crv.dump.toc" || fail "pg_restore no puede leer el dump recién creado"
table_counts > "$OUT/counts.tsv"
if ! cmp -s "$OUT/counts.before.tsv" "$OUT/counts.tsv"; then
  diff -u "$OUT/counts.before.tsv" "$OUT/counts.tsv" | head -20 >&2 || true
  rm -rf "$OUT"
  fail "la base cambió mientras se respaldaba (hay una ingestión o una edición en curso). Repite el backup con el catálogo quieto: sin conteos estables el restore no se puede verificar."
fi
rm -f "$OUT/counts.before.tsv"

say "3/5 crudo (data/raw)"
raw_pages="$(psql_q -c "SELECT count(*) FROM ingest.raw_pages")"
raw_missing=0
while IFS= read -r rel; do
  [[ -n "$rel" ]] || continue
  [[ -f "$DATA_DIR_/$rel" ]] || raw_missing=$((raw_missing + 1))
done < <(psql_q -c "SELECT stored_path FROM ingest.raw_pages")
raw_files="$(find "$DATA_DIR_/raw" -type f | wc -l | tr -d ' ')"
tar -C "$DATA_DIR_" -czf "$OUT/raw.tar.gz" raw
echo "   $raw_files archivos; $raw_pages raw_pages; $raw_missing sin archivo en disco"
if (( raw_missing > 0 )); then
  echo "   AVISO: hay raw_pages cuyo archivo no está en $DATA_DIR_ (queda registrado en el manifest)"
fi

say "4/5 manifest"
IFS='|' read -r db_encoding db_collate db_ctype < <(psql_q -c "SELECT pg_encoding_to_char(encoding)||'|'||datcollate||'|'||datctype FROM pg_database WHERE datname=current_database()")
{
  echo "format=crv-backup-1"
  echo "created_at=$STAMP"
  echo "git_commit=$(git rev-parse HEAD 2>/dev/null || echo unknown)"
  echo "git_dirty=$([[ -n "$(git status --porcelain 2>/dev/null)" ]] && echo yes || echo no)"
  echo "core_sha256=$(sha256sum crv_simple_v1.sql | cut -d' ' -f1)"
  echo "db_container=$CONTAINER"
  echo "db_name=$PGDB"
  echo "db_owner=$PGUSER_"
  echo "db_encoding=$db_encoding"
  echo "db_collate=$db_collate"
  echo "db_ctype=$db_ctype"
  echo "pg_server_version=$(psql_q -c "SHOW server_version")"
  echo "migrations=$(psql_q -c "SELECT string_agg(version, ',' ORDER BY version) FROM ingest.schema_migrations")"
  echo "tables=$(wc -l < "$OUT/counts.tsv" | tr -d ' ')"
  echo "rows_total=$(awk -F'\t' '{ total += $2 } END { print total }' "$OUT/counts.tsv")"
  echo "raw_pages=$raw_pages"
  echo "raw_files=$raw_files"
  echo "raw_missing=$raw_missing"
  echo "dump_bytes=$(stat -c %s "$OUT/crv.dump")"
  echo "raw_tar_bytes=$(stat -c %s "$OUT/raw.tar.gz")"
} > "$OUT/manifest.txt"
sed 's/^/   /' "$OUT/manifest.txt"

say "5/5 sumas"
(cd "$OUT" && sha256sum crv.dump raw.tar.gz counts.tsv manifest.txt > SHA256SUMS)
mv "$OUT" "$FINAL_OUT"
complete=yes
echo "   backup listo: $FINAL_OUT"
echo "   pruébalo sin tocar nada: npm run db:restore-check -- \"$FINAL_OUT\""
