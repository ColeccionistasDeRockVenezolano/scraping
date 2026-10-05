#!/usr/bin/env python3
"""Vuelca las biografías RYM capturadas (data/raw/.../rym-bios/pages) a
reports/bio-texts/rym.jsonl para que entren al pipeline de expedientes."""
import glob
import json
import subprocess

SQL = "SELECT id, name FROM public.artists"
out = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-tAc", SQL],
                     capture_output=True, text=True).stdout
por_nombre = {}
for line in out.splitlines():
    if "|" in line:
        i, n = line.split("|", 1)
        por_nombre.setdefault(n.strip().casefold(), []).append(int(i))

rows = []
for f in glob.glob("data/raw/fuentes-web-2026-10-01/rym-bios/pages/bio-*.json"):
    r = json.load(open(f, encoding="utf-8"))
    if r.get("n", 0) < 80:
        continue
    name = r["name"].strip()
    ids = por_nombre.get(name.casefold(), [])
    if len(ids) != 1:
        print("OJO no único:", name, ids)
        continue
    rows.append({
        "caseId": f"artist:{ids[0]}", "kind": "artist", "entityId": ids[0], "source": "rym",
        "url": r.get("u"), "lang": "en" if " the " in r["bio"][:200].lower() and " de " not in r["bio"][:200] else "es",
        "text": r["bio"], "facts": {},
        "links": {},
        "identity": f"pestaña de biografía de la ficha RYM {r.get('rymHref')} ya casada con el catálogo (ledger de «nuevos»)",
    })
with open("reports/bio-texts/rym.jsonl", "w", encoding="utf-8") as fh:
    for r in rows:
        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
print("filas escritas:", len(rows))
for r in rows:
    print(" ", r["caseId"], r["text"][:60].replace("\n", " "))
