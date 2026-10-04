#!/usr/bin/env python3
"""CRV · Mejora de portadas pequeñas (≤300 px) del catálogo. NO escribe en la base.

Brian (2026-10-03): cambiar las miniaturas por la MISMA portada en grande, con
prioridad Spotify > Deezer > MusicBrainz > Discogs. Spotify queda fuera hasta
que haya clave válida (las del .env dan invalid_client).

Por cada disco cuya portada local mide ≤300 px busca, fuente por fuente y en
ese orden, discos con el mismo artista y título; descarga la portada candidata
y la compara con la actual (correlación de grises con recortes, ver `score`).
Se detiene en la primera fuente con coincidencia clara (≥ AUTO). Resultado por
disco en data/raw/portadas-mejora-2026-10-03/candidatos.jsonl (reanudable):

  decision = auto      → misma portada, ≥ AUTO y ≥ MIN_SIDE px: se aplica.
             revisar   → la mejor está entre REVIEW y AUTO: hoja de contacto.
             sin_match → nada parecido o nada encontrado.

Calibrado con las 16 portadas de la etapa 4 revisadas a ojo: misma portada
0,90–1,00 (algunas miniaturas recortadas de Sincopa bajan a 0,66 o 0,12);
distinta ≈ 0,11.

  python3 scripts/portadas-mejora-cosecha.py --phase=deezer|musicbrainz|discogs [--limit=N]
"""
from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data/raw/portadas-mejora-2026-10-03"
OUT = OUT_DIR / "candidatos.jsonl"
MEDIA = ROOT / "web/public/media/album"
SMALL = 300
MIN_SIDE = 500
AUTO = 0.90
REVIEW = 0.50
PHASES = ["deezer", "musicbrainz", "discogs"]


