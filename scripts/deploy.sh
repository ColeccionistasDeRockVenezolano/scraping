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
  # PRIMERO LA BASE. La API carga el código en memoria al arrancar: si se
  # reinicia sobre un esquema viejo, arranca «bien» y falla al analizar
  # («column "content_hash" does not exist»), y eso solo se ve en la tabla de
  # análisis. Pasado real (2026-09-20): la 0023 y la 0024 llevaban días sin
  # aplicar y «Analizar ahora» corrió durante ese tiempo el motor anterior.
  echo "› migraciones pendientes"
  (cd "$ROOT" && npm run db:migrate)
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

# Publicar reglas nuevas sin cambiar el catálogo no despierta al vigilante: su
# firma solo mide datos. Por eso cada publicación de la API fuerza un análisis
# COMPLETO con el mismo código recién desplegado; así una nueva regla no queda
# días en disco mientras «Analizar ahora» y el resumen siguen pareciendo viejos.
if [[ "$restart_api" == yes ]]; then
  echo "› análisis completo con las reglas publicadas"
  analyzed=no
  for _ in {1..10}; do
    if estado="$(cd "$ROOT" && npm run --silent cli -- curation scan 2>&1)"; then
      echo "$estado"
      analyzed=yes
      break
    fi
    # El vigilante puede haber ganado el candado durante el arranque. Esperar
    # y repetir es seguro: el análisis es idempotente sobre el mismo catálogo.
    if [[ "$estado" == *"otro proceso está analizando"* ]]; then
      sleep 2
      continue
    fi
    echo "$estado" >&2
    exit 1
  done
  if [[ "$analyzed" != yes ]]; then
    echo "  ✗ no se pudo completar el análisis tras 10 intentos" >&2
    exit 1
  fi
  npm run --silent cli -- curation summary | head -1
fi
echo "✓ publicado"
