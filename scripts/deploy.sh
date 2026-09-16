#!/usr/bin/env bash
# CRV · deploy — publica la web del Funnel (/crv) en este servidor.
#
#   1. build:public → web/dist-public (lo que sirve crv-web; nunca web/dist)
#   2. reinicia crv-web y, con --api, también crv-api
#   3. comprueba que el gateway responda /crv/ y /crv/api
#
# Reiniciar la API cierra las sesiones abiertas: solo con --api, cuando cambió
# el backend. Guía: docs/OPERATIONS.md («Publicar el frontend…»).
#
#   uso: scripts/deploy.sh [--api]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${CRV_WEB_PORT:-3120}"
restart_api=no
[[ "${1:-}" == "--api" ]] && restart_api=yes

echo "› build público (web/dist-public)"
(cd "$ROOT/web" && npm run build:public)

if [[ "$restart_api" == yes ]]; then
  echo "› reiniciando crv-api (las sesiones abiertas se cierran)"
  systemctl --user restart crv-api
fi
echo "› reiniciando crv-web"
systemctl --user restart crv-web

check() {
  local url="$1" deadline=$((SECONDS + 60)) code
  while (( SECONDS < deadline )); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$url" || true)"
    if [[ "$code" =~ ^[23] ]]; then echo "  ok $code $url"; return 0; fi
    sleep 1
  done
  echo "  ✗ sin respuesta correcta de $url (último código: ${code:-ninguno})" >&2
  systemctl --user status crv-web crv-api --no-pager -n 20 >&2 || true
  return 1
}

echo "› verificando"
check "http://127.0.0.1:$PORT/crv/"
check "http://127.0.0.1:$PORT/crv/api/health"
echo "✓ publicado"
