#!/usr/bin/env python3
"""Personas P1: descarga imagenes para los pares persona-entrada (p0),
reusando archivos ya bajados (piloto/strict) cuando la URL coincide.
"""
import json, os, re, hashlib, time, urllib.request, random, threading
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
BASE = os.path.join(REPO, "data/raw/fotos-blogs-2026-10-01")
OUT = os.path.join(BASE, "persons")
os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "CRV-local-media/1.0 (+coleccionistasderockvenezolano.com)"}
MUERTOS = ("photobucket", "imageshack", "tinypic", "jimdo", "ytimg.com", "img.youtube")

# mapa url -> archivo local ya descargado
ya = {}
for man in ("piloto-manifest.jsonl", "strict-manifest.jsonl"):
    p = os.path.join(BASE, man)
    if not os.path.exists(p):
        continue
    for line in open(p, encoding="utf-8"):
        try:
            r = json.loads(line)
        except Exception:
            continue
        fp = os.path.join(REPO, r["path"])
        if os.path.exists(fp):
            ya[r["url"].split("?")[0]] = fp
            ya[re.sub(r"/s\d{3,4}/", "/s1600/", r["url"].split("?")[0])] = fp
print("urls reutilizables:", len(ya))

jobs = []
for line in open("/tmp/crv-persons-p0.jsonl", encoding="utf-8"):
    r = json.loads(line)
    urls, seen = [], set()
    for u in r["imgs"]:
        if any(m in u for m in MUERTOS):
            continue
        b = re.sub(r"/s\d{3,4}/", "/s1600/", u.split("?")[0])
        if b in seen:
            continue
        seen.add(b)
        urls.append(b)
    for u in urls[:15]:
        jobs.append((r["personId"], r["name"], u))

manifest = os.path.join(BASE, "persons-manifest.jsonl")
done = set()
reuse = 0
if os.path.exists(manifest):
    for line in open(manifest, encoding="utf-8"):
        try:
            r = json.loads(line)
            done.add(r["key"])
        except Exception:
            pass
nuevos = []
for pid, name, u in jobs:
    key = f"{pid}|{u}"
    if key in done:
        continue
    if u in ya:
        reuse += 1
        with open(manifest, "a", encoding="utf-8") as f:
            f.write(json.dumps({"key": key, "personId": pid, "name": name, "url": u,
                                "path": os.path.relpath(ya[u], REPO), "reuse": True}, ensure_ascii=False) + "\n")
        done.add(key)
        continue
    nuevos.append((pid, name, u))
print(f"jobs totales: {len(jobs)} | reuse: {reuse} | a descargar: {len(nuevos)}", flush=True)
random.seed(11)
random.shuffle(nuevos)

lock = threading.Lock()
stats = {"ok": 0, "err": 0, "skip": 0}


def fetch(job):
    pid, name, u = job
    key = f"{pid}|{u}"
    m = re.search(r"\.(jpe?g|png|gif|webp)(?:\?|$)", u, re.I)
    ext = "." + (m.group(1).lower().replace("jpeg", "jpg") if m else "jpg")
    h = hashlib.sha1(u.encode()).hexdigest()[:14]
    path = os.path.join(OUT, f"p{pid}_{h}{ext}")
    try:
        req = urllib.request.Request(u, headers=UA)
        with urllib.request.urlopen(req, timeout=10) as resp:
            status, data = resp.status, resp.read()
        if status == 200 and len(data) > 1500:
            open(path, "wb").write(data)
            with lock:
                stats["ok"] += 1
                with open(manifest, "a", encoding="utf-8") as f:
                    f.write(json.dumps({"key": key, "personId": pid, "name": name, "url": u,
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
    list(ex.map(fetch, nuevos))
print(f"listo en {time.time()-t0:.0f}s | ok={stats['ok']} skip={stats['skip']} err={stats['err']}", flush=True)
