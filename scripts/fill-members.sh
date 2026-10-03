#!/usr/bin/env bash
# CRV · Llenar la pestaña Miembros de los artistas que no tienen ninguno (proceso de 2026-10-01, reutilizable).
#
# Correr tras cualquier ingesta de blogs o síntesis de biografías: los adaptadores NO infieren membresías de la
# prosa (decisión del proyecto); este proceso sí, con DeepSeek flash y una cita literal validada por persona.
#
#   1. expedientes de biografías (textos originales de las fuentes) → expedientes de integrantes
#   2. extracción DeepSeek flash, una llamada por ficha (reanudable; caché en ingest.ai_runs)
#   3. aplicador por fases: llm (integrantes + titulares), structured (listas confirmadas), credits (músicos filtrados)
#   4. limpieza: duplicados dentro de cada banda (fusión) y homónimos (fusión con colegas o cola person_duplicate)
#
# Sin --confirm se detiene tras los dry-runs de las fases (reports/apply-members-*-dry-run.json).
# Uso: scripts/fill-members.sh [--confirm] [--ids=1,2,3]
# Directorio de trabajo: $MEMBERS_DIR (por defecto reports/member-dossiers/<fecha>).
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIRM=""
IDS=""
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM="--confirm" ;;
    --ids=*) IDS="$arg" ;;
    *) echo "argumento desconocido: $arg" >&2; exit 2 ;;
  esac
done
DIR="${MEMBERS_DIR:-reports/member-dossiers/$(date +%F)}"
mkdir -p "$DIR"
DOSSIERS="$DIR/member-dossiers.jsonl"
EXTRACTION="$DIR/member-extraction.jsonl"

echo "== 1. expedientes ($DIR)"
BIO_DOSSIERS_DIR="$DIR/bio-dossiers" npx tsx scripts/export-biography-dossiers.ts --kinds=artist
npx tsx scripts/export-member-dossiers.mts --bio="$DIR/bio-dossiers" --out="$DIR" $IDS

echo "== 2. extracción DeepSeek flash"
DEEPSEEK_TIMEOUT_MS="${DEEPSEEK_TIMEOUT_MS:-180000}" npx tsx scripts/extract-members-deepseek.mts --in="$DOSSIERS" --out="$EXTRACTION" $IDS

echo "== 3. aplicador"
RUNS=()
REPORTS=()
for phase in llm structured credits; do
  log="$DIR/apply-$phase.log"
  npx tsx scripts/apply-members.mts --phase="$phase" --dossiers="$DOSSIERS" --extraction="$EXTRACTION" $IDS $CONFIRM | tee "$log"
  report=$(sed -n 's/^informe: //p' "$log")
  if [[ -n "$report" ]]; then
    REPORTS+=("$report")
    mapfile -t ids < <(python3 -c 'import json,sys; print("\n".join(map(str, json.load(open(sys.argv[1]))["runs"])))' "$report")
    RUNS+=("${ids[@]}")
  fi
done

if [[ -z "$CONFIRM" ]]; then
  echo "dry-run: revisa reports/apply-members-*-dry-run.json y vuelve a correr con --confirm"
  exit 0
fi
if [[ ${#RUNS[@]} -eq 0 ]]; then echo "nada aplicado"; exit 0; fi

echo "== 4. limpieza"
npx tsx scripts/members-cleanup.mts --phase=dedupe --runs="$(IFS=,; echo "${RUNS[*]}")" --confirm
npx tsx scripts/members-cleanup.mts --phase=homonyms --reports="$(IFS=,; echo "${REPORTS[*]}")" --confirm
echo "listo: runs ${RUNS[*]}; revisa reports/apply-members-foreign-review.json y reports/apply-members-credits-review.json"
