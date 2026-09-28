#!/usr/bin/env python3
"""Descarga las fichas de Sincopa enlazadas desde páginas ya capturadas que
nunca se bajaron (sobre todo secciones fuera del alcance del adaptador).
Cortesía: 1 petición por segundo. Guarda bytes crudos en data/raw/sincopa-extra
y un índice url → archivo; no toca la base."""
import hashlib, json, sys, time, urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "data" / "raw" / "sincopa-extra"
INDEX = OUT / "index.jsonl"
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

def main(list_file: str) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    done = set()
    if INDEX.exists():
        done = {json.loads(l)["url"] for l in INDEX.read_text().splitlines() if l.strip()}
    urls = [u.strip() for u in Path(list_file).read_text().splitlines() if u.strip() and u.strip() not in done]
    with INDEX.open("a") as index:
        for n, url in enumerate(urls, 1):
            name = hashlib.sha256(url.encode()).hexdigest() + ".html"
            try:
                req = urllib.request.Request(url, headers={"User-Agent": UA})
                with urllib.request.urlopen(req, timeout=30) as r:
                    body = r.read(); status = r.status
            except Exception as e:  # 404 y demás: se anotan y se sigue
                body = b""; status = getattr(e, "code", 0)
            if body:
                (OUT / name).write_bytes(body)
            index.write(json.dumps({"url": url, "file": name if body else None, "status": status}) + "\n"); index.flush()
            if n % 100 == 0:
                print(f"{n}/{len(urls)}", file=sys.stderr, flush=True)
            time.sleep(1)
    print("FIN", file=sys.stderr)

if __name__ == "__main__":
    main(sys.argv[1])
