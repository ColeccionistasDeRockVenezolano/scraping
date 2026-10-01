#!/usr/bin/env python3
"""Laya elige el tipo de los discos que siguen en `other` (Brian, 2026-09-28).

Lee los expedientes de scripts/export-laya-album-types.ts y escribe una
predicción por disco. Laya se abstiene si nada del expediente lo sostiene. No
escribe en la base: scripts/apply-laya-album-types.ts aplica con las guardas
de número de pistas. Reanudable.

Uso: ~/.venvs/laya/bin/python scripts/run-laya-album-types.py [--limit N]
"""
from __future__ import annotations

import argparse
import json
import sys
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "reports" / "album-type-laya-dossiers-2026-09-28.jsonl"
OUTPUT = ROOT / "reports" / "album-type-laya-predictions-2026-09-28.jsonl"
ABSTAIN = "evidencia_insuficiente"
PROMPT_VERSION = "crv-album-type-laya.v2"

CRITERIA = {
    "studio_album": "Álbum de estudio: disco de larga duración con temas nuevos del artista (LP, CD de larga duración).",
    "ep": "EP: disco corto con pocos temas (en general 4 a 7), presentado como EP o mini-álbum.",
    "single": "Sencillo: uno a tres temas, presentado como single o 45 rpm.",
    "demo": "Demo o maqueta: grabación de promoción o ensayo, no editada comercialmente como álbum.",
    "compilation": "Recopilatorio: reúne temas ya publicados (grandes éxitos, antología, lo mejor de) o de varios artistas.",
    "live_album": "En vivo: grabado en concierto.",
    "remix": "Disco de remezclas.",
    "soundtrack": "Banda sonora de una película, obra o serie.",
    ABSTAIN: "El expediente no permite decidir el tipo del disco.",
}


import re
import unicodedata


def fold(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", text) if unicodedata.category(c) != "Mn").lower()


# Con todas las opciones abiertas (v1) Laya repartía «remix» y «soundtrack» sin
# que el expediente los nombrara (192 y 119 de 1.345). Como en los géneros, cada
# disco recibe solo los tipos que su propio texto nombra.
KEYWORDS = {
    "ep": r"\bep\b|mini-?album|extended play",
    "single": r"\bsingle\b|\bsencillo\b|45 ?rpm",
    "demo": r"\bdemo\b|maqueta",
    "compilation": r"recopila|compilad|compilaci|antologi|grandes exitos|greatest hits|best of|\blo mejor de\b|varios artistas",
    "live_album": r"en vivo|en directo|\blive\b|grabad[oa] en (?:el )?concierto",
    "remix": r"\bremix|remezcla",
    "soundtrack": r"banda sonora|soundtrack|\bost\b",
    "studio_album": r"\balbum\b|\blp\b|larga duracion|disco de estudio",
}


def options(case: dict) -> list[str]:
    # El título cuenta solo para las palabras explícitas de formato (EP, Demo, Single, En Vivo).
    body = fold(" ".join([case.get("review") or "", *(case.get("posts") or []), *(case.get("signals") or []),
                          *(case.get("formats") or []), *(case.get("classifications") or [])]))
    title = fold(case.get("title") or "")
    found = [t for t, pattern in KEYWORDS.items() if re.search(pattern, body)]
    for t in ("ep", "demo", "single", "live_album"):
        if t not in found and re.search(KEYWORDS[t], title):
            found.append(t)
    if "studio_album" not in found and (case.get("trackCount") or 0) >= 8:
        found.append("studio_album")
    return found


def question(case: dict) -> dict:
    allowed = options(case)
    return {"tipo": {
        "type": "choice",
        "instructions": (
            "¿Qué tipo de disco es? Decide con lo que dicen la reseña, el post y las señales de las fuentes "
            "(«EP», «demo», «en vivo», «recopilatorio», «single», «LP», «álbum»), y con el número de pistas. "
            "El título solo NO basta: un disco llamado «Lo Mejor…» o «…Hits» no es recopilatorio si la reseña dice que es un álbum de temas nuevos. "
            "Si el expediente no lo afirma y el número de pistas no alcanza para decidir, elige evidencia_insuficiente."
        ),
        "criteria": {k: CRITERIA[k] for k in [*allowed, ABSTAIN]},
    }}


def state(case: dict) -> dict:
    data = {
        "titulo": case["title"], "artista": case["artist"], "año": case.get("year"), "sello": case.get("label"),
        "numero_de_pistas": case.get("trackCount"), "minutos_totales": case.get("totalMinutes"),
        "pistas": case.get("tracks") or [], "formatos": case.get("formats") or [],
        "clasificaciones_de_la_hoja": case.get("classifications") or [],
        "reseña": case.get("review"), "posts": case.get("posts") or [], "señales_de_fuentes": case.get("signals") or [],
    }
    return {k: v for k, v in data.items() if v not in (None, [], "")}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int)
    args = parser.parse_args()
    cases = [json.loads(line) for line in INPUT.read_text(encoding="utf-8").splitlines() if line.strip()]
    done = set()
    if OUTPUT.exists():
        done = {json.loads(line)["caseId"] for line in OUTPUT.read_text(encoding="utf-8").splitlines() if line.strip()}
    todo = [case for case in cases if case["caseId"] not in done]
    if args.limit:
        todo = todo[:args.limit]

    from laya import Router
    router = Router(default="multilingual")
    with OUTPUT.open("a", encoding="utf-8") as out:
        for index, case in enumerate(todo, 1):
            allowed = options(case)
            if not allowed:
                row = {"caseId": case["caseId"], "albumId": case["albumId"], "trackCount": case.get("trackCount"),
                       "status": "no_options", "type": None, "options": []}
                out.write(json.dumps(row, ensure_ascii=False) + "\n")
                continue
            try:
                result = router.predict(state(case), question(case), model="multilingual")
                answer = result["answers"]["tipo"]
                chosen = answer["choice"]
                if chosen not in [*allowed, ABSTAIN]:
                    raise ValueError(f"opción ajena: {chosen}")
                probabilities = answer.get("probabilities", {})
                row = {"caseId": case["caseId"], "albumId": case["albumId"], "trackCount": case.get("trackCount"),
                       "status": "abstained" if chosen == ABSTAIN else "suggested",
                       "type": None if chosen == ABSTAIN else chosen,
                       "probability": probabilities.get(chosen), "probabilities": probabilities,
                       "options": allowed, "layaVersion": version("laya"), "promptVersion": PROMPT_VERSION}
            except Exception as exc:  # se anota y se sigue
                row = {"caseId": case["caseId"], "albumId": case["albumId"], "status": "error", "type": None, "error": str(exc)}
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            print(f"[{index}/{len(todo)}] {case['caseId']}: {row.get('type') or row['status']}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
