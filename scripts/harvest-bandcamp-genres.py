#!/usr/bin/env python3
"""Géneros de Bandcamp para fichas sin principal (regla de Brian: una fuente basta).

Identidad: el nombre de la banda casa exacto (normalizado), Bandcamp la ubica en
Venezuela (prueba independiente) y no hay otra banda venezolana homónima.
Separación: las etiquetas de la banda van solo al artista; las del disco (que la
API de búsqueda devuelve por disco) van solo al disco. Nada se hereda. Solo se usa
la API pública de búsqueda: las páginas piden un desafío anti-bot y no se evade.

Entrada: pending.json (export de fichas pendientes). Caché en data/raw/bandcamp.
Salida: reports/genre-laya-evidence-bandcamp-2026-09-26.jsonl
Uso: python3 scripts/harvest-bandcamp-genres.py <pending.json> [--limit N]
"""
from __future__ import annotations

import hashlib
from html import unescape
import json
import re
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "raw" / "bandcamp"
OUT = ROOT / "reports" / "genre-laya-evidence-bandcamp-2026-09-26.jsonl"
UA = "CRV-catalogo/1.0 (catalogo de rock venezolano; uso no comercial)"
API = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic"
DELAY = 2.0
_last = [0.0]
FAILED = [0]


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    text = text.replace("&", " and ")
    text = re.sub(r"^(the|los|las|la|el)\s+", "", text.strip())
    return re.sub(r"[^a-z0-9]+", "", text)


def title_key(text: str) -> str:
    text = re.sub(r"\((?:\d{4}|ep|lp|single|demo|remaster[^)]*|reissue|reedici[oó]n[^)]*)\)", "", text or "", flags=re.I)
    text = re.sub(r"\b(ep|lp)\b\s*$", "", text.strip(), flags=re.I)
    return norm(re.sub(r"\s*\(\d{4}\)\s*$", "", text))


def fetch(key: str, do) -> str:
    path = CACHE / (hashlib.sha256(key.encode()).hexdigest() + ".txt")
    if path.exists():
        return path.read_text(encoding="utf-8")
    wait = DELAY - (time.time() - _last[0])
    if wait > 0:
        time.sleep(wait)
    body = ""
    for attempt in range(4):
        try:
            body = do()
        except Exception as exc:  # reintento suave
            print(f"  fallo {key}: {exc}", flush=True)
            body = ""
        _last[0] = time.time()
        # Página de desafío = vamos demasiado rápido: se espera y se reintenta, nunca se evade.
        if body and "Client Challenge" not in body[:3000]:
            break
        body = ""
        time.sleep(60 * (attempt + 1))
    if not body:
        FAILED[0] += 1
        return ""
    path.write_text(body, encoding="utf-8")
    return body


