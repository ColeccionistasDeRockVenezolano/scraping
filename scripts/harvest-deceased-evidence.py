#!/usr/bin/env python3
"""Evidencia de nacimiento y fallecimiento en TODO lo cosechado (Brian, 2026-09-30).

Pedido: «busca en lo scrapeado y en todas las fuentes ya trabajadas todos los
datos sobre nacimiento y fallecimiento y colócales la cruz a los fallecidos».
Este script solo lee y propone: no escribe en la base. Las salidas van a
reports/deceased/ y las aplica scripts/apply-deceased.ts (op `mark_deceased`).

Entradas (todas ya existentes):
  reports/bio-texts/*.jsonl   texto y datos de ficha de cada fuente, ya ligados a
                              una ficha nuestra por la identidad de cada cosechador
  reports/deceased/*.tsv      catálogo exportado de la base (personas, artistas,
                              miembros, créditos, alias) y claims de biografía

Niveles de prueba (de más a menos fiable):
  structured  dato de ficha de la fuente: Lobotoradio «fallecimiento», MusicBrainz
              (solo tipo Person: en un grupo «fin» es disolución), «Died:» de Sincopa
              y de Discogs.
  sentence    la propia biografía de la persona/solista dice «fallecido el…»,
              «died on…» en su primera oración.
  member      la biografía de una banda cuenta que murió alguien y el nombre casa
              con un integrante o músico acreditado de esa banda.

Salida: reports/deceased/candidates.jsonl (una fila por persona) y
reports/deceased/unresolved.jsonl (fallecimiento de un artista sin persona).
"""
from __future__ import annotations

import collections
import glob
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BIO = ROOT / "reports" / "bio-texts"
OUT = ROOT / "reports" / "deceased"

MONTHS_EN = {m: i + 1 for i, m in enumerate("january february march april may june july august september october november december".split())}
MONTHS_ES = {m: i + 1 for i, m in enumerate("enero febrero marzo abril mayo junio julio agosto septiembre setiembre octubre noviembre diciembre".split())}
MONTHS_ES["setiembre"] = 9
MONTHS_ES["septiembre"] = 9
MONTHS_ES["octubre"] = 10
MONTHS_ES["noviembre"] = 11
MONTHS_ES["diciembre"] = 12


