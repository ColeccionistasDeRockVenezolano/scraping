#!/usr/bin/env python3
"""Mapa de la fase «nuevos»: los artistas de RYM que NO están en el catálogo
(match=nuevo del cruce de la cosecha asistida) con su href para el capturador.

Salida:
  data/raw/fuentes-web-2026-10-01/rym-nuevos/cola-nuevos.jsonl   (insumo del capturador)
  reports/rym-nuevos-cola-2026-10-02.csv                          (copia legible, trackeada)
"""
import csv, json, os

R = "/home/brian/apps/Coleccionistas De Rock Venezolano"
CRUCE = f"{R}/data/raw/fuentes-web-2026-10-01/consolidado/rym-final/cruce.csv"
OUTDIR = f"{R}/data/raw/fuentes-web-2026-10-01/rym-nuevos"
os.makedirs(OUTDIR, exist_ok=True)

rows = list(csv.DictReader(open(CRUCE, encoding="utf-8")))
nuevos = [r for r in rows if r["match"] == "nuevo" and r["rym_href"]]
seen, out = set(), []
for r in nuevos:
    h = r["rym_href"].rstrip("/")
    if not h or h in seen:
        continue
    seen.add(h)
    out.append({"name": r["rym_name"], "rymHref": h, "nlocs": r.get("nlocs") or ""})

with open(f"{OUTDIR}/cola-nuevos.jsonl", "w", encoding="utf-8") as f:
    for o in out:
        f.write(json.dumps(o, ensure_ascii=False) + "\n")

with open(f"{R}/reports/rym-nuevos-cola-2026-10-02.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["artist", "rymHref"])
    for o in out:
        w.writerow([o["name"], "https://rateyourmusic.com" + o["rymHref"]])

print(f"nuevos con href: {len(nuevos)} | únicos: {len(out)} -> {OUTDIR}/cola-nuevos.jsonl")
print("primeros 5:", [o["name"] for o in out[:5]])