def search(text: str, kind: str) -> list[dict]:
    payload = json.dumps({"search_text": text, "search_filter": kind, "full_page": True, "fan_id": None}).encode()

    def do() -> str:
        req = urllib.request.Request(API, data=payload, headers={"User-Agent": UA, "Content-Type": "application/json", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30) as res:
            return res.read().decode("utf-8")
    body = fetch(f"search-full:{kind}:{text}", do)
    try:
        return json.loads(body)["auto"]["results"] or []
    except Exception:
        return []


def album_hit(band: dict, title: str, name: str) -> dict | None:
    """El disco de ESA banda (mismo band_id) con el título exacto, vía la API de búsqueda."""
    want = title_key(title)
    if not want:
        return None
    hits = [r for r in search(f"{title} {name}", "a")
            if r.get("type") == "a" and r.get("band_id") == band.get("id") and title_key(r.get("name", "")) == want]
    return hits[0] if len(hits) == 1 else None


def venezuelan(result: dict) -> bool:
    return "venezuela" in (result.get("location") or "").lower()


def main() -> None:
    pending = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    CACHE.mkdir(parents=True, exist_ok=True)
    pending_artists = {int(a["id"]): a for a in pending["artists"]}
    albums_by_artist: dict[int, list[dict]] = {}
    for album in pending["albums"]:
        albums_by_artist.setdefault(int(album["artist_id"]), []).append(album)
    names = {int(a["id"]): a["name"] for a in pending["allArtists"]}
    all_albums = {int(a["id"]): a.get("albums") or [] for a in pending["allArtists"]}
    # Artistas a buscar: pendientes o con discos pendientes. «Various Artists» fuera.
    targets = sorted(set(pending_artists) | set(albums_by_artist))
    targets = [t for t in targets if not re.match(r"^(various|varios|va\b)", (names.get(t) or "").lower())]
    if limit:
        targets = targets[:limit]
    homonyms: dict[str, int] = {}
    for name in names.values():
        homonyms[norm(name)] = homonyms.get(norm(name), 0) + 1

    rows: list[dict] = []
    stats = {"buscados": 0, "casados": 0, "sin_resultado": 0, "no_venezolana": 0, "homonimos": 0,
             "artistas_con_genero": 0, "discos_probados": 0, "discos_casados": 0, "discos_con_genero": 0}
    doubts: list[dict] = []
    for index, artist_id in enumerate(targets, 1):
        name = names[artist_id]
        key = norm(name)
        stats["buscados"] += 1
        if not key or homonyms.get(key, 0) > 1:
            stats["homonimos"] += 1
            continue
        same = [r for r in search(name, "b") if r.get("type") == "b" and norm(r.get("name", "")) == key]
        if not same:
            stats["sin_resultado"] += 1
            continue
        catalog = [a for a in (all_albums.get(artist_id) or []) if title_key(a["title"])]
        # Identidad: ubicada en Venezuela, o (si no) comparte un disco con nuestro catálogo.
        matched: list[dict] = []
        for candidate in same:
            if venezuelan(candidate) or any(album_hit(candidate, a["title"], name) for a in catalog[:3]):
                matched.append(candidate)
        if not matched:
            stats["no_venezolana"] += 1
            doubts.append({"artistId": artist_id, "name": name, "motivo": "homónimo fuera de Venezuela sin disco en común",
                           "candidatos": [{"url": r.get("item_url_root"), "location": r.get("location")} for r in same[:3]]})
            continue
        if len(matched) > 1:
            stats["homonimos"] += 1
            doubts.append({"artistId": artist_id, "name": name, "motivo": "varias bandas homónimas con prueba",
                           "candidatos": [r.get("item_url_root") for r in matched]})
            continue
        band = matched[0]
        proof = f"ubicación «{band.get('location')}»" if venezuelan(band) else "disco en común con el catálogo"
        stats["casados"] += 1
        if artist_id in pending_artists and band.get("tag_names"):
            stats["artistas_con_genero"] += 1
            rows.append({"caseId": f"artist:{artist_id}", "kind": "artist", "entityId": artist_id, "source": "bandcamp",
                         "url": band.get("item_url_root"), "title": name, "rawGenres": band["tag_names"],
                         "identity": f"nombre exacto + {proof} en Bandcamp"})
        for album in albums_by_artist.get(artist_id, []):
            stats["discos_probados"] += 1
            hit = album_hit(band, album["title"], name)
            if not hit:
                continue
            stats["discos_casados"] += 1
            if hit.get("tag_names"):
                stats["discos_con_genero"] += 1
                rows.append({"caseId": f"album:{album['id']}", "kind": "album", "entityId": int(album["id"]), "source": "bandcamp",
                             "url": hit.get("item_url_path"), "title": f"{name} - {album['title']}", "rawGenres": hit["tag_names"],
                             "identity": f"banda casada ({proof}) + título exacto del disco en Bandcamp"})
        if index % 25 == 0:
            print(f"[{index}/{len(targets)}] {json.dumps(stats)}", flush=True)

    OUT.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows), encoding="utf-8")
    (ROOT / "reports" / "harvest-bandcamp-2026-09-27.json").write_text(
        json.dumps({"stats": stats, "dudas": doubts}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({**stats, "peticiones_fallidas": FAILED[0]}), flush=True)


if __name__ == "__main__":
    main()
