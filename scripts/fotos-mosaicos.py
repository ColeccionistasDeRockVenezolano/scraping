#!/usr/bin/env python3
"""Fotos-blogs fase 3b: mosaicos del set estricto para clasificacion."""
import json, os, math, hashlib
from PIL import Image, ImageDraw

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
BASE = os.path.join(REPO, "data/raw/fotos-blogs-2026-10-01")

rows = []
for line in open(os.path.join(BASE, "strict-manifest.jsonl"), encoding="utf-8"):
    try:
        r = json.loads(line)
    except Exception:
        continue
    p = os.path.join(REPO, r["path"])
    if os.path.exists(p):
        r["path_abs"] = p
        rows.append(r)
print("descargadas:", len(rows))

uniq = {}
for r in rows:
    h = hashlib.sha256(open(r["path_abs"], "rb").read()).hexdigest()
    r["sha"] = h
    uniq.setdefault(h, []).append(r)
print("unicas:", len(uniq))

items = []
drop = {"tiny": 0, "wide": 0, "bad": 0, "yt": 0}
for h, rs in uniq.items():
    u0 = rs[0]["url"]
    if "ytimg.com" in u0 or "img.youtube" in u0:
        drop["yt"] += 1
        continue
    try:
        with Image.open(rs[0]["path_abs"]) as im:
            w, hh = im.size
    except Exception:
        drop["bad"] += 1
        continue
    if w < 160 or hh < 160:
        drop["tiny"] += 1
        continue
    if w / hh > 2.6 or hh / w > 2.6:
        drop["wide"] += 1
        continue
    items.append({"sha": h, "path": rs[0]["path_abs"], "w": w, "h": hh,
                  "arts": sorted({r["artistId"] for r in rs}), "url": u0, "n": len(rs)})

items.sort(key=lambda x: (-x["n"], -x["w"]))
print("a clasificar:", len(items), "| drops:", drop)

COLS, CELL = 6, 250
per_sheet = 36
idx = {}
for sheet in range(math.ceil(len(items) / per_sheet)):
    chunk = items[sheet * per_sheet:(sheet + 1) * per_sheet]
    rowsn = math.ceil(len(chunk) / COLS)
    canvas = Image.new("RGB", (COLS * CELL, rowsn * CELL), (22, 22, 22))
    d = ImageDraw.Draw(canvas)
    for i, it in enumerate(chunk):
        try:
            im = Image.open(it["path"]).convert("RGB")
        except Exception:
            continue
        im.thumbnail((CELL - 30, CELL - 30))
        x = (i % COLS) * CELL + (CELL - im.size[0]) // 2
        y = (i // COLS) * CELL + 26
        canvas.paste(im, (x, y))
        n = sheet * per_sheet + i
        d.text(((i % COLS) * CELL + 4, (i // COLS) * CELL + 4), f"#{n}", fill=(255, 220, 0))
        idx[str(n)] = it
    out = f"/tmp/crv-strict-sheet-{sheet}.jpg"
    canvas.save(out, quality=82)
    print("sheet ->", out, f"({len(chunk)} tiles)")

json.dump(idx, open("/tmp/crv-strict-idx.json", "w", encoding="utf-8"), ensure_ascii=False)
print("indice -> /tmp/crv-strict-idx.json")
