#!/usr/bin/env python3
"""Laya decide si una persona y un artista homónimos son la misma identidad (Brian, 2026-09-30, caso Ashwave).

Lee los expedientes de scripts/export-identity-link-dossiers.ts y escribe una
predicción por par. No escribe en la base: scripts/apply-identity-links.ts
aplica con guardas deterministas. Reanudable.

Uso: ~/.venvs/laya/bin/python scripts/run-laya-identity-links.py [--limit N]
"""
from __future__ import annotations

import argparse
import json
import sys
from importlib.metadata import version
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "reports" / "identity-link-dossiers-2026-09-30.jsonl"
OUTPUT = ROOT / "reports" / "identity-link-predictions-2026-09-30.jsonl"
ABSTAIN = "evidencia_insuficiente"
PROMPT_VERSION = "crv-identity-links.v1"

CRITERIA = {
    "misma_persona": (
        "La persona ES el artista: un individuo que graba bajo su propio nombre, o el artista es su nombre artístico, "
        "su proyecto solista o su carrera en solitario."
    ),
    "es_un_grupo": (
        "La ficha de persona es en realidad el grupo, banda, dúo o proyecto colectivo del artista: "
        "el nombre es el de una agrupación (varios integrantes), no el de un individuo."
    ),
    "distinta": "Son entidades distintas que solo comparten el nombre: un individuo que no es el artista ni su grupo.",
    ABSTAIN: "El expediente no permite decidir.",
}

QUESTION = {"identidad": {
    "type": "choice",
    "instructions": (
        "Un artista y una ficha de persona tienen el mismo nombre. ¿Qué relación hay? Decide con la biografía de cada uno, "
        "los integrantes del artista y los créditos de la persona en los discos del artista. "
        "Si el artista tiene varios integrantes y la persona no figura entre ellos, la ficha de persona es un grupo. "
        "Si el artista no tiene integrantes y la persona es un individuo acreditado en sus discos (voz, guitarra, producción), es la misma persona. "
        "Si nada lo sostiene, elige evidencia_insuficiente."
    ),
    "criteria": CRITERIA,
}}


def state(case: dict) -> dict:
    data = {
        "nombre_del_artista": case["artist"], "nombre_de_la_ficha_de_persona": case["person"],
        "la_coincidencia_es_por_un_alias": case["viaAlias"] or None,
        "biografia_del_artista": case.get("artistBio"), "biografia_de_la_persona": case.get("personBio"),
        "discos_del_artista": case["artistAlbums"], "integrantes_del_artista": case["artistMembers"],
        "nombres_de_integrantes": case.get("artistMemberNames"), "alias_de_la_persona": case.get("personAliases"),
        "discos_del_artista_donde_la_persona_tiene_creditos": case["personCreditsAtArtist"],
        "roles_de_la_persona_en_esos_discos": case.get("personRolesAtArtist"),
        "creditos_totales_de_la_persona": case["personTotalCredits"], "otras_bandas_de_la_persona": case.get("personOtherBands"),
    }
    return {k: v for k, v in data.items() if v not in (None, [], "", 0) or k in ("integrantes_del_artista", "discos_del_artista")}


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
                result = router.predict(state(case), QUESTION, model="multilingual")
                answer = result["answers"]["identidad"]
                chosen = answer["choice"]
                if chosen not in CRITERIA:
                    raise ValueError(f"opción ajena: {chosen}")
                probabilities = answer.get("probabilities", {})
                row = {"caseId": case["caseId"], "artistId": case["artistId"], "personId": case["personId"],
                       "answer": chosen, "probability": probabilities.get(chosen), "probabilities": probabilities,
                       "layaVersion": version("laya"), "promptVersion": PROMPT_VERSION}
            except Exception as exc:  # se anota y se sigue
                row = {"caseId": case["caseId"], "artistId": case["artistId"], "personId": case["personId"], "answer": None, "error": str(exc)}
            out.write(json.dumps(row, ensure_ascii=False) + "\n")
            out.flush()
            print(f"[{index}/{len(todo)}] {case['artist']} / {case['person']}: {row.get('answer')} {row.get('probability')}", flush=True)


if __name__ == "__main__":
    sys.exit(main())
