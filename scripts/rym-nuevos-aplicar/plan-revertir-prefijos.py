#!/usr/bin/env python3
"""RYM «nuevos» · corrección de los cruces por PREFIJO de título (2026-10-06) — PLAN, solo lectura.

plan-discos.py casaba un disco de RYM con uno del catálogo si un título empezaba por el otro
(«Sicko Mode» ⇄ «Sicko Mode (Remix)», «… el cielo» ⇄ «… el cielo: Act 2»). Brian: «deshacer los
330 y rehacer exacto». Por disco del catálogo tocado lista las ediciones de RYM exactas y por
prefijo, con año, portada y tracklist de cada una, para que revertir-prefijos.mts quite solo lo
que vino de una edición por prefijo (si el disco también tiene edición exacta, lo de esa se queda).

Compara plan-discos.prefijo.jsonl (el aplicado) con plan-discos.jsonl (rehecho con cruce exacto).
Salida: reports/rym-nuevos-aplicacion-2026-10-05/prefijos-plan.json
Uso: python3 scripts/rym-nuevos-aplicar/plan-revertir-prefijos.py
"""
import collections
import importlib.util
import json
import os

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
spec = importlib.util.spec_from_file_location("plan_discos", os.path.join(ROOT, "scripts/rym-nuevos-aplicar/plan-discos.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


def edicion(r):
    try:
        s = open(os.path.join(P.PAGES, P.R.slug_release(r["rym_href"]) + ".html"), encoding="utf-8", errors="replace").read()
        pistas, _ = P.pistas_html(s)
    except Exception:
        pistas = None
    return {"url": r["url"], "titulo": r["titulo"], "anio": r.get("anio"), "portada": r.get("portada") or None,
            "pistas": [p["title"] for p in (pistas or [])]}


def main():
    # plan-discos.prefijo.jsonl = el plan con el que se aplicó (cruce por prefijo); plan-discos.jsonl = el
    # rehecho con cruce exacto. Lo que estaba casado antes y ya no lo está es «prefijo».
    viejo = [json.loads(l) for l in open(os.path.join(P.OUT, "plan-discos.prefijo.jsonl"), encoding="utf-8")]
    nuevo = [json.loads(l) for l in open(os.path.join(P.OUT, "plan-discos.jsonl"), encoding="utf-8")]
    exacto = {(r["album_id"], r["rym_href"]) for r in nuevo if r.get("estado") == "ya_existe"}
    por_disco = collections.defaultdict(lambda: {"exactas": [], "prefijo": []})
    for r in viejo + [r for r in nuevo if r.get("estado") == "ya_existe"]:
        if r.get("estado") != "ya_existe":
            continue
        d = por_disco[r["album_id"]]
        d["titulo"] = r["album_titulo"]
        lado = "exactas" if (r["album_id"], r["rym_href"]) in exacto else "prefijo"
        if all(e["url"] != r["url"] for e in d[lado]):
            d[lado].append(edicion(r))
    plan = [{"albumId": k, **v} for k, v in por_disco.items() if v["prefijo"]]
    json.dump(plan, open(os.path.join(P.OUT, "prefijos-plan.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"discos": len(plan), "con_exacta": sum(1 for p in plan if p["exactas"]),
                      "ediciones_prefijo": sum(len(p["prefijo"]) for p in plan)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
