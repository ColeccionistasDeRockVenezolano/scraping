#!/usr/bin/env python3
"""Aplicación de RYM «nuevos» · etapa 1 bis — discos cuyo dueño solo existe como PERSONA.

Decisión de Brian 2026-10-05: «solo los venezolanos». Señal venezolana = la ficha RYM dice
Venezuela en Born/Formed/Currently, o la persona ya está afirmada venezolana en el catálogo
(persons.is_venezuelan = true). Al resto (extranjeros o sin señal) no se le toca nada.

Para cada persona venezolana: alta de ficha de artista (solista, con su nombre RYM) + altas de
sus discos propios (mismo filtro que plan-discos.py: sin Appears On / V/A / video ni discos ya
en el catálogo). Tras el alta, la persona se enlaza como «Titular del proyecto» (crv review persons).

Salidas en reports/rym-nuevos-aplicacion-2026-10-05/: solicitud-altas-personas-vz.json,
personas-vz.json (con quién entra y quién no, y por qué).

Uso: python3 scripts/rym-nuevos-aplicar/plan-personas-vz.py
"""
import collections
import importlib.util
import json
import os
import re

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
spec = importlib.util.spec_from_file_location("plan_discos", os.path.join(ROOT, "scripts/rym-nuevos-aplicar/plan-discos.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
R = P.R


def lugar(href):
    f = os.path.join(P.PAGES, R.slugify(href) + ".html")
    if not os.path.exists(f):
        return ""
    s = open(f, encoding="utf-8", errors="replace").read()
    m = re.findall(r'<div class="info_hdr">(Born|Formed|Currently)</div>\s*<div class="info_content">(.*?)</div>', s, re.S)
    return " | ".join(f"{a}: {re.sub('<[^>]+>', '', b).strip()}" for a, b in m)


def main():
    artistas, redir, por_nombre, albumes = P.cargar_catalogo()
    resolver = P.mapa_artistas(artistas, redir, por_nombre)
    vz = {int(r[0]): r[1] for r in P.sql("SELECT id, coalesce(is_venezuelan::text,'') FROM public.persons")}
    estado, _ = R.cargar_estado(os.path.join(P.NUEVOS, "estado.json"))
    cola = R.cargar_cola(os.path.join(P.NUEVOS, "cola-nuevos.jsonl"))

    filas = collections.defaultdict(list)
    nombres = {}
    for row in cola:
        h = R.norm_href(row.get("rymHref"))
        nombres[h] = row.get("name") or ""
        try:
            rec = json.load(open(os.path.join(P.PAGES, R.slugify(h) + ".json"), encoding="utf-8"))["rec"]
        except Exception:
            continue
        for r in rec.get("rows") or []:
            rel = R.norm_href(r.get("h"))
            if rel:
                filas[rel].append((h, (r.get("ty") or "").strip()))

    res = {}
    def dueno(h):
        if h not in res:
            res[h] = resolver(h, nombres.get(h, ""))
        return res[h]

    personas, discos = {}, collections.defaultdict(list)
    for rel, fs in filas.items():
        if not R.es_ok_release(estado.get(rel) or {}):
            continue
        propias = [f for f in fs if f[1] not in P.NO_PROPIOS]
        seg = rel.split("/")[3] if len(rel.split("/")) > 4 else ""
        if not propias or seg == "various-artists":
            continue
        def orden(f):
            s = f[0].replace("/artist/", "")
            return (0, 0) if s == seg else ((1, seg.find(s)) if s and s in seg else (2, 0))
        propias.sort(key=orden)
        cands = [(f, dueno(f[0])) for f in propias]
        if any(d[0] == "artist" for _, d in cands) or cands[0][1][0] != "person":
            continue
        h, tipo = cands[0][0]
        pid = cands[0][1][1]
        if h not in personas:
            loc = lugar(h)
            señal = "Venezuela" in loc or vz.get(pid) == "true"
            personas[h] = {"rym_href": h, "nombre": nombres.get(h, ""), "person_id": pid,
                           "is_venezuelan": vz.get(pid, "sin ficha"), "lugar_rym": loc, "entra": señal}
        discos[h].append((rel, tipo))

    casos = []
    for h, p in personas.items():
        p["discos"] = len(discos[h])
        if not p["entra"]:
            continue
        motivo = f"Persona venezolana con discografía propia en RYM ({p['lugar_rym'] or 'persona venezolana del catálogo'}); decisión «solo los venezolanos» de Brian 2026-10-05"
        casos.append({"tipo": "artist", "rym_href": h, "artist_type": "solo_artist", "person_id": p["person_id"], "motivo": motivo})
        for rel, tipo in discos[h]:
            casos.append({"tipo": "album", "origen": "nuevos", "rym_href": rel, "parent_href": h,
                          "album_type": P.MAPA_TIPO.get(tipo) or "other",
                          "motivo": f"Discografía RYM de «{p['nombre']}» ({tipo or 'sin tipo'}); persona venezolana sin ficha de artista"})
    json.dump({"nota": "Discos de personas venezolanas sin ficha de artista (RYM «nuevos»), Brian 2026-10-05", "casos": casos},
              open(os.path.join(P.OUT, "solicitud-altas-personas-vz.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    json.dump(sorted(personas.values(), key=lambda x: (not x["entra"], x["nombre"])),
              open(os.path.join(P.OUT, "personas-vz.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    entra = [p for p in personas.values() if p["entra"]]
    print(json.dumps({"personas dueñas": len(personas), "entran": len(entra), "discos que entran": sum(p["discos"] for p in entra),
                      "fuera": len(personas) - len(entra), "discos fuera": sum(p["discos"] for p in personas.values() if not p["entra"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
