#!/usr/bin/env python3
"""RYM «nuevos» · etapa 1 bis — tras las altas de personas venezolanas, la persona queda como
«Titular del proyecto» de la ficha de artista recién creada (modelo del caso Ashwave).

Lee la solicitud (person_id por rym_href) y el informe altas-apply-*.json indicado; escribe
el plan para `crv review persons --plan=… --confirm`.

Uso: python3 scripts/rym-nuevos-aplicar/plan-titulares-vz.py <altas-apply.json>
"""
import importlib.util
import json
import os
import sys

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
spec = importlib.util.spec_from_file_location("plan_discos", os.path.join(ROOT, "scripts/rym-nuevos-aplicar/plan-discos.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)


def main():
    sol = json.load(open(os.path.join(P.OUT, "solicitud-altas-personas-vz.json"), encoding="utf-8"))
    persona = {f"rym-nuevos:artist:{P.R.slugify(P.R.norm_href(c['rym_href']))}": c["person_id"]
               for c in sol["casos"] if c["tipo"] == "artist"}
    creadas = [c for c in json.load(open(sys.argv[1], encoding="utf-8"))["creadas"] if c["clave"] in persona]
    # la persona pudo fundirse: seguir su redirección
    redir = {int(a): int(b) for a, b in P.sql("SELECT from_id, to_id FROM ingest.entity_redirects WHERE entity_kind='person'")}
    pnames = {int(i): n for i, n in P.sql("SELECT id, name FROM public.persons")}
    anames = {int(i): n for i, n in P.sql("SELECT id, name FROM public.artists")}
    corr, faltan = [], []
    for c in creadas:
        pid = P.seguir(redir, int(persona[c["clave"]]))
        if pid not in pnames or c["id"] not in anames:
            faltan.append(c)
            continue
        corr.append({"op": "link_project", "person": {"id": pid, "name": pnames[pid]},
                     "artist": {"id": c["id"], "name": anames[c["id"]]}, "role": "Titular del proyecto",
                     "why": "Persona venezolana con discografía propia en RYM: su ficha de artista se creó el 2026-10-05 (decisión «solo los venezolanos» de Brian)"})
    out = os.path.join(P.OUT, "titulares-personas-vz.json")
    json.dump({"decidedAt": "2026-10-05", "evidence": "reports/rym-nuevos-aplicacion-2026-10-05/personas-vz.json", "corrections": corr},
              open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps({"enlaces": len(corr), "sin persona o artista": len(faltan), "plan": out}, ensure_ascii=False))


if __name__ == "__main__":
    main()
