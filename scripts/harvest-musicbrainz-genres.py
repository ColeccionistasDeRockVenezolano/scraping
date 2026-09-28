#!/usr/bin/env python3
"""Géneros de MusicBrainz (genres y tags) para fichas sin principal.

Regla de Brian: una fuente basta. Identidad: artista de MusicBrainz con el
nombre exacto (o un alias exacto) y país/área Venezuela (la búsqueda filtra
country:VE), único candidato. Discos: release-groups de ESE artista (por MBID)
con título exacto. Separación: géneros del artista → artista; del
release-group → disco. Se prefieren los «genres» curados; si no hay, los tags
con votos, en orden de votos.

API ws/2, una petición por segundo y User-Agent propio (norma de MusicBrainz).
Caché en data/raw/musicbrainz. Salida: reports/genre-laya-evidence-musicbrainz-2026-09-26.jsonl
Uso: python3 scripts/harvest-musicbrainz-genres.py <pending.json> [--limit N]
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "raw" / "musicbrainz"
OUT = ROOT / "reports" / "genre-laya-evidence-musicbrainz-2026-09-26.jsonl"
UA = "CRV-catalogo/1.0 (catalogo de rock venezolano; uso no comercial)"
DELAY = 1.1
_last = [0.0]
FAILED = [0]


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", text)


def title_key(text: str) -> str:
    return norm(re.sub(r"\s*\((?:\d{4}|ep|lp|single|demo|remaster[^)]*)\)\s*$", "", text or "", flags=re.I))


def get(path: str, params: dict) -> dict:
    url = f"https://musicbrainz.org/ws/2/{path}?" + urllib.parse.urlencode({**params, "fmt": "json"})
    cache = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    if cache.exists():
        return json.loads(cache.read_text(encoding="utf-8"))
    data: dict = {}
    for attempt in range(4):
        wait = DELAY - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=30) as res:
                data = json.loads(res.read().decode("utf-8"))
            _last[0] = time.time()
            break
        except urllib.error.HTTPError as exc:
            _last[0] = time.time()
            if exc.code == 404:
                data = {"_404": True}
                break
            time.sleep(5 * (attempt + 1))  # 503 = ritmo excedido
        except Exception:
            _last[0] = time.time()
            time.sleep(5 * (attempt + 1))
    if not data:
        FAILED[0] += 1
    if data:
        cache.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def labels(entity: dict) -> list[str]:
    genres = sorted(entity.get("genres") or [], key=lambda g: -int(g.get("count") or 0))
    if genres:
        return [g["name"] for g in genres if int(g.get("count") or 0) > 0] or [g["name"] for g in genres]
    tags = sorted(entity.get("tags") or [], key=lambda t: -int(t.get("count") or 0))
    return [t["name"] for t in tags if int(t.get("count") or 0) > 0]


def quote(text: str) -> str:
    return '"' + re.sub(r'([+\-&|!(){}\[\]^"~*?:\\/])', r"\\\1", text) + '"'


def main() -> None:

    pending = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
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
    targets = [t for t in targets if not re.match(r"^(various|varios|va\b)", (names.get(t) or "").lower())]
    if limit:
        targets = targets[:limit]

    rows: list[dict] = []
    doubts: list[dict] = []
    stats = {"buscados": 0, "casados": 0, "sin_resultado": 0, "ambiguos": 0, "artistas_con_genero": 0,
             "discos_probados": 0, "discos_casados": 0, "discos_con_genero": 0}
    for index, artist_id in enumerate(targets, 1):
        name = names[artist_id]
        stats["buscados"] += 1
        if not norm(name) or homonyms.get(norm(name), 0) > 1:
            stats["ambiguos"] += 1
            continue
        found = get("artist", {"query": f"(artist:{quote(name)} OR alias:{quote(name)}) AND country:VE", "limit": "10"})
        exact = [a for a in found.get("artists", [])
                 if norm(a.get("name", "")) == norm(name) or any(norm(x.get("name", "")) == norm(name) for x in a.get("aliases") or [])]
        if not exact:
            stats["sin_resultado"] += 1
            continue
        if len(exact) > 1:
            stats["ambiguos"] += 1
            doubts.append({"artistId": artist_id, "name": name, "candidatos": [a["id"] for a in exact]})
            continue
        mbid = exact[0]["id"]
        stats["casados"] += 1
        url = f"https://musicbrainz.org/artist/{mbid}"
        if artist_id in pending_artists:
            detail = get(f"artist/{mbid}", {"inc": "genres+tags"})
            values = labels(detail)
            if values:
                stats["artistas_con_genero"] += 1
                rows.append({"caseId": f"artist:{artist_id}", "kind": "artist", "entityId": artist_id, "source": "musicbrainz",
                             "url": url, "title": name, "rawGenres": values,
                             "identity": "nombre exacto + país Venezuela en MusicBrainz, candidato único"})
        wanted = albums_by_artist.get(artist_id, [])
        if not wanted:
            continue
        groups = get("release-group", {"artist": mbid, "inc": "genres+tags", "limit": "100"}).get("release-groups", [])
        by_title: dict[str, list[dict]] = {}
        for group in groups:
            by_title.setdefault(title_key(group.get("title", "")), []).append(group)
        for album in wanted:
            stats["discos_probados"] += 1
            hits = by_title.get(title_key(album["title"]), [])
            if len(hits) != 1:
                continue
            stats["discos_casados"] += 1
            values = labels(hits[0])
            if values:
                stats["discos_con_genero"] += 1
                rows.append({"caseId": f"album:{album['id']}", "kind": "album", "entityId": int(album["id"]), "source": "musicbrainz",
                             "url": f"https://musicbrainz.org/release-group/{hits[0]['id']}", "title": f"{name} - {album['title']}",
                             "rawGenres": values, "identity": "release-group del artista casado con título exacto"})
        if index % 10 == 0:
            print(f"[{index}/{len(targets)}] {json.dumps(stats)} fallidas={FAILED[0]}", flush=True)

    OUT.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    (ROOT / "reports" / "harvest-musicbrainz-2026-09-27.json").write_text(
        json.dumps({"stats": stats, "dudas": doubts}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({**stats, "peticiones_fallidas": FAILED[0]}), flush=True)


if __name__ == "__main__":
    main()
