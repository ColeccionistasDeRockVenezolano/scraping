#!/usr/bin/env python3
"""Etapa 4 «Altas» — genera la solicitud del LOTE desde los dossiers.

Selección (aprobada por Brian, 2026-10-03):
  · bandas   = dossier-nuevos accion alta_artista_banda        (menos las ya aplicadas de la muestra)
  · personas = dossier-nuevos accion alta_persona_miembro      (menos las ya aplicadas)
  · discos   = dossier-discos sección 222, estado «fuera», tipo propio
               (Album/Single/EP/Compilation/Live Album/DJ Mix/Mixtape), menos los aplicados

Uso: python3 scripts/etapa4-altas-2026-10-03/solicitud-lote.py [salida.json] [--quitar=archivo.txt]
     (--quitar: un rym_href por línea, p. ej. los que el pre-chequeo dejó con guardas)
"""
import json
import re
import sys

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
OUT = f"{ROOT}/reports/etapa4-altas-2026-10-03"

# Ya aplicados en la muestra (run 11722)
YA = {
    "/artist/serenada", "/artist/orquesta-la-tremenda", "/artist/los-imperials",
    "/artist/la-danta-mas-cabra", "/artist/anakena",
    "/artist/marianne-mali", "/artist/ava-casas", "/artist/akilin", "/artist/jose-rosario", "/artist/underaiki",
    "/release/album/la-puta-electrica/automatron", "/release/ep/la-puta-electrica/a-gogo-maldito",
    "/release/album/los-imperials/ritmo-juvenil-con-los-imperials",
    "/release/album/serenada/serenada_volumen",
    "/release/album/orquesta-la-tremenda/fieston-79",
    "/release/album/la-danta-mas-cabra/triple-in-tension",
}
TIPOS_DISCO = {"Album", "Single", "EP", "Compilation", "Live Album", "DJ Mix", "Mixtape"}


def cargar(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    salida = args[0] if args else f"{OUT}/solicitud-lote1.json"
    quitar = set()
    for a in sys.argv[1:]:
        if a.startswith("--quitar="):
            quitar = {l.strip() for l in open(a.split("=", 1)[1], encoding="utf-8") if l.strip()}
    excluir = YA | quitar

    casos = []
    for r in cargar(f"{OUT}/dossier-nuevos.jsonl"):
        if r["rym_href"] in excluir:
            continue
        if r["accion_sugerida"] == "alta_artista_banda":
            casos.append({"tipo": "artist", "rym_href": r["rym_href"],
                          "motivo": f"banda; formed {r['ev_formed'] or '?'}; {r['ev_n_discos']} discos; dossier#alta_artista_banda"})
        elif r["accion_sugerida"] == "alta_persona_miembro":
            casos.append({"tipo": "person", "rym_href": r["rym_href"],
                          "motivo": f"persona miembro ({r['miembro_de'][:60]}); dossier#alta_persona_miembro"})

    n_alb = 0
    for r in cargar(f"{OUT}/dossier-discos.jsonl"):
        if r["seccion"] != "222" or r["estado"] != "fuera":
            continue
        if r["rym_href"] in excluir or r["tipo_rym"] not in TIPOS_DISCO:
            continue
        m = re.match(r"id (\d+)", str(r["artista_ref"] or ""))
        if not m:
            continue
        casos.append({"tipo": "album", "origen": "ledger", "rym_href": r["rym_href"], "artist_id": int(m.group(1)),
                      "motivo": f"ledger 222 (fuera de catálogo); {r['tipo_rym']} {r['anio']}"})
        n_alb += 1

    json.dump({"nota": "Lote etapa 4 aprobado por Brian (2026-10-03): bandas + personas sugeridas + discos del ledger 222. "
                       "Generado por solicitud-lote.py.",
               "casos": casos},
              open(salida, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    from collections import Counter
    c = Counter(x["tipo"] for x in casos)
    print(f"solicitud: {len(casos)} casos {dict(c)} → {salida}")


if __name__ == "__main__":
    main()
