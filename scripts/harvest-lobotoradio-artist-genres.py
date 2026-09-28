#!/usr/bin/env python3
"""Cosecha el campo «géneros:» de las fichas de bandas y artistas de Lobotoradio.

Regla de Brian del 2026-09-26: si una fuente nombra el género, basta. Aquí solo
se exige identidad: el nombre de la ficha coincide (normalizado) con UN solo
artista del catálogo sin género, y el origen, si lo hay, es venezolano.
Respeta robots.txt (Crawl-delay: 10). Solo escribe el libro de evidencia; la
confirmación la hace scripts/apply-source-genres.ts.
"""
from __future__ import annotations

import hashlib
import html
import json
import re
import subprocess
import sys
import time
import unicodedata
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "lobotoradio"
LEDGER = ROOT / "reports" / "genre-laya-evidence-lobotoradio-artists-2026-09-26.jsonl"
REJECTED = ROOT / "reports" / "genre-laya-evidence-lobotoradio-rejected-2026-09-26.jsonl"
BASE = "https://www.lobotoradio.com"
def _contact() -> str:
    """Contacto del User-Agent desde GENRES_EXTERNAL_CONTACT (.env); nunca escrito en el código."""
    import os
    value = os.environ.get("GENRES_EXTERNAL_CONTACT", "")
    env = ROOT / ".env"
    if not value and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("GENRES_EXTERNAL_CONTACT="):
                value = line.split("=", 1)[1].strip().strip("'\"")
    return value


UA = f"CRV-bot/0.1 (+contacto: {_contact() or 'sin contacto'})"
DELAY = 10.2
LETTERS = ["0-9"] + [chr(c) for c in range(ord("A"), ord("Z") + 1)]
_last = 0.0


def fetch(url: str) -> str:
    global _last
    RAW.mkdir(parents=True, exist_ok=True)
    key = hashlib.sha256(url.encode()).hexdigest()
    cached = RAW / f"{key}.html"
    if cached.exists():
        return cached.read_text(encoding="utf-8")
    wait = DELAY - (time.time() - _last)
    if wait > 0:
        time.sleep(wait)
    request = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read().decode("utf-8", "replace")
    finally:
        _last = time.time()
    cached.write_text(body, encoding="utf-8")
    return body


def norm(text: str) -> str:
    value = unicodedata.normalize("NFKD", html.unescape(text).casefold().replace("&", " and "))
    value = "".join(ch for ch in value if not unicodedata.combining(ch))
    value = re.sub(r"^(the|los|las|la|el)\s+", "", value.strip())
    return re.sub(r"[^a-z0-9]+", "", value)


def index(kind: str) -> dict[str, str]:
    """slug → nombre visible, recorriendo cada letra y sus páginas."""
    found: dict[str, str] = {}
    for letter in LETTERS:
        page = 1
        while True:
            url = f"{BASE}/{kind}/?letra={letter}" + (f"&paged={page}" if page > 1 else "")
            body = fetch(url)
            for slug, name in re.findall(rf'href="{BASE}/{kind}/([a-z0-9-]+)/?"[^>]*>\s*([^<]+?)\s*<', body):
                found.setdefault(slug, html.unescape(name))
            if f"paged={page + 1}" not in body.replace("&#038;", "&"):
                break
            page += 1
        print(f"{kind} {letter}: {len(found)}", file=sys.stderr, flush=True)
    return found


def fields(body: str) -> dict[str, str]:
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", body, flags=re.S)
    lines = [line.strip() for line in html.unescape(re.sub(r"<[^>]+>", "\n", text)).split("\n") if line.strip()]
    out: dict[str, str] = {}
    for position, line in enumerate(lines[:-1]):
        if re.fullmatch(r"(g[ée]neros?|origen|tipo):", line, re.I):
            out[norm(line.rstrip(":"))[:6]] = lines[position + 1]
    # El <h1> puede traer etiquetas dentro: se toma todo su texto.
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S)
    out["name"] = html.unescape(re.sub(r"<[^>]+>", "", h1.group(1))).strip() if h1 else ""
    return out


def main() -> None:
    pending = json.loads(subprocess.check_output(["npx", "tsx", "scripts/export-pending-artists.mts"], cwd=ROOT, text=True))
    by_name: dict[str, list[dict]] = {}
    for artist in pending:
        by_name.setdefault(norm(artist["name"]), []).append(artist)
    done = set()
    if LEDGER.exists():
        done |= {json.loads(line)["url"] for line in LEDGER.read_text().splitlines() if line.strip()}
    if REJECTED.exists():
        done |= {json.loads(line)["url"] for line in REJECTED.read_text().splitlines() if line.strip()}

    candidates = []
    for kind in ("bandas", "artistas"):
        for slug, name in index(kind).items():
            hits = by_name.get(norm(name)) or by_name.get(norm(slug.replace("-", " "))) or []
            if hits:
                candidates.append((f"{BASE}/{kind}/{slug}", name, hits))
    print(f"candidatas: {len(candidates)}", file=sys.stderr, flush=True)

    with LEDGER.open("a", encoding="utf-8") as ledger, REJECTED.open("a", encoding="utf-8") as rejected:
        for url, name, hits in candidates:
            if url in done:
                continue
            body = fetch(url)
            data = fields(body)
            reason = None
            if len(hits) > 1:
                reason = "homonimos_en_catalogo"
            elif norm(data.get("name") or name) != norm(hits[0]["name"]):
                reason = "nombre_distinto"
            elif not data.get("genero"):
                reason = "sin_genero"
            elif data.get("origen") and "venezuela" not in norm(data["origen"]):
                reason = "origen_no_venezolano"
            record = {"url": url, "name": data.get("name") or name, "origin": data.get("origen"),
                      "snapshot": f"data/raw/lobotoradio/{hashlib.sha256(url.encode()).hexdigest()}.html"}
            if reason:
                rejected.write(json.dumps({**record, "reason": reason, "catalog": hits}, ensure_ascii=False) + "\n")
            else:
                artist = hits[0]
                ledger.write(json.dumps({**record, "caseId": f"artist:{artist['id']}", "kind": "artist",
                                         "entityId": artist["id"], "title": artist["name"], "source": "lobotoradio",
                                         "rawGenre": data["genero"]}, ensure_ascii=False) + "\n")
            ledger.flush(); rejected.flush()
    print("FIN", file=sys.stderr)


if __name__ == "__main__":
    main()
