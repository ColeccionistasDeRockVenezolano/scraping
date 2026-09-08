#!/usr/bin/env bash
# Harness de migraciones CRV: aplica en orden los *.up.sql pendientes y los
# registra en schema_migrations. Re-ejecutar no re-aplica nada (mecanismo
# normal de migrations).
#
# Uso: migrate.sh <contenedor_pg> <directorio_migraciones>
set -euo pipefail

CTR="${1:?uso: migrate.sh <contenedor> <directorio_migraciones>}"
DIR="${2:?uso: migrate.sh <contenedor> <directorio_migraciones>}"

psql_q() { docker exec -i "$CTR" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -tA "$@"; }

psql_q -c 'CREATE SCHEMA IF NOT EXISTS ingest;'
psql_q -c 'CREATE TABLE IF NOT EXISTS ingest.schema_migrations (
  version    TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);'

applied=0
for f in "$DIR"/*.up.sql; do
  v="$(basename "$f" .up.sql)"
  if [[ -z "$(psql_q -c "SELECT 1 FROM ingest.schema_migrations WHERE version = '$v'")" ]]; then
    echo "  [migrate] aplicando $v"
    docker exec -i "$CTR" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < "$f"
    psql_q -c "INSERT INTO ingest.schema_migrations(version) VALUES ('$v')"
    applied=1
  else
    echo "  [migrate] skip (ya aplicada): $v"
  fi
done

if [[ $applied -eq 0 ]]; then
  echo "  [migrate] sin migraciones pendientes"
fi
