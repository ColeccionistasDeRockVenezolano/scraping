#!/usr/bin/env python3
"""Géneros del blog Vzla Rockea (vzlarockea.com, Blogger) para fichas sin principal.

Blog dedicado a bandas venezolanas: cada post etiqueta al artista y sus
géneros (etiquetas de Blogger). Dos clases de post:
  «Artista - Disco»          → las etiquetas de género van al DISCO (título exacto).
  «Artista Discografia/…»    → describen al ARTISTA (toda su obra) → solo al artista.
Separación estricta: nada pasa de uno a otro.

Identidad: el blog solo publica bandas venezolanas (prueba de país), el artista
del post casa exacto con el catálogo y no tiene homónimos; el disco casa por
título exacto dentro de ese artista.

Feed JSON público de Blogger (14 páginas), una petición por segundo.
Caché en data/raw/vzlarockea. Salida: reports/genre-laya-evidence-vzlarockea-2026-09-26.jsonl
Uso: python3 scripts/harvest-vzlarockea-genres.py <pending.json>
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import unicodedata
import urllib.request
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "raw" / "vzlarockea"
OUT = ROOT / "reports" / "genre-laya-evidence-vzlarockea-2026-09-26.jsonl"
TEXTS = ROOT / "reports" / "genre-new-texts-vzlarockea-2026-09-27.jsonl"
UA = "CRV-catalogo/1.0 (catalogo de rock venezolano; uso no comercial)"
FEED = "https://www.vzlarockea.com/feeds/posts/default?alt=json&max-results=150&start-index={}"
NOT_GENRE = re.compile(r"^(discograf[ií]a|discografia completa|compilado|compilados?|demos?|ep|lp|singles?|en vivo|live|varios|v\.?a\.?|venezuela|videos?|noticias?|bootleg|tributo|especial|\d{4}s?)$", re.I)


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", text)


def title_key(text: str) -> str:
    return norm(re.sub(r"\s*[\(\[](?:\d{4}|ep|lp|single|demo|remaster[^)\]]*)[\)\]]\s*$", "", text or "", flags=re.I))


def get(url: str) -> dict:
    path = CACHE / (hashlib.sha256(url.encode()).hexdigest() + ".json")
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    time.sleep(1.0)
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=60) as res:
        data = json.loads(res.read().decode("utf-8"))
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def main() -> None:
    pending = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    CACHE.mkdir(parents=True, exist_ok=True)
    pending_artists = {int(a["id"]) for a in pending["artists"]}
    pending_albums = {int(a["id"]) for a in pending["albums"]}
    by_name: dict[str, list[dict]] = {}
    for artist in pending["allArtists"]:
        by_name.setdefault(norm(artist["name"]), []).append(artist)

    posts: list[dict] = []
    start = 1
    while True:
        feed = get(FEED.format(start))["feed"]
        entries = feed.get("entry", [])
        for entry in entries:
            link = next((l["href"] for l in entry.get("link", []) if l.get("rel") == "alternate"), None)
            posts.append({"title": unescape(entry["title"]["$t"]).strip(), "url": link,
                          "labels": [c["term"] for c in entry.get("category", [])],
                          "text": re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", entry.get("content", {}).get("$t", "")))).strip()})
        if len(entries) < 150:
            break
        start += 150

    rows: dict[str, dict] = {}
    doubts: list[dict] = []
    stats = {"posts": len(posts), "posts_artista_casado": 0, "discos_casados": 0, "discos_con_genero": 0,
             "artistas_con_genero": 0, "homonimos": 0}
    for post in posts:
        title = post["title"]
        match = re.match(r"^(.+?)\s+[-–]\s+(.+)$", title)
        discography = re.match(r"^(.+?)\s+(?:[-–]\s+)?(?:discograf[ií]a|discografia)\b", title, flags=re.I)
        artist_label = None
        artist_part = (discography.group(1) if discography else match.group(1) if match else "").strip()
        # El artista es la etiqueta que casa con la parte del título.
        for label in post["labels"]:
            if norm(label) and norm(label) == norm(artist_part):
                artist_label = label
        if not artist_label:
            continue
        candidates = by_name.get(norm(artist_label), [])
        if not candidates:
            continue
        if len(candidates) > 1:
            stats["homonimos"] += 1
            doubts.append({"post": post["url"], "artist": artist_label, "ids": [c["id"] for c in candidates]})
            continue
        artist = candidates[0]
        artist_id = int(artist["id"])
        stats["posts_artista_casado"] += 1
        genres = [l for l in post["labels"] if norm(l) != norm(artist_label) and not NOT_GENRE.match(l.strip())]
        if not genres:
            continue
        if discography:
            if artist_id in pending_artists:
                key = f"artist:{artist_id}"
                if key not in rows:
                    stats["artistas_con_genero"] += 1
                    rows[key] = {"caseId": key, "kind": "artist", "entityId": artist_id, "source": "vzlarockea", "url": post["url"],
                                 "title": artist["name"], "rawGenres": genres,
                                 "identity": "post de discografía del blog venezolano Vzla Rockea con el nombre exacto",
                                 "order": "alfabético (etiquetas de Blogger): el primero NO es necesariamente el principal"}
            continue
        album_title = match.group(2) if match else ""
        hits = [a for a in (artist.get("albums") or []) if title_key(a["title"]) == title_key(album_title)]
        if len(hits) != 1:
            continue
        stats["discos_casados"] += 1
        album_id = int(hits[0]["id"])
        key = f"album:{album_id}"
        if album_id in pending_albums and key not in rows:
            stats["discos_con_genero"] += 1
            rows[key] = {"caseId": key, "kind": "album", "entityId": album_id, "source": "vzlarockea", "url": post["url"],
                         "title": f"{artist['name']} - {hits[0]['title']}", "rawGenres": genres,
                         "identity": "post del disco en el blog venezolano Vzla Rockea: artista y título exactos",
                         "order": "alfabético (etiquetas de Blogger): el primero NO es necesariamente el principal"}

    OUT.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows.values()), encoding="utf-8")
    (ROOT / "reports" / "harvest-vzlarockea-2026-09-27.json").write_text(
        json.dumps({"stats": stats, "dudas": doubts}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats), flush=True)


if __name__ == "__main__":
    main()
