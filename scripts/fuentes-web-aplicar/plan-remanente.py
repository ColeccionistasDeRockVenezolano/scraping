#!/usr/bin/env python3
"""Etapa 4 · remanente de las fuentes web cosechadas el 2026-10-01 — PLAN, solo lectura.

Fuentes (data/raw/fuentes-web-2026-10-01/consolidado/): MusicaVenezuela (mv-artistas.jsonl),
Wikipedia (wiki-parsed.jsonl), Rockshop (rockshop-bands.json), Paltoque (paltoque-bands.json) y
La Guía de Caracas (lagc-bands.json). El 2026-10-01 se aplicó una parte (etapa 1 web); aquí se
mide contra el catálogo VIVO y se emite solo lo que sigue vacío (regla: la fuente rellena huecos).

Salidas en reports/fuentes-web-remanente-2026-10-05/:
  altas-discos.jsonl      discos que faltan (artista del catálogo + título + año + tipo + fuente)
  completar-pistas.jsonl  listas de pistas de Wikipedia para discos sin pistas
  completar-anios.jsonl   año de discos sin año
  completar-generos.jsonl libro para apply-source-genres (artistas y discos sin principal)
  fotos.jsonl             fotos de artista (formato localize-images --candidates)
  portadas.jsonl          portadas de disco (ídem)
  formacion.jsonl         año de formación de artistas sin él
  resumen.json
y en reports/bio-texts/: musicavenezuela.jsonl, paltoque.jsonl, rockshop.jsonl,
laguiadecaracas.jsonl (textos de fuente para los expedientes de la síntesis de bios).

Uso: python3 scripts/fuentes-web-aplicar/plan-remanente.py
"""
import ast
import collections
import json
import os
import re
import subprocess
import time
import unicodedata

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
C = f"{ROOT}/data/raw/fuentes-web-2026-10-01/consolidado"
OUT = f"{ROOT}/reports/fuentes-web-remanente-2026-10-05"
BIO = f"{ROOT}/reports/bio-texts"
URLS = {"paltoque": "https://paltoque.com/21-bandas-que-definen-el-rock-venezolano/",
        "laguiadecaracas": "http://laguiadecaracas.net/55945/7-bandas-de-rock-venezolano-de-los-80/",
        "rockshop": "https://www.rockshop.com.mx/bandas-de-rock/venezolanas/"}


def sql(q):
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-At", "-F", "\t", "-c", q],
                       capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr)
    return [l.split("\t") for l in r.stdout.split("\n") if l.strip()]


def cp(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]", "", s)


def lit(v):
    if isinstance(v, str):
        try:
            return ast.literal_eval(v)
        except Exception:
            return v
    return v


def hay(v):
    return v not in (None, "None", "", [], "[]", {})


def anio(v):
    try:
        y = int(str(v)[:4])
        return y if 1900 <= y <= 2026 else None
    except Exception:
        return None


def limpia(texto):
    t = re.sub(r"\*\*|__", "", str(texto or ""))
    return re.sub(r"[ \t]+", " ", re.sub(r"\n{3,}", "\n\n", t)).strip()


