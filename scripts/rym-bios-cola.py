#!/usr/bin/env python3
"""CRV · Cola de la fase «bios»: artistas sin biografía con slug RYM conocido.

Cruza la cola de «nuevos» (name + rymHref de las 1.591 fichas) contra
`public.artists` (biography NULL o vacía) por nombre normalizado (NFD, sin
tildes/puntuación). Salida:

  data/raw/fuentes-web-2026-10-01/rym-bios/cola-bios.jsonl

Los que no matchean por nombre (fichas renombradas tras fusiones) se incluyen
igual: capturar de más no rompe nada — el aplicador de bios decidirá después.
"""
import json
import os
import subprocess
import unicodedata

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
COLA_NUEVOS = os.path.join(ROOT, "data/raw/fuentes-web-2026-10-01/rym-nuevos/cola-nuevos.jsonl")
OUT_DIR = os.path.join(ROOT, "data/raw/fuentes-web-2026-10-01/rym-bios")
OUT = os.path.join(OUT_DIR, "cola-bios.jsonl")


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join("".join(ch if ch.isalnum() else " " for ch in s).split())


def psql(sql: str) -> list:
    out = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-tAc", sql],
                         capture_output=True, text=True).stdout
    return [l.strip() for l in out.splitlines() if l.strip()]


sin_bio = {norm(n) for n in psql("SELECT name FROM public.artists WHERE biography IS NULL OR btrim(biography) = ''")}
print("artistas sin bio en la BD:", len(sin_bio))

cola, con_bio = [], 0
for line in open(COLA_NUEVOS, encoding="utf-8"):
    if not line.strip():
        continue
    d = json.loads(line)
    n = norm(d["name"])
    if n in sin_bio:
        cola.append({"name": d["name"], "rymHref": d["rymHref"]})
    else:
        con_bio += 1

os.makedirs(OUT_DIR, exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    for r in cola:
        f.write(json.dumps(r, ensure_ascii=False) + "\n")
print(f"cola-nuevos: {len(cola)} pendientes · {con_bio} ya con bio (fuera) → {OUT}")
