#!/usr/bin/env python3
"""Fotos-blogs fase 3c (final): candidatos para media:localize.
Fuentes: /tmp/crv-verif-decisions.json (verificacion manual) + /tmp/crv-strict-foto-r2.txt.
Guardas: entrada estricta (titulo=nombre), no compartida entre artistas, >=300px,
titulo sin rol de miembro (baterista|...) para no aplicar retrato de un miembro.
"""
import json, os, re

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
BASE = os.path.join(REPO, "data/raw/fotos-blogs-2026-10-01")
idx = json.load(open("/tmp/crv-strict-idx.json"))
dec = json.load(open("/tmp/crv-verif-decisions.json", encoding="utf-8"))
si = set(dec["si"])

r2f = "/tmp/crv-strict-foto-r2.txt"
r2_extra = set()
if os.path.exists(r2f):
    t = open(r2f).read()
    m = re.search(r"FOTO:(.*)", t)
    if m:
        r2_extra = {int(x) for x in re.findall(r"#?(\d+)", m.group(1))}
        print("r2 extra (pendiente verificacion manual):", sorted(r2_extra))

# de la verificacion manual solo FOTO; los r2 pasan por verificacion aparte -> por ahora se excluyen
foto_tiles = si

strict_by_url = {}
for line in open(os.path.join(BASE, "strict-manifest.jsonl"), encoding="utf-8"):
    r = json.loads(line)
    strict_by_url.setdefault(r["url"], set()).add(r["artistId"])

ROLE = re.compile(r"(baterista|guitarrista|bajista|vocalista|tecladista|cantante|integrante|fundador|ex-)", re.I)
ents = {}
for line in open(os.path.join(BASE, "mentions.jsonl"), encoding="utf-8"):
    r = json.loads(line)
    for u in r["imgs"]:
        b = u.split("?")[0]
        ents.setdefault((r["artistId"], b), r)
        up = re.sub(r"/s\d{3,4}/", "/s1600/", b)
        ents.setdefault((r["artistId"], up), r)

cands, rech = [], []
cura = json.load(open("/tmp/crv-fotos-curacion.json", encoding="utf-8"))
aceptados = set(cura["aceptados"])
for n in sorted(foto_tiles):
    it = idx.get(str(n))
    if not it:
        rech.append({"why": "sin-idx", "tile": n})
        continue
    u = it["url"]
    arts_s = strict_by_url.get(u, set())
    if not arts_s:
        rech.append({"why": "sin-entrada-estricta", "tile": n, "url": u})
        continue
    if len(arts_s) > 1:
        rech.append({"why": "compartida", "tile": n, "url": u, "arts": sorted(arts_s)})
        continue
    aid = sorted(arts_s)[0]
    if aid not in aceptados:
        rech.append({"why": "atribucion", "tile": n, "artistId": aid})
        continue
    if it["w"] < 300:
        rech.append({"why": "chica", "tile": n, "w": it["w"], "artistId": aid})
        continue
    e = ents.get((aid, u.split("?")[0]))
    title = (e or {}).get("title") or ""
    if ROLE.search(title):
        rech.append({"why": "titulo-rol", "tile": n, "artistId": aid, "title": title[:80]})
        continue
    cands.append({"kind": "artist", "id": aid, "sourceUrl": u, "label": (e or {}).get("artist") or "",
                  "source": "blog-rock-ve", "snapshotUrl": (e or {}).get("page") or "", "w": it["w"], "tile": n})

best = {}
for c in cands:
    if c["id"] not in best or c["w"] > best[c["id"]]["w"]:
        best[c["id"]] = c
final = sorted(best.values(), key=lambda c: c["id"])

with open(f"{REPO}/reports/fotos-blogs-2026-10-01.jsonl", "w", encoding="utf-8") as f:
    for c in final:
        f.write(json.dumps({k: v for k, v in c.items() if k not in ("w", "tile")}, ensure_ascii=False) + "\n")
with open(f"{REPO}/reports/fotos-blogs-2026-10-01-rechazados.jsonl", "w", encoding="utf-8") as f:
    for r in rech:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

print(f"candidatos finales: {len(final)} | rechazados: {len(rech)}")
from collections import Counter
print("motivos rechazo:", Counter(r["why"] for r in rech).most_common())
for c in final:
    print(" ", c["id"], c["label"][:36], "| w", c["w"] if "w" in c else "-", "|", c["sourceUrl"][:70])
