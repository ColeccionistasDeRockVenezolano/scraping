#!/usr/bin/env python3
"""Directorio de Rock Hecho en Venezuela (rockhechovenezuela.com): biografías y
género de artista para fichas sin principal.

El sitio es un directorio exclusivamente de rock venezolano, organizado en
subsitios WordPress por letra (/00/, /a/, … /k/ publicados a la fecha). Cada
entrada es la biografía de una banda o solista.

Identidad: título de la entrada = nombre exacto del artista (normalizado),
el sitio solo cubre artistas venezolanos (prueba independiente de país) y el
nombre no se repite en el catálogo. Si hay varias entradas con el mismo nombre
(«aborigen», «aborigen-2»), se descarta.

Género: la frase de presentación («X es una banda de metal industrial y death
metal que…») → rawGenres del ARTISTA, en el orden del texto. La biografía entera
se guarda como texto propio del artista. Nada va a discos (separación).

API REST pública de WordPress, una petición por segundo; robots.txt no prohíbe
nada. Caché en data/raw/rock-hecho-en-venezuela-directorio.
Salida: reports/genre-laya-evidence-rhv-directorio-2026-09-26.jsonl y
reports/genre-new-texts-rhv-directorio-2026-09-27.jsonl
Uso: python3 scripts/harvest-rhv-directory.py <pending.json>
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "raw" / "rock-hecho-en-venezuela-directorio"
OUT = ROOT / "reports" / "genre-laya-evidence-rhv-directorio-2026-09-26.jsonl"
TEXTS = ROOT / "reports" / "genre-new-texts-rhv-directorio-2026-09-27.jsonl"
UA = "CRV-catalogo/1.0 (catalogo de rock venezolano; uso no comercial)"
LETTERS = ["00"] + [chr(c) for c in range(ord("a"), ord("z") + 1)]
_last = [0.0]

SUBJECT = r"(?:banda|agrupaci[oó]n|grupo|proyecto(?: musical)?|d[uú]o|tr[ií]o|cuarteto|quinteto|orquesta|colectivo|cantante|cantautora?|solista|m[uú]sico|guitarrista|compositora?|artista|rapero|dj)"
PHRASE = re.compile(
    r"\bes (?:una?|el|la) (?:[a-záéíóúñ]+ )?" + SUBJECT + r"(?: [a-záéíóúñ]+)?(?: venezolan[oa])? de ([^.;:]+?)"
    r"(?=\s+(?:que|formad|fundad|cread|originari|nacid|surgid|conformad|integrad|oriund|proveniente|con sede|desde|en (?:la|el|los|las)?\s*[A-Z])|[,.;:]|$)",
    re.I,
)


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", text)


def get(url: str):
    path = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    wait = 1.0 - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    data = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"}), timeout=60) as res:
                data = json.loads(res.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as exc:  # type: ignore[attr-defined]
            if exc.code in (400, 404):
                data = []
                break
            time.sleep(10 * (attempt + 1))
        except json.JSONDecodeError:
            data = []  # subsitio sin publicar: responde HTML
            break
        except Exception:
            time.sleep(10 * (attempt + 1))
        finally:
            _last[0] = time.time()
    if data is not None:
        path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data or []


def plain(html: str) -> str:
    text = re.sub(r"<br\s*/?>|</p>|</h\d>|</li>", "\n", html or "", flags=re.I)
    text = unescape(re.sub(r"<[^>]+>", " ", text))
    return re.sub(r"[ \t]+", " ", re.sub(r"\n\s*\n+", "\n", text)).strip()


STOP = r"(?=\s+(?:que|formad|fundad|cread|originari|nacid|surgid|conformad|integrad|oriund|procedente|proveniente|con sede|desde|durante|a (?:finales|mediados|principios)|en (?:la|el|los|las)?\s*(?:ciudad|a[nñ]o|[A-Z]))|\s+con\s+(?:elementos|toques|influencias|letras|composiciones|matices|tintes)|[,.;:(]|$)"
PATTERNS = [
    # «X es una banda de metal industrial y death metal que…»
    re.compile(r"\bes (?:una?|el|la) (?:[a-záéíóúñ]+ )?" + SUBJECT + r"(?: [a-záéíóúñ]+)?(?: venezolan[oa])? de ((?:[^.;:,(]|,(?! que))+?)" + STOP, re.I),
    # «Banda de anarco-punk formada en…», «Blindaje, Banda de hard rock y heavy metal formada…»
    re.compile(r"^(?:[^.\n]{0,50}?,\s*)?" + SUBJECT + r" de ((?:[^.;:(]|,(?! (?:formad|fundad)))+?)" + STOP, re.I),
    # «Con un estilo que se centra en el hard rock y heavy metal», «un sonido que mezcla el doom, gothic y death metal»
    re.compile(r"(?:estilo|sonido|propuesta(?: musical)?|m[uú]sica)\s+(?:que se (?:centra|enmarca|basa|inscribe) en|que (?:mezcla|combina|fusiona|conjuga)|donde (?:se )?(?:fusiona|mezcla|combina)n?|basad[oa] en|enmarcad[oa] en|cercan[oa] al?|de corte|orientad[oa] (?:hacia|al?))\s+((?:[^.;:(]|,)+?)" + STOP.replace("[,.;:(]", "[.;:(]"), re.I),
]


def phrase_genres(text: str) -> list[str]:
    head = re.sub(r"^Directorio\s*«[^»]*»\s*_+\s*", "", text.strip())
    head = " ".join(head.split("\n")[:3])[:700]
    match = None
    for pattern in PATTERNS:
        match = pattern.search(head)
        if match:
            break
    if not match:
        return []
    raw = re.sub(r"\b(?:corte|estilo|g[eé]nero|tendencia|l[ií]nea|vertiente|propuesta|m[uú]sica|sonido|elementos)\s+(?:de(?:l)?\s+)?", "", match.group(1), flags=re.I)
    parts = re.split(r",\s*|\s+y\s+|\s+e\s+|\s*/\s*|\s+con\s+(?:el|la|los|las)?\s*", raw)
    out: list[str] = []
    for part in parts:
        part = re.sub(r"^(?:el|la|los|las|un|una|tendencias del?|corrientes del?)\s+", "", part.strip(" «»\"'"), flags=re.I)
        part = re.sub(r"\s+(?:y|e|de|combinad[oa]s?|de una manera)$", "", part, flags=re.I)
        if part and len(part) <= 40 and len(part.split()) <= 4 and part.lower() not in [o.lower() for o in out]:
            out.append(part)
    return out


def main() -> None:
    import urllib.error  # noqa: F401  (usado en get)
    pending = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    CACHE.mkdir(parents=True, exist_ok=True)
    pending_artists = {int(a["id"]) for a in pending["artists"]}
    by_name: dict[str, list[int]] = {}
    for artist in pending["allArtists"]:
        by_name.setdefault(norm(artist["name"]), []).append(int(artist["id"]))

    entries: list[dict] = []
    for letter in LETTERS:
        for kind in ("posts", "pages"):
            page = 1
            while True:
                batch = get(f"https://rockhechovenezuela.com/{letter}/wp-json/wp/v2/{kind}?per_page=100&page={page}&_fields=link,title,content")
                if not isinstance(batch, list) or not batch:
                    break
                for item in batch:
                    title = plain(item["title"]["rendered"])
                    text = plain(item["content"]["rendered"])
                    if len(text) > 120:
                        entries.append({"letter": letter, "url": item["link"], "title": title, "text": text})
                if len(batch) < 100:
                    break
                page += 1
    counts: dict[str, int] = {}
    for entry in entries:
        counts[norm(entry["title"])] = counts.get(norm(entry["title"]), 0) + 1

    rows, texts, doubts = [], [], []
    stats = {"entradas": len(entries), "casadas": 0, "pendientes_con_genero": 0, "pendientes_con_texto": 0,
             "sin_frase": 0, "homonimos": 0}
    for entry in entries:
        key = norm(entry["title"])
        ids = by_name.get(key, [])
        if not ids:
            continue
        if len(ids) > 1 or counts[key] > 1:
            stats["homonimos"] += 1
            doubts.append({"title": entry["title"], "url": entry["url"], "artistIds": ids, "motivo": "homónimo en catálogo o en RHV"})
            continue
        artist_id = ids[0]
        stats["casadas"] += 1
        if artist_id not in pending_artists:
            continue
        genres = phrase_genres(entry["text"])
        base = {"caseId": f"artist:{artist_id}", "kind": "artist", "entityId": artist_id, "source": "rhv-directorio", "url": entry["url"]}
        if genres:
            stats["pendientes_con_genero"] += 1
            rows.append({**base, "title": entry["title"], "rawGenres": genres,
                         "identity": "nombre exacto en el directorio de rock venezolano RHV, sin homónimos"})
        else:
            stats["sin_frase"] += 1
        stats["pendientes_con_texto"] += 1
        texts.append({**base, "text": entry["text"][:4000]})

    OUT.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    TEXTS.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in texts), encoding="utf-8")
    (ROOT / "reports" / "harvest-rhv-directorio-2026-09-27.json").write_text(
        json.dumps({"stats": stats, "dudas": doubts}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats), flush=True)


if __name__ == "__main__":
    main()