def norm(value: str) -> str:
    value = unicodedata.normalize("NFKD", value)
    value = "".join(c for c in value if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", " ", value).strip()


def iso(y: int, m: int | None = None, d: int | None = None) -> str:
    if m and d:
        return f"{y:04d}-{m:02d}-{d:02d}"
    if m:
        return f"{y:04d}-{m:02d}"
    return f"{y:04d}"


# Fechas en español, inglés o ISO. Devuelve (texto, iso) de la primera.
DATE_RES = [
    (re.compile(r"\b(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de|del)\s+(\d{4})\b", re.I), lambda m: (int(m[3]), MONTHS_ES.get(norm(m[2])), int(m[1]))),
    (re.compile(r"\b([A-Za-z]+)\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b"), lambda m: (int(m[3]), MONTHS_EN.get(m[1].lower()), int(m[2]))),
    (re.compile(r"\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+),?\s+(\d{4})\b"), lambda m: (int(m[3]), MONTHS_EN.get(m[2].lower()), int(m[1]))),
    (re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b"), lambda m: (int(m[1]), int(m[2]), int(m[3]))),
    (re.compile(r"\b(\d{1,2})/(\d{1,2})/(\d{4})\b"), lambda m: (int(m[3]), int(m[2]), int(m[1]))),
]
DATE_PAT = "|".join(r.pattern for r, _ in DATE_RES)


def first_date(text: str) -> str | None:
    best: tuple[int, str] | None = None
    for rx, build in DATE_RES:
        m = rx.search(text)
        if not m:
            continue
        y, mo, d = build(m)
        if not (1700 <= y <= 2026):
            continue
        if mo is None and rx is not DATE_RES[3][0]:
            continue
        if mo and not (1 <= mo <= 12):
            continue
        if d and not (1 <= d <= 31):
            continue
        cand = (m.start(), iso(y, mo, d))
        if best is None or cand[0] < best[0]:
            best = cand
    return best[1] if best else None


def year_in(text: str) -> str | None:
    m = re.search(r"\b(1[89]\d{2}|20[0-2]\d)\b", text)
    return m.group(1) if m else None


# --- catálogo ------------------------------------------------------------------

def tsv(name: str) -> list[list[str]]:
    path = OUT / name
    return [line.rstrip("\n").split("\t") for line in path.read_text(encoding="utf8").splitlines() if line]


persons = {int(r[0]): {"name": r[1], "is_deceased": r[2] == "true", "death_date": r[3] or None, "birth_date": r[4] or None} for r in tsv("persons.tsv")}
artists = {int(r[0]): {"name": r[1], "type": r[2]} for r in tsv("artists.tsv")}
members: dict[int, set[int]] = collections.defaultdict(set)
titular: dict[int, set[int]] = collections.defaultdict(set)
for r in tsv("members.tsv"):
    members[int(r[0])].add(int(r[1]))
    if r[2] == "Titular del proyecto":
        titular[int(r[0])].add(int(r[1]))
credited: dict[int, set[int]] = collections.defaultdict(set)
for r in tsv("credits.tsv"):
    credited[int(r[0])].add(int(r[1]))
by_norm_person: dict[str, set[int]] = collections.defaultdict(set)
for pid, p in persons.items():
    by_norm_person[norm(p["name"])].add(pid)
for r in tsv("person_aliases.tsv"):
    by_norm_person[norm(r[1])].add(int(r[0]))


def person_for_artist(aid: int) -> tuple[int | None, str]:
    """La persona que ES el artista (solista), o None si es un grupo."""
    if titular.get(aid):
        ids = titular[aid]
        if len(ids) == 1:
            return next(iter(ids)), "titular del proyecto"
    same = by_norm_person.get(norm(artists[aid]["name"]), set())
    if len(same) == 1:
        return next(iter(same)), "persona con el mismo nombre"
    if len(members.get(aid, ())) == 1 and artists[aid]["type"] in ("solo_artist", "band"):
        only = next(iter(members[aid]))
        if norm(persons[only]["name"]).split()[:1] == norm(artists[aid]["name"]).split()[:1] or norm(artists[aid]["name"]) in norm(persons[only]["name"]):
            return only, "único integrante cuyo nombre contiene el del artista"
    return None, ""


# --- evidencia -------------------------------------------------------------------

evidence: dict[int, list[dict]] = collections.defaultdict(list)
unresolved: list[dict] = []
counts = collections.Counter()


def add(kind: str, eid: int, source: str, url: str, tier: str, death: str | None, birth: str | None, snippet: str) -> None:
    """Registra evidencia contra una persona (o un artista que la resuelva)."""
    if kind == "person":
        if eid not in persons:
            return
        evidence[eid].append({"tier": tier, "source": source, "url": url, "death": death, "birth": birth, "snippet": snippet, "via": "ficha de persona"})
        counts[(tier, source, "person")] += 1
        return
    if eid not in artists:
        return
    pid, why = person_for_artist(eid)
    if pid is None:
        unresolved.append({"artistId": eid, "artist": artists[eid]["name"], "type": artists[eid]["type"], "tier": tier, "source": source, "url": url, "death": death, "birth": birth, "snippet": snippet})
        counts[(tier, source, "artist-sin-persona")] += 1
        return
    evidence[pid].append({"tier": tier, "source": source, "url": url, "death": death, "birth": birth, "snippet": snippet, "via": f"artista {artists[eid]['name']} ({why})", "artistId": eid})
    counts[(tier, source, "artist")] += 1


# Primera oración de una biografía de persona/solista que dice que murió.
ES_DEAD = re.compile(
    r"(?:fallecid[oa]|falleci[óo]|fallece|muri[óo]|muere)\b[^.;]{0,90}?\b(?:el|en|a los)\b[^.;]{0,25}?(?:(" + DATE_PAT + r")|\b((?:1[89]|20)\d{2})\b)", re.I)
EN_DEAD = re.compile(
    r"\b(?:died|passed away)\b[^.;]{0,60}?(?:(" + DATE_PAT + r")|\b((?:1[89]|20)\d{2})\b)", re.I)
# «Jesús Parra (1982-2010), fué un músico…»: nombre, años de vida y verbo, al
# comienzo del texto. Sin el verbo es una lista de fechas de una banda.
RANGE = re.compile(r"^[^()]{2,90}\(\s*(?:n\.|b\.|born|nacid[oa])?[^()–—-]{0,60}?(\d{4})\s*[-–—]\s*(\d{4})\s*\)\s*,?\s*(?:fue|fué|was|ha sido)\b", re.I)
DISCOGS_DIED = re.compile(r"\b(?:Died|Fallecimiento|Fallecido)\s*:?\s*(?:on\s*)?((?:" + DATE_PAT + r")|(?:1[89]|20)\d{2})", re.I)
BORN = re.compile(r"\b(?:born|nacid[oa]|nació|nacimiento)\b[^.;]{0,25}?(" + DATE_PAT + r")", re.I)


def subject_sentence(text: str, whole: bool = False) -> tuple[str | None, str | None, str] | None:
    head = text[:700] if not whole else text[:6000]
    m = RANGE.search(text[:200])
    if m and 1700 <= int(m.group(1)) < int(m.group(2)) <= 2026 and 8 <= int(m.group(2)) - int(m.group(1)) <= 110:
        return m.group(2), m.group(1), text[max(0, m.start() - 40): m.end() + 20].replace("\n", " ")
    for rx in (ES_DEAD, EN_DEAD):
        m = rx.search(head)
        if m:
            span = head[max(0, m.start() - 60): m.end() + 40].replace("\n", " ")
            raw = m.group(0)
            d = first_date(raw)
            if not d:
                tail = re.findall(r"\b((?:1[89]|20)\d{2})\b", raw)
                d = tail[-1] if tail else None
            b = BORN.search(head)
            return d, first_date(b.group(1)) if b else None, span
    return None


births: dict[int, list[dict]] = collections.defaultdict(list)


def add_birth(kind: str, eid: int, source: str, date: str | None, note: str) -> None:
    """Nacimiento de ficha (solo personas, o el artista que resuelve a una)."""
    if not date:
        return
    pid = eid if kind == "person" else (person_for_artist(eid)[0] if eid in artists else None)
    if pid is None or pid not in persons:
        return
    births[pid].append({"source": source, "date": date, "note": note})


def run() -> None:
    for path in sorted(glob.glob(str(BIO / "*.jsonl"))):
        if "sample" in path:
            continue
        source = Path(path).stem
        for line in open(path, encoding="utf8"):
            r = json.loads(line)
            kind, eid, text, facts, url = r["kind"], int(r["entityId"]), r.get("text") or "", r.get("facts") or {}, r.get("url") or ""
            if kind not in ("artist", "person"):
                continue
            # 1. Datos de ficha.
            if source == "lobotoradio" and facts.get("fallecimiento"):
                add(kind, eid, source, url, "structured", first_date(facts["fallecimiento"]) or year_in(facts["fallecimiento"]),
                    first_date(facts.get("nacimiento", "")) or None, f"fallecimiento: {facts['fallecimiento']}")
            if source == "lobotoradio" and facts.get("nacimiento"):
                add_birth(kind, eid, source, first_date(facts["nacimiento"]) or year_in(facts["nacimiento"]), facts["nacimiento"])
            if source == "musicbrainz" and facts.get("tipo (MusicBrainz)") == "Person" and facts.get("inicio (MusicBrainz)"):
                add_birth(kind, eid, source, facts["inicio (MusicBrainz)"], "MusicBrainz Person, inicio")
            if source == "musicbrainz" and facts.get("fin (MusicBrainz)") and facts.get("tipo (MusicBrainz)") == "Person":
                add(kind, eid, source, url, "structured", facts["fin (MusicBrainz)"], facts.get("inicio (MusicBrainz)"), f"MusicBrainz Person, fin {facts['fin (MusicBrainz)']}")
            if source == "theaudiodb" and re.search(r"died|fallec", json.dumps(facts), re.I):
                add(kind, eid, source, url, "structured", None, None, json.dumps(facts, ensure_ascii=False)[:200])
            # Sincopa: «Born: Died:» con sus fechas debajo.
            if source == "sincopa" and kind == "artist":
                head = text[:900]
                if re.search(r"\bDied\s*:", head):
                    dates = []
                    for m in re.finditer(r"([A-Z][a-z]+)\s*\n?\s*(\d{1,2}),\s*(\d{4})", head):
                        mo = MONTHS_EN.get(m.group(1).lower())
                        if mo:
                            dates.append(iso(int(m.group(3)), mo, int(m.group(2))))
                    born_label = bool(re.search(r"\bBorn\s*:", head))
                    if dates and born_label:
                        add_birth(kind, eid, source, dates[0], "Sincopa Born")
                    if dates:
                        death = dates[1] if born_label and len(dates) >= 2 else (dates[0] if not born_label else None)
                        if death:
                            add(kind, eid, source, url, "structured", death, dates[0] if born_label and len(dates) >= 2 else None, head[:240].replace("\n", " | "))
            if source == "discogs":
                m = DISCOGS_DIED.search(text[:1500])
                if m:
                    b = BORN.search(text[:1500])
                    if b:
                        add_birth(kind, eid, source, first_date(b.group(1)), "Discogs born")
                    add(kind, eid, source, url, "structured", first_date(m.group(1)) or year_in(m.group(1)), first_date(b.group(1)) if b else None, text[max(0, m.start() - 80): m.end() + 40].replace("\n", " "))
            # 2. La primera oración de su biografía.
            if source in ("venciclopedia", "wikipedia", "rhv", "lastfm", "vzlarockea", "lobotoradio", "discogs", "theaudiodb") and text:
                found = subject_sentence(text, whole=source in ("wikipedia", "venciclopedia"))
                if found and not (source == "lobotoradio" and facts.get("fallecimiento")):
                    d, b, span = found
                    add(kind, eid, source, url, "sentence", d, b, span)
            counts[("rows", source, kind)] += 1


# --- nivel «member»: la biografía de una banda cuenta que murió un integrante ---------
DEATH_VERBS = re.compile(
    r"\b(?:fallec\w+|murió|muere|muriera|murieron|falleció|passed away|passed on|died|asesinad[oa]\w*|se suicid\w+|perdió la vida|desaparición física|"
    r"lamentable(?:mente)?[^.]{0,30}partió|r\.?\s?i\.?\s?p\.?|q\.?\s?e\.?\s?p\.?\s?d\.?|\(\s*†\s*\)|†)", re.I)
STOP_TOKENS = {"los", "las", "del", "de", "la", "el", "van", "von", "da", "dos", "san", "santa", "jr", "dj", "mc", "the", "and", "luis", "jose", "carlos", "juan", "pedro", "jesus", "miguel", "angel", "alberto", "antonio", "manuel", "maria", "ana", "francisco", "ricardo", "rafael", "daniel", "david"}


def flat(text: str) -> str:
    """Minúsculas y sin tildes, carácter a carácter: conserva las posiciones del original."""
    out = []
    for ch in text.lower():
        d = unicodedata.normalize("NFD", ch)
        out.append(d[0] if d else ch)
    return "".join(out)


def name_spans(sent_flat: str, name: str) -> tuple[str, int, int] | None:
    """Dónde nombra la oración a esa persona: ('full'|'part', inicio, fin) o None."""
    quoted = re.findall(r'"([^"]{3,30})"', name)
    plain = re.sub(r'"[^"]*"', " ", name)
    tokens = [t for t in norm(plain).split() if t]
    if len(tokens) >= 2:
        m = re.search(r"\b" + r"\W+(?:\w+\W+){0,2}?".join(re.escape(t) for t in (tokens[0], tokens[-1])) + r"\b", sent_flat)
        if m:
            return "full", m.start(), m.end()
    for q in quoted:
        qn = norm(q)
        if len(qn) >= 4:
            m = re.search(rf"\b{re.escape(qn)}\b", sent_flat)
            if m:
                return "part", m.start(), m.end()
    if len(tokens) == 1 and len(tokens[0]) >= 4:
        m = re.search(rf"\b{re.escape(tokens[0])}\b", sent_flat)
        if m:
            return "part", m.start(), m.end()
    for t in tokens:
        if len(t) >= 5 and t not in STOP_TOKENS:
            m = re.search(rf"\b{re.escape(t)}\b", sent_flat)
            if m:
                return "part", m.start(), m.end()
    return None


member_hits: dict[tuple[int, int], list[dict]] = collections.defaultdict(list)


def member_pass(aid: int, text: str, source: str, url: str) -> None:
    if aid not in artists or not text:
        return
    cands = (members.get(aid, set()) | credited.get(aid, set()))
    if not cands:
        return
    for sent in re.split(r"(?<=[.!?;])\s+|\n+", text[:8000]):
        if len(sent) < 12:
            continue
        verb = DEATH_VERBS.search(sent)
        if not verb:
            continue
        sf = flat(sent)
        vs, ve = verb.start(), verb.end()
        near = []
        for pid in cands:
            if pid not in persons:
                continue
            hit = name_spans(sf, persons[pid]["name"])
            if not hit:
                continue
            level, ns, ne = hit
            gap = max(0, ns - ve) if ns >= ve else max(0, vs - ne)
            # «murió Omar Paduay y…»: el nombre pegado al verbo; el resto de la lista queda lejos.
            if gap <= 45:
                near.append((gap, level, pid))
        if not near:
            continue
        best = min(g for g, _, _ in near)
        close = [(g, l, p) for g, l, p in near if g <= best + 8]
        for gap, level, pid in close:
            member_hits[(pid, aid)].append({"source": source, "url": url, "level": level, "ambiguous": len(close) > 1, "gap": gap, "snippet": sent.strip()[:260],
                                            "death": first_date(sent) or (re.findall(r"\b((?:19|20)\d{2})\b", sent) or [None])[-1]})


def member_all() -> None:
    for path in sorted(glob.glob(str(BIO / "*.jsonl"))):
        if "sample" in path:
            continue
        source = Path(path).stem
        for line in open(path, encoding="utf8"):
            r = json.loads(line)
            if r["kind"] == "artist":
                member_pass(int(r["entityId"]), r.get("text") or "", source, r.get("url") or "")
    for line in open(OUT / "bio-claims.tsv", encoding="utf8"):
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= 4 and parts[0] == "artist" and parts[2] == "rock-de-vzla":
            member_pass(int(parts[1]), json.loads(parts[3]) if parts[3].startswith('"') else parts[3], "rock-de-vzla (claim)", "")
    with open(OUT / "member-candidates.jsonl", "w", encoding="utf8") as fh:
        for (pid, aid), hits in sorted(member_hits.items()):
            fh.write(json.dumps({"personId": pid, "name": persons[pid]["name"], "artistId": aid, "artist": artists[aid]["name"],
                                 "alreadyEvidenced": pid in evidence, "alreadyMarked": persons[pid]["is_deceased"] or bool(persons[pid]["death_date"]),
                                 "hits": hits}, ensure_ascii=False) + "\n")
    print(f"integrantes con mención de muerte: {len(member_hits)}", file=sys.stderr)



run()
OUT.mkdir(parents=True, exist_ok=True)
member_all()
with open(OUT / "candidates.jsonl", "w", encoding="utf8") as fh:
    for pid, ev in sorted(evidence.items()):
        deaths = sorted({e["death"] for e in ev if e["death"]})
        tiers = sorted({e["tier"] for e in ev})
        fh.write(json.dumps({"personId": pid, "name": persons[pid]["name"], "alreadyMarked": persons[pid]["is_deceased"] or bool(persons[pid]["death_date"]),
                             "deathDates": deaths, "tiers": tiers, "sources": sorted({e["source"] for e in ev}), "evidence": ev}, ensure_ascii=False) + "\n")
with open(OUT / "births.jsonl", "w", encoding="utf8") as fh:
    for pid, bs in sorted(births.items()):
        fh.write(json.dumps({"personId": pid, "name": persons[pid]["name"], "dbBirth": persons[pid]["birth_date"], "births": bs}, ensure_ascii=False) + "\n")
with open(OUT / "unresolved.jsonl", "w", encoding="utf8") as fh:
    for u in unresolved:
        fh.write(json.dumps(u, ensure_ascii=False) + "\n")
print(f"personas con evidencia: {len(evidence)}; artistas sin persona: {len({u['artistId'] for u in unresolved})}", file=sys.stderr)
for key, n in sorted(counts.items(), key=lambda kv: str(kv[0])):
    if key[0] != "rows":
        print(key, n, file=sys.stderr)
