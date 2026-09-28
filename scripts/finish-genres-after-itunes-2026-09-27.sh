#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

artist_pid=1783022
expected=710
while kill -0 "$artist_pid" 2>/dev/null; do
  state=$(ps -o stat= -p "$artist_pid" 2>/dev/null || true)
  if [[ -z "$state" || "$state" == Z* ]]; then break; fi
  sleep 30
done

count_rows() {
  python3 - <<'PY'
from pathlib import Path
paths = [Path('reports/genre-laya-evidence-itunes-artists-2026-09-27.jsonl'),
         Path('reports/genre-laya-evidence-itunes-artists-rejected-2026-09-27.jsonl')]
print(sum(len(path.read_text().splitlines()) for path in paths if path.exists()))
PY
}

for attempt in 1 2 3 4 5; do
  rows=$(count_rows)
  if (( rows >= expected )); then break; fi
  echo "iTunes artista: ${rows}/${expected}; reintento ${attempt}"
  npm exec -- tsx scripts/harvest-itunes-artist-genres.ts
done
rows=$(count_rows)
if (( rows < expected )); then
  echo "iTunes artista incompleto: ${rows}/${expected}" >&2
  exit 1
fi

npm exec -- tsx scripts/prepare-itunes-artist-ledger.ts
ledger=reports/genre-laya-evidence-itunes-artists-new-2026-09-27.jsonl
npm exec -- tsx scripts/source-over-laya.ts --ledger="$ledger"
npm exec -- tsx scripts/source-over-laya.ts --ledger="$ledger" --confirm
npm exec -- tsx scripts/apply-source-genres.ts --ledger="$ledger"
jq -e '(.errors | length) == 0' reports/genres-source-accept-dry-run-2026-09-27-ledgers.json >/dev/null
npm exec -- tsx scripts/apply-source-genres.ts --ledger="$ledger" --confirm

export LAYA_INPUT=reports/genre-laya-dossiers-v6-2026-09-27.jsonl
export LAYA_OUTPUT=reports/genre-laya-dossiers-v6-predictions-2026-09-27.jsonl
npm exec -- tsx scripts/apply-laya-genres.ts --min=0
jq -e '(.errors == 0) and ((.failed | length) == 0)' reports/genres-laya-accept-dry-run-v6-2026-09-27.json >/dev/null
npm exec -- tsx scripts/apply-laya-genres.ts --min=0 --confirm
npm run cli -- curation scan

python3 - <<'PY'
import json
from pathlib import Path
doc = Path('docs/curation/GENEROS_CIERRE_2026-09-27.md')
text = doc.read_text()
text = text.replace('# Géneros: avance operativo', '# Géneros: cierre operativo')
head = text.split('## Pendiente de la cosecha iTunes por artista')[0]
tail = text.split('## Comprobaciones', 1)[1]
source_report = max(Path('reports').glob('genres-source-accept-confirm-*-ledgers-run-*.json'), key=lambda path: path.stat().st_mtime)
source = json.loads(source_report.read_text())
laya = json.loads(Path('reports/genres-laya-accept-confirm-v6-2026-09-27.json').read_text())
itunes = len(Path('reports/genre-laya-evidence-itunes-artists-2026-09-27.jsonl').read_text().splitlines())
new = len(Path('reports/genre-laya-evidence-itunes-artists-new-2026-09-27.jsonl').read_text().splitlines())
section = (f'## Cierre de iTunes por artista y v6\n\n'
           f'iTunes reunió {itunes} filas con género; {new} no estaban cubiertas por Last.fm. '
           f'El aplicador confirmó {len(source["accepted"])} artistas nuevos (run {source["runId"]}), '
           f'con {len(source["errors"])} errores. Laya v6 confirmó {len(laya["accepted"])} '
           f'fichas (run {laya["runId"]}), con {laya["abstained"]} abstenciones.\n\n')
doc.write_text(head + section + '## Comprobaciones' + tail)
PY

echo "CIERRE COMPLETO"
