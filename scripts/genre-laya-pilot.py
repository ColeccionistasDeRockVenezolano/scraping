#!/usr/bin/env python3
"""Piloto local y de solo lectura de Laya para géneros CRV.

Lee casos exportados por export-genre-laya-pilot.ts y produce predicciones e
informe. Nunca se conecta a PostgreSQL ni publica clasificaciones.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from importlib.metadata import version
from pathlib import Path
from typing import Any

SCHEMA = "crv-genre-laya-pilot.v1"
PROMPT_VERSION = "crv-genre-laya-choice.v1"
ABSTAIN = "evidencia_insuficiente"


def read_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for line_number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not line.strip():
            continue
        value = json.loads(line)
        if not isinstance(value, dict):
            raise ValueError(f"{path}:{line_number}: se esperaba un objeto JSON")
        rows.append(value)
    return rows


def validate_case(case: dict[str, Any]) -> None:
    if case.get("schemaVersion") != SCHEMA:
        raise ValueError(f"{case.get('caseId')}: versión de caso no compatible")
    kind, entity_id = case.get("kind"), case.get("entityId")
    if kind not in ("album", "artist") or not isinstance(entity_id, int) or entity_id <= 0:
        raise ValueError("nivel o id de entidad inválido")
    if case.get("caseId") != f"{kind}:{entity_id}":
        raise ValueError("caseId no coincide con la entidad")
    evidence, candidates = case.get("evidence"), case.get("candidates")
    if not isinstance(evidence, list) or not evidence or not isinstance(candidates, list) or not 1 <= len(candidates) <= 8:
        raise ValueError(f"{case['caseId']}: se requieren evidencia y entre 1 y 8 candidatos")
    refs = set()
    for item in evidence:
        if not isinstance(item, dict) or not isinstance(item.get("ref"), str) or not isinstance(item.get("text"), str):
            raise ValueError(f"{case['caseId']}: evidencia mal formada")
        if item["kind"] not in ("genre_claim", "genre_source_snapshot", "external_suggestion", "biography_claim"):
            raise ValueError(f"{case['caseId']}: clase de evidencia no admitida")
        if kind == "album" and item["kind"] == "biography_claim":
            raise ValueError(f"{case['caseId']}: un álbum no puede usar la biografía del artista")
        refs.add(item["ref"])
    slugs = set()
    for candidate in candidates:
        slug = candidate.get("slug") if isinstance(candidate, dict) else None
        supports = candidate.get("evidenceRefs") if isinstance(candidate, dict) else None
        if not isinstance(slug, str) or not slug or slug == ABSTAIN or slug in slugs:
            raise ValueError(f"{case['caseId']}: slug candidato inválido o repetido")
        if not isinstance(supports, list) or not supports or not set(supports).issubset(refs):
            raise ValueError(f"{case['caseId']}: candidato sin evidencia suministrada")
        slugs.add(slug)


def questions_for(case: dict[str, Any]) -> dict[str, Any]:
    criteria = {
        candidate["slug"]: f"{candidate['name']} (familia: {candidate.get('family') or candidate['name']})"
        for candidate in case["candidates"]
    }
    criteria[ABSTAIN] = "La evidencia no permite escoger un género principal entre estas opciones"
    return {"principal": {
        "type": "choice",
        "instructions": (
            "¿Qué género principal está mejor respaldado por la evidencia de esta misma entidad? "
            "Elige evidencia_insuficiente si el texto no permite decidir. "
            "Una etiqueta general no justifica un subgénero más preciso."
        ),
        "criteria": criteria,
    }}


def predict_one(router: Any, case: dict[str, Any]) -> dict[str, Any]:
    validate_case(case)
    state = {
        "nivel": case["kind"],
        "evidencia": [
            {"ref": item["ref"], "fuente": item["source"], "texto": item["text"]}
            for item in case["evidence"]
        ],
    }
    result = router.predict(state, questions_for(case), model="multilingual")
    answer = result["answers"]["principal"]
    chosen = answer["choice"]
    allowed = {candidate["slug"] for candidate in case["candidates"]} | {ABSTAIN}
    if chosen not in allowed:
        raise ValueError(f"{case['caseId']}: Laya respondió una opción ajena: {chosen}")
    selected = next((item for item in case["candidates"] if item["slug"] == chosen), None)
    probabilities = answer.get("probabilities", {})
    return {
        "caseId": case["caseId"], "kind": case["kind"], "entityId": case["entityId"],
        "promptVersion": PROMPT_VERSION,
        "primaryGenre": None if chosen == ABSTAIN else chosen,
        "status": "abstained" if chosen == ABSTAIN else "suggested",
        "probability": probabilities.get(chosen), "probabilities": probabilities,
        "evidenceRefs": selected["evidenceRefs"] if selected else [],
        "model": result.get("routing", {}).get("model", "multilingual"),
        "routing": result.get("routing", {}),
    }


def score(predictions: list[dict[str, Any]], gold: list[dict[str, Any]],
          cases: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    by_id = {row["caseId"]: row for row in predictions}
    reviewed = [row for row in gold if row.get("reviewed") is True]
    if any(not isinstance(row.get("reviewer"), str) or not row["reviewer"].strip() for row in reviewed):
        raise ValueError("toda etiqueta reviewed=true necesita reviewer identificado")
    candidate_slugs = {case["caseId"]: {item["slug"] for item in case["candidates"]} for case in cases or []}
    outside = [row["caseId"] for row in reviewed if row.get("primaryGenre") is not None
               and row["caseId"] in candidate_slugs and row["primaryGenre"] not in candidate_slugs[row["caseId"]]]
    comparable = [(row, by_id[row["caseId"]]) for row in reviewed
                  if row.get("caseId") in by_id and by_id[row["caseId"]].get("status") != "error"]
    in_candidates = [(expected, predicted) for expected, predicted in comparable
                     if expected.get("primaryGenre") is None
                     or expected["primaryGenre"] in candidate_slugs.get(expected["caseId"], set())]
    exact_in_candidates = sum(expected.get("primaryGenre") == predicted.get("primaryGenre")
                              for expected, predicted in in_candidates)
    exact = sum(expected.get("primaryGenre") == predicted.get("primaryGenre") for expected, predicted in comparable)
    proposals = [(expected, predicted) for expected, predicted in comparable if predicted.get("primaryGenre") is not None]
    accepted = sum(expected.get("primaryGenre") == predicted.get("primaryGenre") for expected, predicted in proposals)
    return {
        "reviewed": len(reviewed), "comparable": len(comparable),
        "exact": exact, "accuracy": exact / len(comparable) if comparable else None,
        "proposals": len(proposals), "accepted": accepted,
        "proposalPrecision": accepted / len(proposals) if proposals else None,
        "missedGoldCases": len(reviewed) - len(comparable),
        "goldOutsideCandidates": outside,
        "goldInCandidates": len(in_candidates),
        "exactInCandidates": exact_in_candidates,
        "accuracyInCandidates": exact_in_candidates / len(in_candidates) if in_candidates else None,
    }


def render_markdown(summary: dict[str, Any], predictions: list[dict[str, Any]]) -> str:
    lines = ["# Piloto Laya · géneros CRV", "", f"- Generado: {summary['generatedAt']}",
             f"- Casos: {summary['cases']} · propuestas: {summary['suggested']} · abstenciones: {summary['abstained']} · errores: {summary['errors']}",
             f"- Modelo: Laya {summary['layaVersion']} / checkpoint multilingual", "",
             "## Comparación humana", ""]
    gold = summary.get("gold")
    if gold and gold["comparable"]:
        lines.append(f"{gold['comparable']} casos revisados comparables; acierto exacto {gold['exact']}/{gold['comparable']} "
                     f"({gold['accuracy']:.1%}); precisión de propuestas {gold['accepted']}/{gold['proposals']} "
                     + (f"({gold['proposalPrecision']:.1%})" if gold["proposalPrecision"] is not None else "(sin propuestas)") + ".")
    else:
        lines.append("Sin etiquetas humanas revisadas: no se calcula precisión ni se autoriza publicación.")
    if gold and gold["goldOutsideCandidates"]:
        lines.append(f"{len(gold['goldOutsideCandidates'])} respuestas humanas no estaban entre los candidatos: "
                     + ", ".join(gold["goldOutsideCandidates"][:20]) + ".")
    if gold and gold["goldInCandidates"]:
        lines.append(f"Cuando la respuesta humana sí estaba disponible (o era abstenerse): "
                     f"{gold['exactInCandidates']}/{gold['goldInCandidates']} "
                     f"({gold['accuracyInCandidates']:.1%}).")
    baseline = summary.get("baseline")
    if baseline:
        lines.append(f"Comparador simple (primer candidato): {baseline['comparable']} casos comparables, "
                     + (f"acierto {baseline['accuracy']:.1%}." if baseline["accuracy"] is not None else "sin acierto calculable."))
    external_baseline = summary.get("externalBaseline")
    if external_baseline:
        lines.append(f"Comparador externo: {external_baseline['comparable']} casos comparables, "
                     + (f"acierto {external_baseline['accuracy']:.1%}." if external_baseline["accuracy"] is not None else "sin acierto calculable."))
    lines += ["", "## Primeras decisiones", "", "| Caso | Categorías | Resultado | Probabilidad | Evidencia |",
              "|---|---|---|---:|---|"]
    for row in predictions[:50]:
        case = row["caseId"]
        cats = ", ".join(row.get("categories", []))
        proposed = row.get("primaryGenre") or row.get("status", "error")
        probability = row.get("probability")
        shown_probability = f"{probability:.3f}" if isinstance(probability, (float, int)) else "—"
        refs = ", ".join(row.get("evidenceRefs", [])) or "—"
        lines.append(f"| {case} | {cats} | {proposed} | {shown_probability} | {refs} |")
    lines += ["", "Las probabilidades son salidas del modelo; requieren calibración con datos de CRV. "
              "Este piloto no escribe en la base ni cambia el catálogo o la radio.", ""]
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, required=True, help="JSONL de export-genre-laya-pilot.ts")
    parser.add_argument("--out", type=Path, default=Path("reports/genre-laya-pilot"), help="prefijo de archivos de salida")
    parser.add_argument("--gold", type=Path, help="JSONL con reviewed=true y primaryGenre revisado")
    parser.add_argument("--baseline", type=Path, help="JSONL de otro modelo con caseId y primaryGenre")
    parser.add_argument("--limit", type=int, help="máximo de casos a evaluar")
    parser.add_argument("--overwrite", action="store_true", help="reemplazar reportes existentes")
    args = parser.parse_args()
    cases = read_jsonl(args.input)
    if args.limit is not None:
        if args.limit < 1:
            parser.error("--limit debe ser positivo")
        cases = cases[:args.limit]
    if not cases:
        parser.error("el archivo de entrada no contiene casos")
    output = args.out
    outputs = [output.with_suffix(suffix) for suffix in (".jsonl", ".json", ".md")]
    if not args.overwrite and any(file.exists() for file in outputs):
        parser.error("algún reporte de salida ya existe; cambia --out o usa --overwrite")
    ids = set()
    for case in cases:
        validate_case(case)
        if case["caseId"] in ids:
            raise ValueError(f"caso duplicado: {case['caseId']}")
        ids.add(case["caseId"])

    from laya import Router  # carga el SDK solo después de validar el lote

    router = Router(default="multilingual")
    predictions = []
    for index, case in enumerate(cases, 1):
        try:
            predicted = predict_one(router, case)
        except Exception as exc:
            predicted = {"caseId": case["caseId"], "kind": case["kind"], "entityId": case["entityId"],
                         "status": "error", "primaryGenre": None, "error": str(exc), "evidenceRefs": []}
        predicted["categories"] = case.get("categories", [])
        predictions.append(predicted)
        print(f"[{index}/{len(cases)}] {case['caseId']}: {predicted.get('primaryGenre') or predicted['status']}", flush=True)

    gold = read_jsonl(args.gold) if args.gold else []
    external_baseline = read_jsonl(args.baseline) if args.baseline else []
    first_candidate_baseline = [{"caseId": case["caseId"], "primaryGenre": case["candidates"][0]["slug"]}
                                for case in cases]
    summary: dict[str, Any] = {
        "schemaVersion": SCHEMA, "generatedAt": datetime.now(timezone.utc).isoformat(),
        "inputSha256": hashlib.sha256(args.input.read_bytes()).hexdigest(),
        "layaVersion": version("laya"), "promptVersion": PROMPT_VERSION, "cases": len(cases),
        "suggested": sum(row["status"] == "suggested" for row in predictions),
        "abstained": sum(row["status"] == "abstained" for row in predictions),
        "errors": sum(row["status"] == "error" for row in predictions),
        "gold": score(predictions, gold, cases) if args.gold else None,
        "baseline": score(first_candidate_baseline, gold, cases) if args.gold else None,
        "externalBaseline": score(external_baseline, gold, cases) if args.gold and args.baseline else None,
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    flag = "w" if args.overwrite else "x"
    with output.with_suffix(".jsonl").open(flag, encoding="utf-8") as file:
        file.write("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in predictions))
    with output.with_suffix(".json").open(flag, encoding="utf-8") as file:
        file.write(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")
    with output.with_suffix(".md").open(flag, encoding="utf-8") as file:
        file.write(render_markdown(summary, predictions))
    print(f"Informe: {output}.md · {output}.json · {output}.jsonl")


if __name__ == "__main__":
    main()
