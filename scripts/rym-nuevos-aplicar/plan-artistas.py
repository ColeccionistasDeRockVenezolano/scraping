#!/usr/bin/env python3
"""Aplicación de RYM «nuevos» · etapa 1 (pasos 1.6 y 1.7) — PLAN de fichas de artista, solo lectura.

Desde la ficha de artista capturada (pages/<slug>.json) y para el artista del catálogo que le
corresponde (mismo cruce que plan-discos.py, con los «verificado distinto» fuera):

  * géneros propios del artista → libro para apply-source-genres (el aplicador no toca fichas
    con principal confirmado; el primero que da RYM es el principal);
  * año de formación → solo artistas sin año (formato de aplicar-remanente.mts --phase=formacion).

Salidas en reports/rym-nuevos-aplicacion-2026-10-05/: completar-generos-artistas.jsonl, formacion-rym.jsonl

Uso: python3 scripts/rym-nuevos-aplicar/plan-artistas.py
"""
import importlib.util
import json
import os

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
spec = importlib.util.spec_from_file_location("plan_discos", os.path.join(ROOT, "scripts/rym-nuevos-aplicar/plan-discos.py"))
P = importlib.util.module_from_spec(spec)
spec.loader.exec_module(P)
R = P.R


def main():
    artistas, redir, por_nombre, _ = P.cargar_catalogo()
    resolver = P.mapa_artistas(artistas, redir, por_nombre)
    sin_principal = {int(r[0]) for r in P.sql("""SELECT a.id FROM public.artists a WHERE NOT EXISTS (
        SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id=a.id AND g.role='primary' AND g.status='confirmed')""")}
    sin_anio = {int(r[0]) for r in P.sql("SELECT id FROM public.artists WHERE formed_year IS NULL")}
    generos, formacion, vistos = [], [], set()
    for row in R.cargar_cola(os.path.join(P.NUEVOS, "cola-nuevos.jsonl")):
        h = R.norm_href(row.get("rymHref"))
        tipo, aid, _ = resolver(h, row.get("name") or "")
        if tipo != "artist" or aid in vistos:
            continue
        try:
            rec = json.load(open(os.path.join(P.PAGES, R.slugify(h) + ".json"), encoding="utf-8"))["rec"]
        except Exception:
            continue
        vistos.add(aid)
        url = P.BASE + h
        if rec.get("genres") and aid in sin_principal:
            generos.append({"caseId": f"rym-nuevos:artist:{aid}", "kind": "artist", "entityId": aid, "source": "rateyourmusic",
                            "url": url, "title": artistas[aid], "rawGenres": list(rec["genres"])})
        f = rec.get("formed")
        if isinstance(f, int) and 1900 <= f <= 2026 and aid in sin_anio:
            formacion.append({"artistId": aid, "artist": artistas[aid], "year": f, "source": "rym", "url": url,
                              "note": f"ficha de Rate Your Music: «{artistas[aid]}» (formed {f})"})
    for nombre, filas in (("completar-generos-artistas.jsonl", generos), ("formacion-rym.jsonl", formacion)):
        with open(os.path.join(P.OUT, nombre), "w", encoding="utf-8") as fh:
            for x in filas:
                fh.write(json.dumps(x, ensure_ascii=False) + "\n")
    print(json.dumps({"géneros de artista (sin principal)": len(generos), "formación (sin año)": len(formacion)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
