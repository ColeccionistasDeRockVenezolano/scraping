#!/usr/bin/env python3
"""Personas P0: personas sin foto cuyo NOMBRE esta en el titulo de una entrada
con imagenes. Guarda entradas+imgs para el pipeline de descarga/clasificacion.
Guarda: nombre de >=2 tokens, o token unico >=8 chars (evita 'Daniel', 'Edgar').
"""
import json, re, os, subprocess, unicodedata
from collections import defaultdict

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
BASE = os.path.join(REPO, "data/raw/fotos-blogs-2026-10-01")

def norm(s):
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()

# entradas unicas (title,page,imgs) del corpus
seen = set()
entradas = []
for line in open(os.path.join(BASE, "mentions.jsonl"), encoding="utf-8"):
    r = json.loads(line)
    key = (norm(r.get("title") or ""), r["page"])
    if key in seen:
        continue
    seen.add(key)
    entradas.append({"title": r.get("title") or "", "t": key[0], "page": r["page"], "imgs": r["imgs"]})
print("entradas unicas:", len(entradas))

r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-At", "-F", "\t", "-c",
                    "SELECT id, name FROM public.persons WHERE picture_url IS NULL OR btrim(picture_url)=''"],
                   capture_output=True, text=True)
pers = [l.split("\t") for l in r.stdout.strip().split("\n") if l.strip()]
print("personas sin foto:", len(pers))

out = []
for pid, name in pers:
    nm = norm(name)
    toks = nm.split()
    if len(nm) < 6:
        continue
    if len(toks) < 2 and len(nm) < 8:
        continue
    hits = [e for e in entradas if e["t"] and re.search(r"(?<![a-z0-9])" + re.escape(nm) + r"(?![a-z0-9])", e["t"])]
    if not hits:
        continue
    for h in hits:
        out.append({"personId": int(pid), "name": name, "title": h["title"][:110], "page": h["page"], "imgs": h["imgs"]})

with open("/tmp/crv-persons-p0.jsonl", "w", encoding="utf-8") as f:
    for o in out:
        f.write(json.dumps(o, ensure_ascii=False) + "\n")
print("pares persona-entrada:", len(out), "| personas:", len({o['personId'] for o in out}))
for o in out[:10]:
    print("  ", o["personId"], o["name"][:30], "|", o["title"][:70], "|", len(o["imgs"]), "imgs")
