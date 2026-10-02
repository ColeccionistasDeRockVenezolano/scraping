#!/usr/bin/env python3
"""Personas P3: candidatos para media:localize (kind=person) con la
seleccion manual (persona -> tile). Guardas: >=300px, url en entrada de la persona.
"""
import json, os, re
from collections import defaultdict

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
BASE = os.path.join(REPO, "data/raw/fotos-blogs-2026-10-01")
idx = json.load(open("/tmp/crv-pers-idx.json"))

SEL = {
    38: 49, 39: 144, 81: 375, 628: 89, 850: 330, 921: 257, 1262: 368, 1287: 166,
    1390: 195, 2493: 192, 2636: 87, 2968: 322, 3258: 335, 3434: 343, 4026: 306,
    4733: 305, 4792: 220, 4794: 276, 4861: 194, 4880: 308, 5078: 386, 5249: 328,
    7192: 187, 7209: 319, 8358: 314, 10082: 329, 12134: 317, 12146: 239,
    15366: 363, 15791: 109, 15823: 196, 17339: 263, 17609: 186,
}

# entradas (persona, url) -> pagina
ents = defaultdict(dict)
for line in open(os.path.join(BASE, "persons-manifest.jsonl"), encoding="utf-8"):
    r = json.loads(line)
    ents[r["personId"]][r["url"].split("?")[0]] = r
p0 = defaultdict(list)
for line in open("/tmp/crv-persons-p0.jsonl", encoding="utf-8"):
    r = json.loads(line)
    p0[r["personId"]].append(r)

cands, rech = [], []
for pid, n in sorted(SEL.items()):
    it = idx.get(str(n))
    if not it:
        rech.append({"why": "sin-idx", "personId": pid, "tile": n}); continue
    u = it["url"]
    urls_p = [x.split("?")[0] for x in ents.get(pid, {})]
    if u.split("?")[0] not in urls_p:
        up = re.sub(r"/s\d{3,4}/", "/s1600/", u.split("?")[0])
        if up not in urls_p:
            rech.append({"why": "url-no-es-de-la-persona", "personId": pid, "tile": n, "url": u[:80]}); continue
    if it["w"] < 300:
        rech.append({"why": "chica", "personId": pid, "tile": n, "w": it["w"]}); continue
    # pagina de la entrada
    page = ""
    for e in p0.get(pid, []):
        if u.split("?")[0] in [x.split("?")[0] for x in e["imgs"]] or re.sub(r"/s\d{3,4}/", "/s1600/", u.split("?")[0]) in [re.sub(r"/s\d{3,4}/", "/s1600/", x.split("?")[0]) for x in e["imgs"]]:
            page = e["page"]; break
    nm = p0.get(pid, [{}])[0].get("name", "")
    cands.append({"kind": "person", "id": pid, "sourceUrl": u, "label": nm,
                  "source": "blog-rock-ve", "snapshotUrl": page})

with open(f"{REPO}/reports/fotos-blogs-personas-2026-10-01.jsonl", "w", encoding="utf-8") as f:
    for c in cands:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")
with open(f"{REPO}/reports/fotos-blogs-personas-2026-10-01-rechazados.jsonl", "w", encoding="utf-8") as f:
    for r in rech:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")

print(f"candidatos personas: {len(cands)} | rechazados: {len(rech)}")
for r in rech:
    print("  rech:", r)
for c in cands[:6]:
    print(" ", c["id"], c["label"][:30], "|", c["sourceUrl"][:70])