def main():
    os.makedirs(OUT, exist_ok=True)
    # ---- catálogo vivo
    art, byid = {}, {}
    for i, n, bio, pic, fy, g in sql("""SELECT a.id, a.name, (a.biography IS NOT NULL AND btrim(a.biography)<>''),
               (a.picture_url IS NOT NULL AND btrim(a.picture_url)<>''), a.formed_year IS NOT NULL,
               EXISTS (SELECT 1 FROM ingest.artist_genres g WHERE g.artist_id=a.id AND g.role='primary' AND g.status='confirmed')
               FROM public.artists a"""):
        a = {"id": int(i), "name": n, "bio": bio == "t", "pic": pic == "t", "fy": fy == "t", "g": g == "t"}
        byid[a["id"]] = a
        art.setdefault(cp(n), a)
    for i, al in sql("SELECT artist_id, alias FROM ingest.artist_aliases"):
        if int(i) in byid:
            art.setdefault(cp(al), byid[int(i)])
    albs = collections.defaultdict(list)
    for i, a, t, y, cov, tr, g in sql("""SELECT al.id, al.artist_id, al.title, al.release_year IS NOT NULL,
               (al.cover_url IS NOT NULL AND btrim(al.cover_url)<>''),
               EXISTS (SELECT 1 FROM public.tracks t WHERE t.album_id=al.id),
               EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id=al.id AND g.role='primary' AND g.status='confirmed')
               FROM public.albums al"""):
        albs[int(a)].append({"id": int(i), "title": t, "c": cp(t), "y": y == "t", "cov": cov == "t", "tr": tr == "t", "g": g == "t"})

    def disco(aid, titulo):
        k = cp(titulo)
        for h in albs.get(aid, []):
            if k and (k == h["c"] or (len(k) >= 6 and len(h["c"]) >= 6 and (k.startswith(h["c"]) or h["c"].startswith(k)))):
                return h
        return None

    altas, pistas, anios_, generos, fotos, portadas, formacion = [], [], [], [], [], [], []
    textos = collections.defaultdict(list)
    vistos_alta = set()
    cuenta = collections.Counter()

    def alta(aid, titulo, y, tipo, fuente, url, ev):
        k = (aid, cp(titulo))
        if not cp(titulo) or k in vistos_alta:
            return
        vistos_alta.add(k)
        altas.append({"artistId": aid, "artist": byid[aid]["name"], "title": titulo.strip(), "year": y,
                      "album_type": tipo or "other", "source": fuente, "url": url, "evidence": ev[:280]})
        cuenta[f"alta disco ({fuente})"] += 1

    # ---- MusicaVenezuela
    for x in map(json.loads, open(f"{C}/mv-artistas.jsonl", encoding="utf-8")):
        a = art.get(cp(x["nombre"]))
        if not a:
            cuenta["mv: artista fuera del catálogo"] += 1
            continue
        url = x["url"]
        if hay(x.get("bio")):
            textos["musicavenezuela"].append({"caseId": f"artist:{a['id']}", "kind": "artist", "entityId": a["id"],
                                              "source": "musicavenezuela", "url": url, "lang": "es", "text": limpia(x["bio"])})
        gs = lit(x.get("generos"))
        if hay(gs) and not a["g"]:
            generos.append({"caseId": f"mv:artist:{a['id']}", "kind": "artist", "entityId": a["id"], "source": "musicavenezuela",
                            "url": url, "title": a["name"], "rawGenres": list(gs)})
        if hay(x.get("foto_url")) and not a["pic"]:
            fotos.append({"kind": "artist", "id": a["id"], "sourceUrl": x["foto_url"], "label": a["name"], "source": "musicavenezuela", "snapshotUrl": url})
        for d in lit(x.get("albums")) or []:
            h = disco(a["id"], d.get("titulo"))
            y = anio(d.get("anio"))
            if not h:
                alta(a["id"], d.get("titulo") or "", y, None, "musicavenezuela", url, f"Discografía según MusicaVenezuela: «{d.get('titulo')}»{f' ({y})' if y else ''}")
                continue
            if hay(d.get("cover_url")):
                portadas.append({"kind": "album", "id": h["id"], "sourceUrl": d["cover_url"], "label": h["title"], "source": "musicavenezuela",
                                 "snapshotUrl": url, "ficha_con_portada": h["cov"]})
            if y and not h["y"]:
                anios_.append({"albumId": h["id"], "title": h["title"], "year": y, "url": url, "note": f"MusicaVenezuela: «{d.get('titulo')}» ({y})"})

    # ---- Wikipedia
    wiki = list(map(json.loads, open(f"{C}/wiki-parsed.jsonl", encoding="utf-8")))
    for x in wiki:
        if x["tipo"] == "album":
            continue
        a = art.get(cp(x.get("ib_nombre") or x["titulo"])) or art.get(cp(x["titulo"]))
        if not a:
            cuenta[f"wiki {x['tipo']}: no casa con artista"] += 1
            continue
        url = x["url"]
        if hay(x.get("ib_genero")) and not a["g"]:
            generos.append({"caseId": f"wiki:artist:{a['id']}", "kind": "artist", "entityId": a["id"], "source": "wikipedia",
                            "url": url, "title": a["name"], "rawGenre": str(x["ib_genero"])})
        fy = anio(x.get("formed_year_ib")) or anio(x.get("formed_year_intro"))
        if fy and not a["fy"]:
            formacion.append({"artistId": a["id"], "artist": a["name"], "year": fy, "source": "wikipedia", "url": url,
                              "note": f"Wikipedia: «{a['name']}» ({x.get('ib_duracion') or fy})"})
        img = lit(x.get("img"))
        if isinstance(img, dict) and img.get("url") and not a["pic"] and x["tipo"] == "banda" and "logo" not in img["url"].lower():
            fotos.append({"kind": "artist", "id": a["id"], "sourceUrl": img.get("url_descargada") or img["url"], "label": a["name"],
                          "source": "wikipedia", "snapshotUrl": url})
        for d in lit(x.get("discografia")) or []:
            if not isinstance(d, dict) or not d.get("titulo"):
                continue
            if not disco(a["id"], d["titulo"]):
                alta(a["id"], d["titulo"], anio(d.get("anio")), d.get("tipo"), "wikipedia", url,
                     f"Discografía de «{a['name']}» en Wikipedia: «{d['titulo']}»" + (f" ({d['anio']})" if d.get("anio") else ""))
    for x in wiki:
        if x["tipo"] != "album":
            continue
        nombre_art = x.get("ib_artista") or ""
        if not nombre_art:
            for c in lit(x.get("cats")) or []:
                m = re.match(r"Categor[ií]a:Álbumes de (.+)$", c)
                if m:
                    nombre_art = m.group(1)
                    break
        a = art.get(cp(nombre_art))
        if not a:
            cuenta["wiki disco: artista fuera del catálogo"] += 1
            continue
        url = x["url"]
        titulo = re.sub(r"\s*\((?:álbum|album|disco)[^)]*\)$", "", x.get("ib_nombre") or x["titulo"])
        y = anio(x.get("anio_ib"))
        h = disco(a["id"], titulo)
        if not h:
            alta(a["id"], titulo, y, None, "wikipedia", url, f"Artículo de Wikipedia del disco «{titulo}» de {a['name']}")
            cuenta["wiki disco: alta (sus pistas entran tras el alta)"] += 1
            continue
        if hay(x.get("tracklist")) and not h["tr"]:
            pistas.append({"albumId": h["id"], "title": h["title"], "url": url,
                           "tracks": [{"disc": 1, "position": n, "title": str(t).strip()[:250], "duration": None}
                                      for n, t in enumerate(x["tracklist"], 1) if str(t).strip()]})
        if y and not h["y"]:
            anios_.append({"albumId": h["id"], "title": h["title"], "year": y, "url": url, "note": f"Wikipedia: «{titulo}» ({y})"})
        if hay(x.get("ib_genero")) and not h["g"]:
            generos.append({"caseId": f"wiki:album:{h['id']}", "kind": "album", "entityId": h["id"], "source": "wikipedia",
                            "url": url, "title": h["title"], "rawGenre": str(x["ib_genero"])})

    # ---- artículos: Rockshop, Paltoque, La Guía de Caracas → solo textos de bio
    rs = json.load(open(f"{C}/rockshop-bands.json", encoding="utf-8"))
    articulos = [("rockshop", k[3:].replace("-", " "), "\n\n".join(f"{t}: {v}" for t, v in secc.items())) for k, secc in rs.items()]
    articulos += [("paltoque", x["banda"], "\n\n".join(x["parrafos"])) for x in json.load(open(f"{C}/paltoque-bands.json", encoding="utf-8")) if x["parrafos"]]
    articulos += [("laguiadecaracas", x["banda"], "\n\n".join(x["parrafos"])) for x in json.load(open(f"{C}/lagc-bands.json", encoding="utf-8")) if x["parrafos"]]
    for fuente, banda, texto in articulos:
        a = art.get(cp(banda))
        if not a:
            cuenta[f"{fuente}: banda fuera del catálogo"] += 1
            continue
        textos[fuente].append({"caseId": f"artist:{a['id']}", "kind": "artist", "entityId": a["id"], "source": fuente,
                               "url": URLS[fuente], "lang": "es", "text": limpia(texto)})

    def escribir(path, filas):
        with open(path, "w", encoding="utf-8") as fh:
            for f in filas:
                fh.write(json.dumps(f, ensure_ascii=False) + "\n")

    for nombre, filas in (("altas-discos", altas), ("completar-pistas", pistas), ("completar-anios", anios_),
                          ("completar-generos", generos), ("fotos", fotos), ("portadas", portadas), ("formacion", formacion)):
        escribir(f"{OUT}/{nombre}.jsonl", filas)
    for fuente, filas in textos.items():
        escribir(f"{BIO}/{fuente}.jsonl", filas)

    sin_bio = {t["entityId"] for fs in textos.values() for t in fs if not byid[t["entityId"]]["bio"]}
    resumen = {
        "generado": time.strftime("%Y-%m-%d %H:%M:%S"),
        "altas_discos": len(altas), "altas_por_fuente": dict(collections.Counter(a["source"] for a in altas)),
        "pistas (discos sin pistas)": len(pistas), "años (discos sin año)": len(anios_),
        "géneros (fichas sin principal)": dict(collections.Counter(g["kind"] for g in generos)),
        "fotos de artista (sin foto)": len(fotos),
        "portadas: ficha vacía → se fija": sum(1 for p in portadas if not p["ficha_con_portada"]),
        "portadas: ficha con imagen → candidata": sum(1 for p in portadas if p["ficha_con_portada"]),
        "formación (sin año)": len(formacion),
        "textos de bio por fuente": {k: len(v) for k, v in textos.items()},
        "artistas sin bio con texto nuevo": len(sin_bio),
        **{k: v for k, v in cuenta.items()},
    }
    json.dump(resumen, open(f"{OUT}/resumen.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(resumen, ensure_ascii=False, indent=1))


if __name__ == "__main__":
    main()
