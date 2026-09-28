#!/usr/bin/env bash
set -euo pipefail

laya_python="${LAYA_PYTHON:-${HOME}/.venvs/laya/bin/python}"
if [[ ! -x "$laya_python" ]]; then
  echo "No se encontró Laya en $laya_python; define LAYA_PYTHON con su intérprete virtual." >&2
  exit 1
fi
exec "$laya_python" scripts/genre-laya-pilot.py "$@"
