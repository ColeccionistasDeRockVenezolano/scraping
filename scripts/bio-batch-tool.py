#!/usr/bin/env python3
"""Herramienta de los subagentes de síntesis de biografías (docs/curation/BIOGRAFIAS_SINTESIS.md).

  show   <lote> <desde> <cuántos>   imprime esos expedientes (JSON compacto, sin campos vacíos)
  append <lote>                     lee líneas JSON de stdin, las valida y las añade a la salida
  check  <lote>                     dice qué expedientes del lote faltan en la salida
  missing <lote> <cuántos>          imprime los siguientes expedientes que aún no tienen salida

<lote> es el nombre sin extensión (p. ej. album-012). Directorios por entorno:
BIO_DOSSIERS_DIR (reports/bio-dossiers) y BIO_SYNTH_DIR (reports/bio-synth).
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DOSSIERS = ROOT / os.environ.get("BIO_DOSSIERS_DIR", "reports/bio-dossiers")
SYNTH = ROOT / os.environ.get("BIO_SYNTH_DIR", "reports/bio-synth")


def dossiers(batch: str) -> list[dict]:
    return [json.loads(line) for line in (DOSSIERS / f"{batch}.jsonl").read_text(encoding="utf-8").split("\n") if line.strip()]


def written(batch: str) -> dict[str, dict]:
    path = SYNTH / f"{batch}.jsonl"
    out: dict[str, dict] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").split("\n"):
            if line.strip():
                row = json.loads(line)
                out[row["caseId"]] = row
    return out


def compact(value):
    if isinstance(value, dict):
        return {k: compact(v) for k, v in value.items() if v not in (None, "", [], {})}
    if isinstance(value, list):
        return [compact(v) for v in value]
    return value


def main() -> None:
    command, batch = sys.argv[1], sys.argv[2]
    items = dossiers(batch)
    if command == "show":
        start, count = int(sys.argv[3]), int(sys.argv[4])
        print(f"# {batch}: expedientes {start}–{min(start + count, len(items)) - 1} de {len(items)} (índice desde 0)")
        for item in items[start:start + count]:
            print(json.dumps(compact(item), ensure_ascii=False))
    elif command == "append":
        valid = {item["caseId"]: item for item in items}
        SYNTH.mkdir(parents=True, exist_ok=True)
        done = written(batch)
        rows, errors = [], []
        for number, line in enumerate(sys.stdin.read().split("\n"), 1):
            if not line.strip():
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError as exc:
                errors.append(f"línea {number}: JSON inválido ({exc})")
                continue
            dossier = valid.get(row.get("caseId"))
            if not dossier:
                errors.append(f"línea {number}: caseId {row.get('caseId')} no está en {batch}")
                continue
            if not (row.get("text") is None or isinstance(row.get("text"), str)):
                errors.append(f"línea {number}: text debe ser texto o null")
                continue
            refs = {"catalog", "current", *(s["ref"] for s in dossier["sources"])}
            bad = [ref for ref in row.get("sourcesUsed") or [] if ref not in refs]
            if bad:
                errors.append(f"línea {number}: {row['caseId']} cita refs inexistentes {bad}")
                continue
            done[row["caseId"]] = row
            rows.append(row["caseId"])
        ordered = [done[item["caseId"]] for item in items if item["caseId"] in done]
        (SYNTH / f"{batch}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in ordered), encoding="utf-8")
        print(f"guardadas {len(rows)}; total en salida {len(ordered)}/{len(items)}")
        for error in errors:
            print("ERROR", error)
        if errors:
            sys.exit(1)
    elif command == "missing":
        done = written(batch)
        pending = [item for item in items if item["caseId"] not in done]
        count = int(sys.argv[3])
        print(f"# {batch}: faltan {len(pending)} de {len(items)}; se muestran {min(count, len(pending))}")
        for item in pending[:count]:
            print(json.dumps(compact(item), ensure_ascii=False))
    elif command == "check":
        done = written(batch)
        missing = [item["caseId"] for item in items if item["caseId"] not in done]
        print(f"{batch}: {len(items) - len(missing)}/{len(items)} escritas" + (f"; faltan {len(missing)}: {', '.join(missing[:15])}{' …' if len(missing) > 15 else ''}" if missing else "; completo"))
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
