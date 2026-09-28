#!/usr/bin/env python3
"""Puntúa el lote de 40 después de que Laya haya terminado sin leer la referencia."""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "reports"
DATE = "2026-09-26"
CASES = ROOT / f"genre-laya-blind-40-cases-{DATE}.jsonl"
REFERENCE = ROOT / f"genre-laya-blind-40-reference-{DATE}.jsonl"
PREDICTIONS = ROOT / f"genre-laya-blind-40-predictions-{DATE}.jsonl"
REPORT = ROOT / f"genre-laya-blind-40-evaluation-{DATE}.md"
SUMMARY = ROOT / f"genre-laya-blind-40-evaluation-{DATE}.json"


def read(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def pct(num: int, den: int) -> str:
    return f"{100 * num / den:.1f} %" if den else "—"


def main() -> None:
    cases = read(CASES)
    reference = read(REFERENCE)
    predictions = read(PREDICTIONS)
    assert len(cases) == len(reference) == len(predictions) == 40
    assert [row["caseId"] for row in cases] == [row["caseId"] for row in reference] == [row["caseId"] for row in predictions]
    assert all("primaryGenre" not in row and "sourceClaimIds" not in row for row in cases)
    assert all(row["referenceKind"] == "rule_confirmed" for row in reference)
    assert not any(row["status"] == "error" for row in predictions)

    rows = []
    for case, gold, pred in zip(cases, reference, predictions, strict=True):
        refs = {item["ref"] for item in case["evidence"]}
        source_overlap = bool(refs & {f"claim:{claim_id}" for claim_id in gold["sourceClaimIds"]})
        options = {item["slug"] for item in case["candidates"]}
        rows.append({
            "caseId": case["caseId"], "kind": case["kind"], "title": case["title"],
            "reference": gold["primaryGenre"], "predicted": pred["primaryGenre"],
            "probability": pred.get("probability"), "correct": pred["primaryGenre"] == gold["primaryGenre"],
            "referenceAvailable": gold["primaryGenre"] in options,
            "firstCandidateCorrect": case["candidates"][0]["slug"] == gold["primaryGenre"],
            "sourceClaimOverlap": source_overlap,
        })

    groups = {}
    for kind in ("album", "artist", "all"):
        selected = rows if kind == "all" else [row for row in rows if row["kind"] == kind]
        available = [row for row in selected if row["referenceAvailable"]]
        groups[kind] = {
            "cases": len(selected), "correct": sum(row["correct"] for row in selected),
            "accuracy": sum(row["correct"] for row in selected) / len(selected),
            "referenceAvailable": len(available),
            "correctWhenAvailable": sum(row["correct"] for row in available),
            "firstCandidateCorrect": sum(row["firstCandidateCorrect"] for row in selected),
            "sourceClaimOverlap": sum(row["sourceClaimOverlap"] for row in selected),
            "highProbabilityErrors": sum(not row["correct"] and isinstance(row["probability"], (int, float))
                                        and row["probability"] >= 0.9 for row in selected),
        }
    SUMMARY.write_text(json.dumps({"referenceKind": "rule_confirmed", "groups": groups, "cases": rows},
                                  ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [
        "# Evaluación ciega de Laya: 20 álbumes y 20 artistas", "",
        "Referencia: género principal `confirmed` por reglas del catálogo, con claims aceptados. "
        "Estas 40 asignaciones no son decisiones humanas revisadas individualmente. "
        "No se repite ninguno de los 49 casos del ensayo retrospectivo anterior.", "",
        "El archivo de entrada no marca cuál opción es la referencia ni incluye los IDs "
        "de los claims que la sustentan. Los slugs aparecen como opciones cuando la evidencia permite extraerlos. "
        "La referencia se abrió para puntuar después de ejecutar Laya.", "",
        "| Nivel | Aciertos | Acierto | Referencia entre opciones | Acierto con opción disponible | Primer candidato |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for kind, name in (("album", "Álbumes"), ("artist", "Artistas"), ("all", "Total")):
        group = groups[kind]
        lines.append(f"| {name} | {group['correct']}/{group['cases']} | {pct(group['correct'], group['cases'])} "
                     f"| {group['referenceAvailable']}/{group['cases']} "
                     f"| {group['correctWhenAvailable']}/{group['referenceAvailable']} "
                     f"({pct(group['correctWhenAvailable'], group['referenceAvailable'])}) "
                     f"| {group['firstCandidateCorrect']}/{group['cases']} |")
    lines += [
        "", "## Lectura de los resultados", "",
        "- Los 20 álbumes recibieron como evidencia el claim de género que sustenta la regla de referencia. "
        "Por eso, el 80 % de álbumes mide principalmente interpretación de una etiqueta explícita; "
        "no demuestra clasificación independiente.",
        "- Los artistas recibieron solo biografías. En 12/20, el género de referencia no apareció "
        "entre las opciones extraídas; Laya no podía acertar esos casos. Con la opción presente acertó 7/8.",
        "- El muestreo tomó primero una entidad de cada género disponible para dar variedad; "
        "no representa la distribución de los 5.050 pendientes.",
        "- Hubo 0 abstenciones y 8 errores con probabilidad del modelo de al menos 0,90. "
        "Las probabilidades todavía no están calibradas para decisiones de CRV.", "",
        "## Los 40 casos", "",
        "| Nivel | Caso | Referencia del catálogo | Laya | Probabilidad | ¿Coincide? | ¿Opción disponible? |",
        "|---|---|---|---|---:|---|---|",
    ]
    for row in rows:
        title = row["title"].replace("|", "\\|").replace("\n", " ")
        probability = row["probability"]
        shown = f"{probability * 100:.2f} %" if isinstance(probability, (float, int)) else "—"
        lines.append(f"| {'Álbum' if row['kind'] == 'album' else 'Artista'} | {title} | {row['reference']} "
                     f"| {row['predicted'] or 'se abstuvo'} | {shown} | {'Sí' if row['correct'] else 'No'} "
                     f"| {'Sí' if row['referenceAvailable'] else 'No'} |")
    lines += ["", "La evaluación no modificó la base de datos, el catálogo ni la radio.", ""]
    REPORT.write_text("\n".join(lines), encoding="utf-8")
    print(f"{groups['all']['correct']}/40 ({pct(groups['all']['correct'], 40)}) · {REPORT}")


if __name__ == "__main__":
    main()
