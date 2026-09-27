#!/usr/bin/env python3
"""Géneros de Last.fm (API oficial 2.0) para fichas sin principal.

Regla de Brian: una fuente basta. Identidad: el artista de Last.fm tiene el
nombre exacto (normalizado) y además Last.fm lo marca como venezolano
(etiqueta «venezuela»/«venezolano»/«caracas»… o su biografía menciona
Venezuela). Biografías que agrupan varios artistas homónimos se descartan: sus
etiquetas mezclan bandas. Homónimos dentro del catálogo tampoco se buscan.
Separación: etiquetas del artista → artista; del disco → disco. Nada se hereda.

Solo la API (https://www.last.fm/api), nunca la web. Métodos, con autocorrect=0
para que Last.fm no cambie el nombre pedido:
  artist.getInfo    (artist)        nombre canónico, URL y biografía
  artist.getTopTags (artist)        etiquetas con peso (count)
  album.getInfo     (artist, album) nombre canónico, URL y reseña del disco
  album.getTopTags  (artist, album) etiquetas del disco con peso
Las etiquetas van por peso descendente: la primera que la taxonomía resuelva es
la principal en scripts/apply-source-genres.ts. Las geográficas sirven a la
identidad y no pasan como género.
Las etiquetas del disco salen de album.getTopTags y no de album.getInfo: cuando
el disco no tiene etiquetas propias, getInfo devuelve las del artista (sería heredar).

Clave en LASTFM_API_KEY (entorno o .env); nunca se imprime ni entra en la caché.
Ritmo ~3 peticiones/s, una a la vez; error 29 o 5xx → espera y reintenta;
error 6 → sin página; error 10/26 → aborta. Caché en data/raw/lastfm por hash
de la petición sin la clave: repetir la corrida no vuelve a pedir nada.
Salidas: reports/genre-laya-evidence-lastfm-2026-09-26.jsonl,
reports/genre-new-texts-lastfm-2026-09-27.jsonl y reports/harvest-lastfm-<fecha>.json.
Uso: python3 scripts/harvest-lastfm-genres.py <pending.json> [--limit N]
"""
from __future__ import annotations

import datetime
import hashlib
import json
import os
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "raw" / "lastfm"
OUT = ROOT / "reports" / "genre-laya-evidence-lastfm-2026-09-26.jsonl"
TEXTS = ROOT / "reports" / "genre-new-texts-lastfm-2026-09-27.jsonl"
API = "https://ws.audioscrobbler.com/2.0/"
UA = "CRV-catalogo/1.0 (catalogo de rock venezolano; uso no comercial)"
DELAY = 0.3
_last = [0.0]
COUNTS = {"nuevas": 0, "fallidas": 0}
VZ_TAG = re.compile(r"venezuel|venezolan|caracas|maracaibo|valencia venezuela", re.I)
GEO_TAG = re.compile(r"(latin ?america|latinoamerica|south ?america|sudamerica)n?|(colombia|mexic|argentin|chile|peru|span|espa)\w*"
                     r"|usa|miami|new york|los angeles", re.I)
MULTI = re.compile(r"(there (are|is) (more than one|multiple|several|many|at least \w+|\d+|two|three|four|five|six|seven|eight|nine|ten)( different| distinct)? (artists?|bands?|acts?|musicians?)\b)"
                   r"|hay (varios|m[aá]s de un)", re.I)


class Abort(Exception):
    pass


def api_key() -> str:
    key = os.environ.get("LASTFM_API_KEY", "").strip()
    env = ROOT / ".env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("LASTFM_API_KEY="):
                key = line.split("=", 1)[1].strip().strip("'\"")
    if not key:
        raise Abort("falta LASTFM_API_KEY en .env (se crea en https://www.last.fm/api/account/create)")
    return key


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", text)


def clean_title(text: str) -> str:
    return re.sub(r"\s*\((?:\d{4}|ep|lp|single|demo|remaster[^)]*)\)\s*$", "", text or "", flags=re.I).strip()


def call(key: str, method: str, **params: str) -> dict:
    """Una petición a la API; {} si falló sin remedio, {"error": 6} si no existe."""
    query = {"method": method, **params, "autocorrect": "0", "format": "json"}
    cache = CACHE / (hashlib.sha256(json.dumps(query, sort_keys=True).encode()).hexdigest() + ".json")
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    url = API + "?" + urllib.parse.urlencode({**query, "api_key": key})
    data: dict = {}
    for attempt in range(5):
        wait = DELAY - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        COUNTS["nuevas"] += 1
        status = 200
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as res:
                body = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            status = exc.code
            try:
                body = json.loads(exc.read().decode("utf-8"))
            except Exception:
                body = {}
        except Exception:
            status, body = 0, {}
        finally:
            _last[0] = time.time()
        error = int(body.get("error") or 0) if isinstance(body, dict) else 0
        if error in (10, 26):
            raise Abort(f"Last.fm rechaza la clave (error {error}: {body.get('message', '')}); revisa LASTFM_API_KEY")
        if error == 6:
            data = {"error": 6}
            break
        if error == 29:
            time.sleep(60 * (attempt + 1))
            continue
        if error or status >= 500 or status == 0 or not body:
            time.sleep(10 * (attempt + 1))
            continue
        data = body
        break
    if not data:
        COUNTS["fallidas"] += 1
        return {}
    cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def listed(value) -> list:
    return value if isinstance(value, list) else [value] if isinstance(value, dict) else []


def weighted_tags(data: dict) -> list[str]:
    tags = listed((data.get("toptags") or {}).get("tag"))
    tags = sorted(tags, key=lambda t: -int(t.get("count") or 0))
    return [t["name"].strip() for t in tags if int(t.get("count") or 0) > 0 and t.get("name", "").strip()]


