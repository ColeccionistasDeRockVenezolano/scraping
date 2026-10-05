#!/usr/bin/env bash
# CRV · Espera a que Spotify deje de estar castigado (429) y entonces completa
# el pase spotify del piloto + lo re-aplica a public.streaming_links.
# Sondea cada 20 min durante 10 h; si funciona, hace el pase completo y sale.
#
#   systemd-run --user --collect --unit=crv-spotify-watch \
#     --working-directory="/home/brian/apps/Coleccionistas De Rock Venezolano" \
#     bash scripts/streaming-spotify-watch.sh
set -u
cd "/home/brian/apps/Coleccionistas De Rock Venezolano" || exit 1
PILOTO=reports/streaming-links-2026-10-04/piloto-100
ART=data/raw/streaming-2026-10-04/artistas.jsonl
ALB=data/raw/streaming-2026-10-04/albumes.jsonl
for i in $(seq 1 30); do
  salida=$(python3 scripts/streaming-spotify-pase.py --dir "$PILOTO" --artistas "$ART" --albumes "$ALB" --limit 1 2>&1)
  if echo "$salida" | grep -q "PARADA"; then
    echo "[sonda $i] spotify sigue castigado; espero 20 min"
    sleep 1200
    continue
  fi
  echo "[sonda $i] spotify OK — pase completo del piloto"
  python3 scripts/streaming-spotify-pase.py --dir "$PILOTO" --artistas "$ART" --albumes "$ALB"
  echo "re-aplico el piloto a public.streaming_links (solo inserta lo nuevo)"
  ./scripts/with-node22.sh npx tsx scripts/apply-streaming-links.ts "$PILOTO" --confirm
  date -u +"%Y-%m-%dT%H:%M:%SZ pase spotify del piloto: hecho" > /tmp/crv-recon/spotify-pase-ok.txt
  exit 0
done
echo "sin éxito en 10 h — reintentar el pase a mano"
exit 1
