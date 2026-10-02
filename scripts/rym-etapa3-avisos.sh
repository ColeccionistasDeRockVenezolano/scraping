#!/bin/bash
# Etapa 3 CRV — avisos a los dos Telegram del dueño (Synapse + Hermes).
# Uso: rym-etapa3-avisos.sh "mensaje"
# Sin secretos hardcodeados: el token de Synapse se lee de su .env en runtime.
set -u
REPO="/home/brian/apps/Coleccionistas De Rock Venezolano"
LOG="$REPO/reports/etapa3-avisos.log"
MSG="${1:-CRV · RYM: aviso}"
CHAT="8481212232"
SY_ENV="/home/brian/.synapse/.env"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

# — Synapse (@synapse5_bot), Bot API directa
TOK=$(grep -m1 '^TELEGRAM_BOT_TOKEN=' "$SY_ENV" 2>/dev/null | cut -d= -f2- | tr -d '"' | tr -d "'")
if [ -n "$TOK" ]; then
  R=$(curl -s --max-time 12 -X POST "https://api.telegram.org/bot${TOK}/sendMessage" \
        --data-urlencode "chat_id=${CHAT}" --data-urlencode "text=${MSG}" 2>&1)
  if echo "$R" | grep -q '"ok":true'; then
    log "synapse ok"
  else
    log "synapse FALLO: ${R:0:200}"
  fi
else
  log "synapse FALLO: sin token en $SY_ENV"
fi

# — Hermes (@hermes_dpsk_bot) vía `hermes send` (no requiere gateway vivo)
HB=$(command -v hermes 2>/dev/null || true)
[ -z "$HB" ] && [ -x "$HOME/.local/bin/hermes" ] && HB="$HOME/.local/bin/hermes"
if [ -n "$HB" ]; then
  if "$HB" send --to telegram "$MSG" >/dev/null 2>&1; then
    log "hermes ok"
  else
    log "hermes FALLO (exit $?)"
  fi
else
  log "hermes FALLO: binario no encontrado"
fi
