#!/usr/bin/env python3
"""Elige el principal entre los géneros de una fuente con lista alfabética."""
import json
from pathlib import Path

from laya import Router

ROOT = Path(__file__).resolve().parents[1]
INPUT = ROOT / "reports/genre-source-alphabetical-cases-2026-09-27.jsonl"
OUTPUT = ROOT / "reports/genre-source-alphabetical-predictions-2026-09-27.jsonl"
cases = [json.loads(line) for line in INPUT.read_text().splitlines() if line]
done = {json.loads(line)["caseId"] for line in OUTPUT.read_text().splitlines() if line} if OUTPUT.exists() else set()
todo = [case for case in cases if case["caseId"] not in done]
router = Router(default="multilingual")
with OUTPUT.open("a") as out:
    for index, case in enumerate(todo, 1):
        try:
            criteria = {item["slug"]: f"{item['name']} (familia: {item['family'] or item['name']})"
                        for item in case["candidates"]}
            criteria["evidencia_insuficiente"] = "La lista no permite identificar un estilo principal"
            state = {"nivel": case["kind"], "artista_o_disco": case["title"],
                     "fuente": case["source"], "generos_de_la_fuente": case["raw"]}
            question = {"principal": {"type": "choice", "instructions":
                        "La fuente publicó una lista alfabética: su primer género no indica prioridad. "
                        "Escoge el estilo principal que mejor describe a esta ficha entre los géneros "
                        "que la fuente nombra. Si la lista y el nombre no bastan, abstente.",
                        "criteria": criteria}}
            answer = router.predict(state, question, model="multilingual")["answers"]["principal"]
            choice = answer["choice"]
            if choice not in criteria:
                raise ValueError(f"opción ajena: {choice}")
            row = {"caseId": case["caseId"], "status": "abstained" if choice == "evidencia_insuficiente" else "suggested",
                   "primaryGenre": None if choice == "evidencia_insuficiente" else choice,
                   "probability": answer.get("probabilities", {}).get(choice)}
        except Exception as exc:
            row = {"caseId": case["caseId"], "status": "error", "primaryGenre": None, "error": str(exc)}
        out.write(json.dumps(row, ensure_ascii=False) + "\n")
        out.flush()
        print(f"[{index}/{len(todo)}] {case['caseId']}: {row['primaryGenre'] or row['status']}", flush=True)
