#!/usr/bin/env python3
"""Laya elige el género principal de cada expediente (scripts/export-laya-dossiers.ts).

Último recurso de géneros (Brian, 2026-09-27): solo fichas que ninguna fuente
cubre, con texto propio y opciones que ese texto nombra. Laya se abstiene si el
texto no lo sostiene. No escribe en la base: produce predicciones que
scripts/apply-laya-genres.ts confirma. Reanudable: salta los casos ya
predichos en el archivo de salida.

Uso: ~/.venvs/laya/bin/python scripts/run-laya-dossiers.py [--limit N]
"""
from __future__ import annotations

import argparse
import json
import sys
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT = Path(__import__("os").environ.get("LAYA_INPUT", ROOT / "reports" / "genre-laya-dossiers-2026-09-27.jsonl"))

OUTPUT = Path(__import__("os").environ.get("LAYA_OUTPUT", ROOT / "reports" / "genre-laya-dossiers-predictions-2026-09-27.jsonl"))
ABSTAIN = "evidencia_insuficiente"
PROMPT_VERSION = "crv-genre-laya-dossier.v2"


def question(case: dict) -> dict:
    criteria = {c["slug"]: f"{c['name']} (familia: {c.get('family') or c['name']})" for c in case["candidates"]}
    criteria[ABSTAIN] = "El texto propio no permite decidir el género principal"
    if case["kind"] == "album":
        own = ("El texto propio es la reseña o el post de ESTE disco. Si ese post describe el estilo "
               "de la banda que lo grabó («X es una banda de punk rock»), eso vale como estilo del disco. ")
        subject = "este disco"
    else:
        own = "El texto propio es la biografía o reseña de ESTE artista. "
        subject = "este artista"
    return {"principal": {
        "type": "choice",
        "instructions": (
            f"¿Qué género principal describe el texto propio de {subject}? " + own +
            "El contexto (géneros ya confirmados en el catálogo) solo orienta: no basta por sí solo. "
            "No cuentan: títulos de canciones, influencias («influenciados por…»), comparaciones, "
            "otras bandas de sus miembros, ni festivales o recopilatorios donde participó. "
            "Si el texto nombra varios estilos, elige el que lo define (el primero que usa para presentarlo). "
            "Elige evidencia_insuficiente si el texto no lo afirma."
        ),
        "criteria": criteria,
    }}


def state(case: dict) -> dict:
    data = {
        "nivel": case["kind"],
        "texto_propio": [{"ref": e["ref"], "fuente": e["source"], "texto": e["text"]}
                         for e in case["evidence"] if e["kind"] != "context_genre"],
        "contexto": [e["text"] for e in case["evidence"] if e["kind"] == "context_genre"],
    }
    if case.get("year"):
        data["año"] = case["year"]
    if case.get("label"):
        data["sello"] = case["label"]
    return data


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
            try:
                result = router.predict(state(case), question(case), model="multilingual")
                answer = result["answers"]["principal"]
                chosen = answer["choice"]
                allowed = {c["slug"] for c in case["candidates"]} | {ABSTAIN}
                if chosen not in allowed:
                    raise ValueError(f"opción ajena: {chosen}")
                probabilities = answer.get("probabilities", {})
                row = {"caseId": case["caseId"], "kind": case["kind"], "entityId": case["entityId"],
                       "status": "abstained" if chosen == ABSTAIN else "suggested",
                       "primaryGenre": None if chosen == ABSTAIN else chosen,
                       "probability": probabilities.get(chosen), "probabilities": probabilities,
                       "layaVersion": version("laya"), "promptVersion": PROMPT_VERSION}
            except Exception as exc:  # se anota y se sigue
                row = {"caseId": case["caseId"], "kind": case["kind"], "entityId": case["entityId"],
                       "status": "error", "primaryGenre": None, "error": str(exc)}
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            print(f"[{index}/{len(todo)}] {case['caseId']}: {row.get('primaryGenre') or row['status']}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
