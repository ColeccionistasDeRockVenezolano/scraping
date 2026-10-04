#!/usr/bin/env python3
"""Verificador reutilizable del lote de altas: detecta fichas creadas desde filas
«Appears On» (artista equivocado) y duplicados del mismo release (doble firma).

Cruza un JSON de aplicación del motor de altas (altas-apply-*.json) con el plan
(plan-*.jsonl) y las capturas de página RYM (data/raw/.../rym-etapa3/pages/*.json,
columna `ty` de cada fila de discografía).

Uso:
  python3 scripts/etapa4-altas-2026-10-03/verificar-filas-appears-on.py \
      --apply=reports/etapa4-altas-2026-10-03/altas-apply-202610040020.json \
      --plan=reports/etapa4-altas-2026-10-03/plan-lote1.jsonl

Salida: una línea por víctima (ficha creada cuya fila del padre es «Appears On»)
y una por par duplicado; termina con un resumen. SOLO LECTURA.
"""
import argparse
import glob
import json
import re
import subprocess
import unicodedata


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s)).strip()


def normhref(h):
    h = (h or "").split("?")[0].rstrip("/")
    if h.startswith("https://rateyourmusic.com"):
        h = h[len("https://rateyourmusic.com"):]
    return h.lower()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", required=True)
    ap.add_argument("--plan", required=True)
    ap.add_argument("--pages", default="data/raw/fuentes-web-2026-10-01/rym-etapa3/pages")
    a = ap.parse_args()

    idx = {}
    for f in glob.glob(f"{a.pages}/*.json"):
        name = f.split("/")[-1].replace(".json", "")
        if name.startswith("rel_"):
            continue
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        for r in ((d.get("rec") or d).get("rows") or []):
            h = normhref(r.get("h"))
            if h:
                idx.setdefault(h, []).append((name, (r.get("ty") or "?")))

    doc = json.load(open(a.apply, encoding="utf-8"))
    albs = [c for c in doc["creadas"] if c["tipo"] == "album"]
    ids = ",".join(str(c["id"]) for c in albs)
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-tAc",
                        f"SELECT al.id, al.artist_id, ar.name FROM public.albums al "
                        f"JOIN public.artists ar ON ar.id=al.artist_id WHERE al.id IN ({ids})"],
                       capture_output=True, text=True)
    db = {}
    for linea in r.stdout.strip().split("\n"):
        if linea:
            i, aid, an = linea.split("|", 2)
            db[int(i)] = (int(aid), an)

    plan = {}
    for linea in open(a.plan, encoding="utf-8"):
        it = json.loads(linea)
        if it.get("tipo") == "album":
            plan.setdefault(it["clave"], []).append(it)

    vics, dups, vivas = [], {}, 0
    for c in albs:
        aid = int(c["id"])
        if aid not in db:
            continue  # fusionada/redirect: no es una ficha viva de este lote
        vivas += 1
        artist_id, an = db[aid]
        items = [i for i in plan.get(c["clave"], [])
                 if str((i.get("parent") or {}).get("artist_id")) == str(artist_id)]
        if not items:
            continue
        href = normhref(items[0].get("rym_href"))
        dups.setdefault(href, []).append(aid)
        own = [(pg, ty) for pg, ty in idx.get(href, []) if norm(pg) == norm(an)]
        if own and all("appears" in ty.lower() for _, ty in own):
            vics.append((aid, an, href, own))

    print(f"creadas vivas del lote: {vivas} · víctimas «Appears On»: {len(vics)} · pares duplicados: "
          f"{sum(1 for v in dups.values() if len(v) > 1)}")
    for v in vics:
        print(" VICTIMA |", v)
    for h, v in dups.items():
        if len(v) > 1:
            print(" DUP-PAR |", h, "->", v)
    if not vics and all(len(v) == 1 for v in dups.values()):
        print("limpio: sin víctimas ni duplicados pendientes")


if __name__ == "__main__":
    main()
