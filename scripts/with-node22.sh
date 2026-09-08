#!/usr/bin/env bash
# CRV · with-node22 — ejecuta un comando garantizando Node >= 22 (PHASES F0).
#
# Por qué existe: bash NO lee ~/.bashrc en shells no interactivos, así que
# ninguna corrección del dotfile puede arreglar las ejecuciones no
# interactivas (cron, CI, hooks de git, agentes). En esta máquina eso
# significaba correr `npm test`/`npm run doctor` con el Node 20 de
# /usr/bin en vez del Node 22 de nvm, contra `engines.node: >=22.0.0`.
#
# Estrategia: si el `node` del PATH ya cumple, no toca nada; si no, busca la
# instalación de nvm más alta que cumpla y la antepone al PATH solo para
# este comando. Si no hay ninguna, falla con instrucciones en vez de correr
# en silencio con la versión equivocada.
set -euo pipefail

REQUIRED_MAJOR=22

node_major() {
  local v
  v="$("$1" -v 2>/dev/null)" || return 1
  v="${v#v}"
  printf '%s' "${v%%.*}"
}

satisfies() {
  local m
  m="$(node_major "$1")" || return 1
  [ -n "$m" ] || return 1
  [ "$m" -ge "$REQUIRED_MAJOR" ] 2>/dev/null || return 1
}

if [ "$#" -eq 0 ]; then
  echo "uso: scripts/with-node22.sh <comando> [args...]" >&2
  exit 2
fi

if command -v node >/dev/null 2>&1 && satisfies node; then
  exec "$@"
fi

best_dir=""
best_major=0
for base in "${NVM_DIR:-}" "$HOME/.nvm" "$HOME/.config/nvm"; do
  [ -n "$base" ] && [ -d "$base/versions/node" ] || continue
  for candidate in "$base/versions/node"/v*/bin; do
    [ -x "$candidate/node" ] || continue
    major="$(node_major "$candidate/node")" || continue
    [ -n "$major" ] || continue
    if [ "$major" -ge "$REQUIRED_MAJOR" ] && [ "$major" -gt "$best_major" ]; then
      best_major="$major"
      best_dir="$candidate"
    fi
  done
done

if [ -z "$best_dir" ]; then
  current="$(node -v 2>/dev/null || echo 'ninguno')"
  cat >&2 <<MSG
CRV: se requiere Node >= ${REQUIRED_MAJOR} (package.json engines.node) y no se encontró
ninguno. Node en PATH: ${current}.
Instálalo con:  nvm install \$(cat .nvmrc) && nvm use
MSG
  exit 1
fi

export PATH="$best_dir:$PATH"
exec "$@"
