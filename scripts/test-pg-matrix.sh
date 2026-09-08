#!/usr/bin/env bash
# CRV · Matriz de versiones de PostgreSQL (PHASES F0).
#
# El contrato exige "PostgreSQL 15+", pero tanto tests/run_all.sh como
# test/support/pg-container.ts usan postgres:16-alpine por defecto: 15 solo se
# probaba a mano. Esto lo fija en un comando reproducible.
#
#   npm run test:matrix              # 15 y 16
#   PG_IMAGES="postgres:17-alpine" npm run test:matrix
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

IMAGES="${PG_IMAGES:-postgres:15-alpine postgres:16-alpine}"
failed=()

for image in $IMAGES; do
  printf '\n\033[1m===== %s =====\033[0m\n' "$image"
  if PG_IMAGE="$image" bash tests/run_all.sh; then
    printf '\033[32mOK   %s\033[0m\n' "$image"
  else
    printf '\033[31mFALLO %s\033[0m\n' "$image"
    failed+=("$image")
  fi
done

printf '\n\033[1m===== resumen =====\033[0m\n'
if (( ${#failed[@]} )); then
  printf 'FALLARON: %s\n' "${failed[*]}"
  exit 1
fi
printf 'Todas las versiones en verde: %s\n' "$IMAGES"
