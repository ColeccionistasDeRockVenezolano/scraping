#!/usr/bin/env python3
"""Fotos-blogs fase 3 (estricto): descarga imagenes de entradas cuyo TITULO
contiene el nombre del artista (551 artistas, ~2.2k imgs). Dedup por URL,
upgrade blogger /sNNN/ -> /s1600/. Excluye hosts muertos (photobucket).
"""
import json, os, re, hashlib, time, urllib.request, random, unicodedata, threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
BASE = os.path.join(REPO, "data/raw/fotos-blogs-2026-10-01")
OUT = os.path.join(BASE, "strict")
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)"}
MUERTOS = ("photobucket", "imageshack", "tinypic", "jimdo")


def norm(s):
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


mentions = defaultdict(list)
for line in open(os.path.join(BASE, "mentions.jsonl"), encoding="utf-8"):
    r = json.loads(line)
    mentions[r["artistId"]].append(r)

jobs = []
n_art = 0
for aid, rows in mentions.items():
    nm = norm(rows[0]["artist"])
    if len(nm) < 4:
        continue
    hits = [r for r in rows if re.search(r"(?<![a-z0-9])" + re.escape(nm) + r"(?![a-z0-9])", norm(r.get("title") or ""))]
    if not hits:
        continue
    n_art += 1
    urls, seen = [], set()
    for r in hits:
        for u in r["imgs"]:
            if any(m in u for m in MUERTOS):
                continue
            b = u.split("?")[0]
            b = re.sub(r"/s\d{3,4}/", "/s1600/", b)
            if b in seen:
                continue
            seen.add(b)
            urls.append(b)
    for u in urls[:20]:
        jobs.append((aid, rows[0]["artist"], u))

print(f"artistas estrictos: {n_art} | jobs: {len(jobs)}", flush=True)

manifest = os.path.join(BASE, "strict-manifest.jsonl")
done = set()
if os.path.exists(manifest):
    for line in open(manifest, encoding="utf-8"):
        try:
            done.add(json.loads(line)["key"])
        except Exception:
            pass
jobs = [j for j in jobs if f"{j[0]}|{j[2]}" not in done]
random.seed(7)
random.shuffle(jobs)
print(f"pendientes tras dedup-manifest: {len(jobs)}", flush=True)

lock = threading.Lock()
stats = {"ok": 0, "err": 0, "skip": 0}


def fetch(job):
    aid, name, u = job
    key = f"{aid}|{u}"
    m = re.search(r"\.(jpe?g|png|gif|webp)(?:\?|$)", u, re.I)
    ext = "." + (m.group(1).lower().replace("jpeg", "jpg") if m else "jpg")
    h = hashlib.sha1(u.encode()).hexdigest()[:14]
    path = os.path.join(OUT, f"{aid}_{h}{ext}")
    try:
        req = urllib.request.Request(u, headers=UA)
        with urllib.request.urlopen(req, timeout=10) as resp:
            status, data = resp.status, resp.read()
        if status == 200 and len(data) > 1500:
            open(path, "wb").write(data)
            with lock:
                stats["ok"] += 1
                with open(manifest, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"key": key, "artistId": aid, "artist": name, "url": u,
                                        "path": os.path.relpath(path, REPO), "bytes": len(data)}, ensure_ascii=False) + "\n")
        else:
            with lock:
                stats["skip"] += 1
    except Exception:
        with lock:
            stats["err"] += 1
    time.sleep(0.1)


t0 = time.time()
with ThreadPoolExecutor(max_workers=6) as ex:
    list(ex.map(fetch, jobs))
print(f"listo en {time.time()-t0:.0f}s | ok={stats['ok']} skip={stats['skip']} err={stats['err']}", flush=True)
