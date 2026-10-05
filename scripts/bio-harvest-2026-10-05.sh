#!/bin/bash
# CRV · Cosecha de textos de biografía de las fuentes externas (2026-10-05), un
# proceso por fuente con su caché en data/raw/<fuente>. Segunda pasada barata de
# las que leen el libro de enlaces de Lobotoradio (wikipedia, venciclopedia,
# discogs) para incorporar los enlaces nuevos.
set -u
REPO="/home/brian/apps/Coleccionistas De Rock Venezolano"
cd "$REPO" || exit 1
D=reports/bio-harvest-2026-10-05
CAT=reports/biography-catalog-2026-10-05.json
mkdir -p "$D"
echo "arranque $(date '+%F %T')" > "$D/estado.txt"
start=$(date +%s)
for s in lobotoradio lastfm wikipedia venciclopedia discogs musicbrainz theaudiodb rhv vzlarockea; do
  ( python3 scripts/harvest-biography-texts.py "$CAT" "$s" > "$D/$s.log" 2>&1
    echo "$s fin $(date '+%F %T') rc=$?" >> "$D/estado.txt" ) &
done
wait
for s in wikipedia venciclopedia discogs; do
  ( python3 scripts/harvest-biography-texts.py "$CAT" "$s" > "$D/$s-2pasada.log" 2>&1
    echo "$s 2pasada fin $(date '+%F %T') rc=$?" >> "$D/estado.txt" ) &
done
wait
echo "TERMINADA $(date '+%F %T') ($(( $(date +%s) - start ))s)" >> "$D/estado.txt"
touch "$D/TERMINADA"
