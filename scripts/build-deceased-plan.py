#!/usr/bin/env python3
"""Plan de correcciones de fallecidos y fechas (Brian, 2026-09-30).

Lee lo que dejó scripts/harvest-deceased-evidence.py y escribe el plan JSON que
ejecuta `crv review persons`. Las decisiones de Brian:
  * se guardan nacimiento y fallecimiento completos (AAAA-MM-DD) donde las
    fuentes de ficha los dan; solo año no cabe en la columna;
  * si las fuentes discrepan en el día, gana la fecha que repiten más fuentes
    distintas; en empate, MusicBrainz y luego Lobotoradio;
  * los solistas fallecidos sin ficha de persona reciben una (titular);
  * se marcan los integrantes de banda cuya muerte cuenta la biografía de su
    banda, con el nombre pegado al verbo (revisados oración por oración).
Revisión oración por oración de las evidencias de solo-texto (2026-09-30):
  aceptadas   1083 Willy Crook, 6052 Jesús Parra, 7348 Luis Mariano Rivera, 9671 Gloria Martín
  descartadas 4240 Tarot, 5385 Dermis Tatú, 8530 Los Claners, 9477 Spiteri (son bandas
              dadas de alta como «persona»; quien murió es otro integrante ya cubierto)
"""
from __future__ import annotations

import collections
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "reports" / "deceased"

ACCEPT_TEXT_ONLY = {1083, 6052, 7348, 9671}
MEMBERS_OK = {980, 3208, 3659, 4218, 5104, 5741}
PRIORITY = ["musicbrainz", "lobotoradio"]

persons = {}
for line in (OUT / "persons.tsv").read_text(encoding="utf8").splitlines():
    r = line.split("\t")
    persons[int(r[0])] = {"name": r[1], "deceased": r[2] == "true", "death": r[3] or None, "birth": r[4] or None}


def pick(entries: list[tuple[str, str]]) -> tuple[str | None, bool]:
    """(fecha, hubo_discrepancia) por mayoría de fuentes distintas; solo fechas completas."""
    votes: dict[str, set[str]] = collections.defaultdict(set)
    for source, date in entries:
        # «AAAA-01-01» es casi siempre un año sin día relleno por la fuente.
        if date and len(date) == 10 and not date.endswith("-01-01"):
            votes[date].add(source)
    if not votes:
        return None, False
    ranked = sorted(votes.items(), key=lambda kv: (-len(kv[1]), min((PRIORITY.index(s) if s in PRIORITY else 9) for s in kv[1])))
    return ranked[0][0], len(votes) > 1


births: dict[int, str] = {}
birth_conflicts = []
for line in (OUT / "births.jsonl").read_text(encoding="utf8").splitlines():
    r = json.loads(line)
    date, conflict = pick([(b["source"], b["date"]) for b in r["births"]])
    if date:
        births[r["personId"]] = date
        if conflict:
            birth_conflicts.append((r["personId"], r["name"], date, sorted({b["date"] for b in r["births"]})))

corrections: list[dict] = []
deceased_ids: set[int] = set()
death_dates: dict[int, str | None] = {}
death_conflicts = []

for line in (OUT / "candidates.jsonl").read_text(encoding="utf8").splitlines():
    r = json.loads(line)
    pid = r["personId"]
    if "structured" not in r["tiers"] and pid not in ACCEPT_TEXT_ONLY:
        continue
    date, conflict = pick([(e["source"], e["death"]) for e in r["evidence"] if e["death"]])
    if conflict:
        death_conflicts.append((pid, r["name"], date, r["deathDates"]))
    deceased_ids.add(pid)
    death_dates[pid] = date

for line in (OUT / "member-candidates.jsonl").read_text(encoding="utf8").splitlines():
    r = json.loads(line)
    pid = r["personId"]
    if pid in MEMBERS_OK:
        deceased_ids.add(pid)
        date, _ = pick([(h["source"], h["death"]) for h in r["hits"] if h["death"]])
        death_dates.setdefault(pid, date)

for pid in sorted(deceased_ids):
    p = persons[pid]
    birth, death = births.get(pid), death_dates.get(pid)
    if pid == 7728:
        death = None  # Larry Williams: la fuente da 1980-07-01 (murió el 7 de enero de 1980, día y mes invertidos)
    if birth and death and death < birth:
        death = None  # fuentes incompatibles: la cruz sí, la fecha no
    if p["birth"] and birth:
        birth = None
    if p["death"] and death:
        death = None
    if p["deceased"] and not birth and not death:
        continue
    item = {"op": "mark_deceased", "person": {"id": pid, "name": p["name"]},
            "why": "Fuentes ya cosechadas (Lobotoradio, MusicBrainz, Sincopa, Discogs, Wikipedia, Venciclopedia, biografías de banda) dan su fallecimiento."}
    if birth:
        item["birthDate"] = birth
    if death:
        item["deathDate"] = death
    corrections.append(item)

# Nacimientos de quienes siguen vivos (o sin dato de muerte).
for pid, birth in sorted(births.items()):
    if pid in deceased_ids or persons[pid]["birth"]:
        continue
    corrections.append({"op": "set_dates", "person": {"id": pid, "name": persons[pid]["name"]}, "birthDate": birth,
                        "why": "Nacimiento que dan las fuentes de ficha (Lobotoradio, MusicBrainz, Sincopa, Discogs)."})

# Solistas fallecidos sin ficha de persona.
corrections.append({"op": "create_titular", "name": "Germán Freytes", "artist": {"id": 1952, "name": "Germán Freytes"}, "deceased": True,
                    "birthDate": "1943-05-28", "deathDate": "1984-07-19",
                    "why": "Cantante venezolano (Sincopa y Discogs: 28/5/1943 – 19/7/1984); el artista no tenía persona."})
corrections.append({"op": "create_titular", "name": "Vinicio Adames", "artist": {"id": 258, "name": "Vinicio Adames"}, "deceased": True,
                    "birthDate": "1927-03-01", "deathDate": "1976-09-03",
                    "why": "José Vinicio Adames Piñero (Lobotoradio y Venciclopedia: 1/3/1927 – 3/9/1976); el artista no tenía persona."})

plan = {
    "decidedAt": "2026-09-30",
    "evidence": "Búsqueda en todo lo cosechado (reports/bio-texts, claims de biografía, cachés de las fuentes) de nacimiento y fallecimiento (Brian, 2026-09-30). Informe: reports/deceased/. Se marca is_deceased a quien tiene dato de ficha, su propia biografía o la biografía de su banda con el nombre pegado al verbo; las fechas completas se guardan por mayoría de fuentes.",
    "corrections": corrections,
}
(ROOT / "docs" / "decisions" / "2026-09-30-fallecidos-por-evidencia.json").write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf8")
ops = collections.Counter(c["op"] for c in corrections)
print(dict(ops), "fallecidos:", len(deceased_ids))
print("discrepancias de muerte:", death_conflicts)
print("discrepancias de nacimiento:", birth_conflicts)