def env() -> dict[str, str]:
    values: dict[str, str] = {}
    for line in (ROOT / ".env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            values[key.strip()] = value.strip().strip('"').strip("'")
    return values


ENV = env()
UA = f"CRV-portadas/1.0 ({ENV.get('GENRES_EXTERNAL_CONTACT', '')})"


def psql(sql: str) -> list[list[str]]:
    url = re.sub(r"@[^/]*/", "@localhost:5432/", ENV["DATABASE_URL"])
    out = subprocess.run(["docker", "exec", "-i", "crv-postgres", "psql", url, "-X", "-At", "-F", "\t", "-c", sql],
                         check=True, capture_output=True, text=True).stdout
    return [line.split("\t") for line in out.splitlines() if line]


# --- Comparación -----------------------------------------------------------------

N = 48


def gray(image: Image.Image, box=None) -> np.ndarray:
    image = image.convert("L")
    if box:
        image = image.crop(box)
    data = np.asarray(image.resize((N, N), Image.BILINEAR), dtype=float)
    data -= data.mean()
    return data / (data.std() or 1)


def score(current: Image.Image, candidate: Image.Image) -> float:
    """Mejor correlación probando márgenes en las dos imágenes (las miniaturas suelen venir recortadas)."""
    base = gray(current)
    width, height = candidate.size
    best = float((base * gray(candidate)).mean())
    for margin in (0.03, 0.06, 0.1):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                box = (width * margin * (1 + dx * 0.5), height * margin * (1 + dy * 0.5),
                       width - width * margin * (1 - dx * 0.5), height - height * margin * (1 - dy * 0.5))
                best = max(best, float((base * gray(candidate, box)).mean()))
    cw, ch = current.size
    for margin in (0.03, 0.06):
        best = max(best, float((gray(current, (cw * margin, ch * margin, cw - cw * margin, ch - ch * margin)) * gray(candidate)).mean()))
    return best


# --- Texto -----------------------------------------------------------------------

def key(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower()
    text = re.sub(r"\((?:remaster|remastered|deluxe|en vivo|live|reedici)[^)]*\)", " ", text)
    text = re.sub(r"[^a-z0-9]+", " ", text)
    return " ".join(re.sub(r"\b(the|los|las|la|el|y|and)\b", " ", text).split())


def same_title(a: str, b: str) -> bool:
    return key(a) == key(b)


def same_artist(a: str, b: str) -> bool:
    ka, kb = key(a), key(b)
    return ka == kb or (min(len(ka), len(kb)) >= 6 and (ka in kb or kb in ka))


# --- Red -------------------------------------------------------------------------

def get(url: str, *, raw: bool = False, tries: int = 3):
    for attempt in range(tries):
        try:
            request = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
            with urllib.request.urlopen(request, timeout=30) as response:
                body = response.read()
            return body if raw else json.loads(body)
        except urllib.error.HTTPError as error:
            if error.code in (429, 503) and attempt + 1 < tries:
                time.sleep(5 * (attempt + 1))
                continue
            if error.code == 404:
                return None
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt + 1 < tries:
                time.sleep(3)
                continue
            raise
    return None


class Pace:
    """Separación mínima entre peticiones a una misma fuente (compartida entre hilos)."""

    def __init__(self, seconds: float) -> None:
        self.seconds, self.lock, self.last = seconds, threading.Lock(), 0.0

    def wait(self) -> None:
        with self.lock:
            delay = self.last + self.seconds - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self.last = time.monotonic()


PACE = {"deezer": Pace(0.15), "musicbrainz": Pace(1.1), "discogs": Pace(1.1)}


def deezer(artist: str, title: str) -> list[dict]:
    found = []
    for query in (f'artist:"{artist}" album:"{title}"', f"{artist} {title}"):
        PACE["deezer"].wait()
        data = get("https://api.deezer.com/search/album?limit=10&q=" + urllib.parse.quote(query)) or {}
        for row in data.get("data", []):
            if same_artist(row["artist"]["name"], artist) and same_title(row["title"], title) and row.get("cover_xl"):
                found.append({"source": "deezer", "url": row["cover_xl"], "page": f"https://www.deezer.com/album/{row['id']}"})
        if found:
            break
    return found[:3]


def musicbrainz(artist: str, title: str) -> list[dict]:
    PACE["musicbrainz"].wait()
    query = f'releasegroup:"{title}" AND artist:"{artist}"'
    data = get("https://musicbrainz.org/ws/2/release-group/?fmt=json&limit=5&query=" + urllib.parse.quote(query)) or {}
    found = []
    for group in data.get("release-groups", []):
        credit = "".join(part.get("name", "") + part.get("joinphrase", "") for part in group.get("artist-credit", []))
        if group.get("score", 0) >= 90 and same_artist(credit, artist) and same_title(group["title"], title):
            found.append({"source": "musicbrainz", "url": f"https://coverartarchive.org/release-group/{group['id']}/front-1200",
                          "page": f"https://musicbrainz.org/release-group/{group['id']}"})
    return found[:3]


def discogs(artist: str, title: str) -> list[dict]:
    PACE["discogs"].wait()
    params = urllib.parse.urlencode({"artist": artist, "release_title": title, "type": "release", "per_page": 10, "token": ENV["DISCOGS_TOKEN"]})
    data = get("https://api.discogs.com/database/search?" + params) or {}
    found = []
    for row in data.get("results", []):
        name, _, release = row.get("title", "").partition(" - ")
        if row.get("cover_image") and not row["cover_image"].endswith("spacer.gif") and same_artist(re.sub(r" \(\d+\)$", "", name), artist) and same_title(release, title):
            found.append({"source": "discogs", "url": row["cover_image"], "page": f"https://www.discogs.com/release/{row['id']}"})
    return found[:3]


SEARCH = {"deezer": deezer, "musicbrainz": musicbrainz, "discogs": discogs}


def evaluate(album: dict, phase: str) -> dict:
    current = Image.open(MEDIA / album["file"])
    best = None
    tried = []
    for candidate in SEARCH[phase](album["artist"], album["title"]):
        try:
            if phase == "musicbrainz":
                PACE["musicbrainz"].wait()
            image = Image.open(io.BytesIO(get(candidate["url"], raw=True)))
        except Exception as error:  # noqa: BLE001 — una portada rota no para la cosecha
            tried.append({**candidate, "error": str(error)[:120]})
            continue
        row = {**candidate, "size": list(image.size), "score": round(score(current, image), 3)}
        tried.append(row)
        if max(image.size) >= MIN_SIDE and (best is None or row["score"] > best["score"]):
            best = row
    decision = "sin_match"
    if best and best["score"] >= AUTO:
        decision = "auto"
    elif best and best["score"] >= REVIEW:
        decision = "revisar"
    return {"albumId": album["id"], "artist": album["artist"], "title": album["title"], "phase": phase,
            "current": list(current.size), "decision": decision, "best": best, "tried": tried}


def targets() -> list[dict]:
    rows = psql("""SELECT a.id, ar.name, a.title, substring(a.cover_url from '[^/]+$')
                     FROM public.albums a JOIN public.artists ar ON ar.id=a.artist_id
                    WHERE a.cover_url ~ '^/crv/media/album/'""")
    albums = []
    for album_id, artist, title, file in rows:
        path = MEDIA / file
        try:
            if max(Image.open(path).size) <= SMALL:
                albums.append({"id": int(album_id), "artist": artist, "title": title, "file": file})
        except Exception:  # noqa: BLE001
            continue
    return albums


def main() -> None:
    phase = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--phase=")), None)
    if phase not in PHASES:
        sys.exit(f"--phase={'|'.join(PHASES)}")
    limit = int(next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--limit=")), "0")) or None
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    done: dict[int, list[dict]] = {}
    if OUT.exists():
        for line in OUT.read_text().splitlines():
            row = json.loads(line)
            done.setdefault(row["albumId"], []).append(row)
    # Una fase solo mira los discos sin coincidencia clara en las fases anteriores (prioridad de Brian).
    earlier = PHASES[:PHASES.index(phase)]
    pending = [a for a in targets()
               if not any(r["phase"] == phase for r in done.get(a["id"], []))
               and not any(r["decision"] == "auto" for r in done.get(a["id"], []) if r["phase"] in earlier)]
    pending = pending[:limit] if limit else pending
    print(f"{phase}: {len(pending)} discos por mirar", flush=True)
    lock = threading.Lock()
    counts: dict[str, int] = {}

    def work(album: dict) -> None:
        try:
            row = evaluate(album, phase)
        except Exception as error:  # noqa: BLE001
            row = {"albumId": album["id"], "artist": album["artist"], "title": album["title"], "phase": phase, "decision": "error", "error": str(error)[:200]}
        with lock:
            with OUT.open("a") as handle:
                handle.write(json.dumps(row, ensure_ascii=False) + "\n")
            counts[row["decision"]] = counts.get(row["decision"], 0) + 1
            total = sum(counts.values())
            if total % 100 == 0 or total == len(pending):
                print(f"{phase} {total}/{len(pending)} {counts}", flush=True)

    with ThreadPoolExecutor(max_workers=4 if phase == "deezer" else 1) as pool:
        list(pool.map(work, pending))
    print(f"{phase} fin {counts}", flush=True)


if __name__ == "__main__":
    main()
