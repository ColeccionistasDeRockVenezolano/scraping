#!/usr/bin/env bash
# CRV · db:bootstrap — deja una base local lista y `doctor` en verde
# (PHASES F0). Idempotente: se puede correr las veces que haga falta.
#
#   1. crea .env desde .env.example si no existe
#   2. verifica el hash del core (crv_simple_v1.sql.sha256)
#   3. levanta docker compose y espera al healthcheck
#   4. aplica crv_simple_v1.sql VERBATIM si `public` aún no tiene el core
#   5. aplica migrations/*.up.sql pendientes
#   6. siembra ingest.sources
#   7. corre doctor
#
# El paso 3 nunca reaplica el core sobre una base que ya lo tiene: el core es
# inmutable (CONTRACT §2) y reejecutarlo fallaría por objetos duplicados.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SERVICE="crv-postgres"
PGUSER_="crv"
PGDB="crv"

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

say "1/7 configuración local"
if [[ -f .env ]]; then
  echo "   .env ya existe, no se toca"
else
  cp .env.example .env
  echo "   .env creado desde .env.example (gitignored; edítalo si hace falta)"
fi

say "2/7 hash del core"
sha256sum -c crv_simple_v1.sql.sha256

say "3/7 PostgreSQL local (docker compose)"
docker compose up -d --wait "$SERVICE"

psql_c() { docker compose exec -T "$SERVICE" psql -v ON_ERROR_STOP=1 -U "$PGUSER_" -d "$PGDB" "$@"; }

say "4/7 core canónico"
core_present="$(psql_c -tAc "SELECT to_regclass('public.artists') IS NOT NULL")"
if [[ "$core_present" == "t" ]]; then
  echo "   ya aplicado, no se toca (el core es inmutable)"
else
  psql_c -q < crv_simple_v1.sql
  echo "   crv_simple_v1.sql aplicado verbatim"
fi

say "5/7 migraciones auxiliares"
npm run --silent db:migrate

say "6/7 fuentes"
npm run --silent cli -- sources:seed

say "7/7 doctor"
npm run --silent doctor