def prose(block: dict | None) -> str:
    text = (block or {}).get("content") or (block or {}).get("summary") or ""
    text = re.sub(r"<a [^>]*>Read more on Last\.fm</a>\.?", " ", text)
    text = re.sub(r"User-contributed text is available under the Creative Commons By-SA License;.*$", " ", text, flags=re.S)
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", text))).strip()


def genres_only(tags: list[str]) -> list[str]:
    return [t for t in tags if not VZ_TAG.search(t) and not GEO_TAG.fullmatch(t)]


def main() -> None:
    pending = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    key = api_key()
    CACHE.mkdir(parents=True, exist_ok=True)
    pending_artists = {int(a["id"]) for a in pending["artists"]}
    albums_by_artist: dict[int, list[dict]] = {}
    for album in pending["albums"]:
        albums_by_artist.setdefault(int(album["artist_id"]), []).append(album)
    names = {int(a["id"]): a["name"] for a in pending["allArtists"]}
    homonyms: dict[str, int] = {}
    for name in names.values():
        homonyms[norm(name)] = homonyms.get(norm(name), 0) + 1
    targets = sorted(pending_artists | set(albums_by_artist))
    various = [t for t in targets if re.match(r"^(various|varios|va\b)", (names.get(t) or "").lower())]
    targets = [t for t in targets if t not in various]
    if limit:
        targets = targets[:limit]

    rows: list[dict] = []
    texts: list[dict] = []
    doubts: list[dict] = []
    stats = {"buscados": 0, "varios_artistas": len(various), "homonimos_catalogo": 0, "sin_pagina": 0, "sin_marca_vz": 0,
             "pagina_agrupa_homonimos": 0, "casados": 0, "artistas_con_genero": 0, "artistas_sin_etiquetas": 0,
             "artistas_con_texto": 0, "discos_probados": 0, "discos_casados": 0, "discos_con_genero": 0, "discos_con_texto": 0}
    started = time.time()
    for index, artist_id in enumerate(targets, 1):
        name = names[artist_id]
        stats["buscados"] += 1
        if not norm(name) or homonyms.get(norm(name), 0) > 1:
            stats["homonimos_catalogo"] += 1
            continue
        info = call(key, "artist.getInfo", artist=name).get("artist") or {}
        if not info or norm(info.get("name", "")) != norm(name):
            stats["sin_pagina"] += 1
            continue
        url = info.get("url") or ""
        bio = prose(info.get("bio"))
        if MULTI.search(bio):
            stats["pagina_agrupa_homonimos"] += 1
            doubts.append({"artistId": artist_id, "name": name, "url": url, "motivo": "la biografía agrupa varios artistas"})
            continue
        artist_tags = weighted_tags(call(key, "artist.getTopTags", artist=name))
        if not (any(VZ_TAG.search(t) for t in artist_tags) or re.search(r"venezuel", bio, re.I)):
            stats["sin_marca_vz"] += 1
            continue
        stats["casados"] += 1
        if artist_id in pending_artists:
            values = genres_only(artist_tags)
            if values:
                stats["artistas_con_genero"] += 1
                rows.append({"caseId": f"artist:{artist_id}", "kind": "artist", "entityId": artist_id, "source": "lastfm",
                             "url": url, "title": name, "rawGenres": values,
                             "identity": "nombre exacto + Last.fm lo marca como venezolano (API)"})
            else:
                stats["artistas_sin_etiquetas"] += 1
            if len(bio) >= 80:
                stats["artistas_con_texto"] += 1
                texts.append({"caseId": f"artist:{artist_id}", "kind": "artist", "entityId": artist_id, "source": "lastfm", "url": url, "text": bio})
        for album in albums_by_artist.get(artist_id, []):
            stats["discos_probados"] += 1
            title = clean_title(album["title"])
            record = call(key, "album.getInfo", artist=name, album=title).get("album") or {}
            if not record or norm(clean_title(record.get("name", ""))) != norm(title):
                continue
            stats["discos_casados"] += 1
            album_url = record.get("url") or ""
            values = genres_only(weighted_tags(call(key, "album.getTopTags", artist=name, album=title)))
            if values:
                stats["discos_con_genero"] += 1
                rows.append({"caseId": f"album:{album['id']}", "kind": "album", "entityId": int(album["id"]), "source": "lastfm",
                             "url": album_url, "title": f"{name} - {album['title']}", "rawGenres": values,
                             "identity": "artista casado + título exacto del disco en Last.fm (API)"})
            review = prose(record.get("wiki"))
            if len(review) >= 80:
                stats["discos_con_texto"] += 1
                texts.append({"caseId": f"album:{album['id']}", "kind": "album", "entityId": int(album["id"]), "source": "lastfm", "url": album_url, "text": review})
        if index % 25 == 0:
            elapsed = time.time() - started
            eta = elapsed / index * (len(targets) - index)
            print(f"[{index}/{len(targets)} {100 * index / len(targets):.0f}% · ETA {eta / 60:.1f} min] "
                  f"casados={stats['casados']} peticiones={COUNTS['nuevas']} fallidas={COUNTS['fallidas']}", flush=True)

    OUT.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    TEXTS.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in texts), encoding="utf-8")
    summary = {**stats, "peticiones_nuevas": COUNTS["nuevas"], "peticiones_fallidas": COUNTS["fallidas"]}
    (ROOT / "reports" / f"harvest-lastfm-{datetime.date.today().isoformat()}.json").write_text(
        json.dumps({"stats": summary, "dudas": doubts}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Abort as exc:
        print(f"abortado: {exc}", file=sys.stderr)
        sys.exit(2)
