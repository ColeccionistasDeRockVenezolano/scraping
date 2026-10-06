#!/usr/bin/env python3
"""Aplicación de RYM «nuevos» · etapa 1 (discos) — PLAN, solo lectura.

Decisión de Brian (2026-10-05): «completar + altas». Cada disco capturado en la fase 2
(`data/raw/fuentes-web-2026-10-01/rym-nuevos/pages/rel_*.{json,html}`) se cruza con su
dueño en el catálogo vivo:

  * disco que YA existe → solo se rellenan sus vacíos: pistas (si no tiene ninguna),
    año (si no tiene), portada (vacía → se fija; con imagen → candidata en Curaduría),
    géneros (el aplicador de fuentes no toca fichas con principal confirmado);
  * disco que NO existe → solicitud de alta para `plan-altas.py` + `altas-motor.mts`
    (careo ER, run reversible, dudas a la cola). Tras el alta se vuelve a correr
    este script y esos discos pasan a «ya existe» y se completan igual.

Fuera, con su motivo en el resumen: filas «Appears On», recopilaciones V/A y videos (el
dueño real no es el artista de la fila: trampa ya reparada en arreglar-appears-on.mts),
discos vacíos en RYM, dueños descartados por Brian o que solo existen como persona.

Salidas en reports/rym-nuevos-aplicacion-2026-10-05/:
  plan-discos.jsonl · solicitud-altas-discos.json · completar-pistas.jsonl ·
  completar-anios.jsonl · completar-portadas.jsonl · completar-generos.jsonl · resumen-plan.json

Uso: python3 scripts/rym-nuevos-aplicar/plan-discos.py
"""
import collections
import glob
import html as htmllib
import json
import os
import re
import subprocess
import sys
import time
import unicodedata

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
sys.path.insert(0, os.path.join(ROOT, "scripts"))
import rym_reglas as R  # noqa: E402

NUEVOS = R.OUTDIR_NUEVOS
PAGES = os.path.join(NUEVOS, "pages")
ALTAS = os.path.join(ROOT, "reports/etapa4-altas-2026-10-03")
OUT = os.path.join(ROOT, "reports/rym-nuevos-aplicacion-2026-10-05")
BASE = "https://rateyourmusic.com"

NO_PROPIOS = {"Appears On", "V/A Compilation", "Music video", "Video"}
MAPA_TIPO = {"Album": "studio_album", "Single": "single", "EP": "ep", "Compilation": "compilation",
             "Live Album": "live_album", "Demo": "demo", "Remix": "remix", "Mixtape": "other",
             "DJ Mix": "other", "Additional release": "other", "Bootleg / Unauthorized": "other"}
MAX_PISTAS = 60


def sql(q):
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv",
                        "-At", "-F", "\t", "-c", q], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("psql: " + r.stderr)
    return [l.split("\t") for l in r.stdout.split("\n") if l.strip()]


def compact(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def clave_titulo(s):
    """compact(); si el título no tiene letras latinas ni cifras («^^^^^», CJK), el literal sin espacios
    (compact los dejaba vacíos y nunca casaban)."""
    return compact(s) or re.sub(r"\s+", "", unicodedata.normalize("NFKC", s or "")).casefold()


def texto(fragmento):
    return re.sub(r"\s+", " ", htmllib.unescape(re.sub(r"<[^>]+>", " ", fragmento))).strip()


# ------------------------------------------------------------------ ficha de disco (HTML)

def pistas_html(s):
    """Lista de pistas desde el HTML guardado: [{disc, position, title, duration}] o (None, motivo)."""
    i = s.find('<ul id="tracks"')
    if i < 0:
        i = s.find('<ul class="tracks')
    if i < 0:
        return [], ""
    fin = s.find("</ul><div id=\"track_preview_tracks_mobile\"", i)
    bloque = s[i:fin if fin > 0 else len(s)]
    pistas, seq, vistos = [], collections.Counter(), set()
    for li in re.split(r'<li class="track"', bloque)[1:]:
        li = re.split(r'<ul class="credits"', li)[0]
        num = re.search(r'class="tracklist_num">(.*?)</span>', li, re.S)
        num = texto(num.group(1)) if num else ""
        m = re.search(r'itemprop="name"[^>]*>(.*?)</a>', li, re.S)
        if m:
            titulo = texto(m.group(1))
        else:
            t = re.search(r'class="tracklist_title">(.*?)<span class="tracklist_duration', li, re.S)
            titulo = texto(t.group(1)) if t else ""
        dur = re.search(r'data-inseconds="(\d+)"', li)
        dur = int(dur.group(1)) if dur and int(dur.group(1)) > 0 else None
        if not titulo or num in ("", "-"):
            continue  # encabezado de disco («Disco 1») o parte de un popurrí
        m = re.match(r"^(\d+)\.(\d+)$", num)
        if m:
            disc, pos = int(m.group(1)), int(m.group(2))
        else:
            disc = 1
            seq[disc] += 1
            pos = seq[disc]
        if (disc, pos) in vistos:
            return None, f"posición repetida {disc}-{pos}"
        vistos.add((disc, pos))
        pistas.append({"disc": disc, "position": pos, "title": titulo[:250], "duration": dur})
    if len(pistas) > MAX_PISTAS:
        return None, f"{len(pistas)} pistas (> {MAX_PISTAS})"
    return pistas, ""


def generos_html(s):
    pri = re.search(r'class="release_pri_genres">(.*?)</span>', s, re.S)
    sec = re.search(r'class="release_sec_genres">(.*?)</span>', s, re.S)
    out = []
    for bloque in (pri, sec):
        if bloque:
            for g in re.findall(r'<a [^>]*class="genre[^"]*"[^>]*>(.*?)</a>', bloque.group(1), re.S):
                g = texto(g)
                if g and g not in out:
                    out.append(g)
    return out


def anio_info(info):
    m = re.search(r"Released\s+(?:\d{1,2}\s+)?(?:[A-Z][a-z]+\s+)?(\d{4})", info or "")
    if m and 1900 <= int(m.group(1)) <= 2026:
        return int(m.group(1))
    return None


# ------------------------------------------------------------------ catálogo vivo

def cargar_catalogo():
    artistas = {int(r[0]): r[1] for r in sql("SELECT id, name FROM public.artists")}
    redir = {int(r[0]): int(r[1]) for r in sql(
        "SELECT from_id, to_id FROM ingest.entity_redirects WHERE entity_kind='artist'")}
    por_nombre = {}
    for i, n in artistas.items():
        por_nombre.setdefault(compact(n), i)
    for r in sql("SELECT artist_id, alias FROM ingest.artist_aliases"):
        por_nombre.setdefault(compact(r[1]), int(r[0]))
    albumes = collections.defaultdict(list)
    for r in sql("""SELECT a.id, a.artist_id, a.title, coalesce(a.release_year::text,''), a.album_type,
                           (a.cover_url IS NOT NULL AND btrim(a.cover_url)<>''),
                           EXISTS (SELECT 1 FROM public.tracks t WHERE t.album_id=a.id),
                           EXISTS (SELECT 1 FROM ingest.album_genres g WHERE g.album_id=a.id AND g.role='primary' AND g.status='confirmed')
                    FROM public.albums a"""):
        albumes[int(r[1])].append({"id": int(r[0]), "title": r[2], "c": clave_titulo(r[2]), "type": r[4],
                                   "year": int(r[3]) if r[3] else None, "cover": r[5] == "t",
                                   "tracks": r[6] == "t", "genre": r[7] == "t"})
    return artistas, redir, por_nombre, albumes


def seguir(redir, i):
    vistos = set()
    while i in redir and i not in vistos:
        vistos.add(i)
        i = redir[i]
    return i


def mapa_artistas(artistas, redir, por_nombre):
    """href RYM del artista → ('artist', id, vía) | ('person', id, vía) | ('descartado'|'sin_ficha', None, vía)."""
    creadas, revision = {}, {}
    for f in sorted(glob.glob(os.path.join(ALTAS, "altas-apply-*.json"))):
        d = json.load(open(f, encoding="utf-8"))
        for x in d.get("creadas") or []:
            creadas[x["clave"]] = x["id"]
        for x in d.get("review") or []:
            if x.get("existingId"):
                revision[x["clave"]] = x["existingId"]
    dossier = {R.norm_href(json.loads(l)["rym_href"]): json.loads(l)
               for l in open(os.path.join(ALTAS, "dossier-nuevos.jsonl"), encoding="utf-8") if l.strip()}

    def resolver(href, nombre):
        slug = R.slugify(href)
        d = dossier.get(href, {})
        dec = d.get("decision") or ""
        if "descartado" in dec:
            return ("descartado", None, dec[:60])
        for clave, via in ((f"rym-nuevos:artist:{slug}", "alta etapa 4"), (f"rym-nuevos:artist:{slug}", "revisión ER")):
            i = creadas.get(clave) if via == "alta etapa 4" else revision.get(clave)
            if i:
                i = seguir(redir, int(i))
                if i in artistas:
                    return ("artist", i, via)
        if "distinto" in dec or "sin alias" in dec:
            # Brian verificó que NO es la ficha parecida: ni el dossier ni el nombre valen
            return ("sin_ficha", None, "verificado distinto, sin alta propia")
        m = re.search(r"alias creado sobre artista (\d+)", dec)
        if m and seguir(redir, int(m.group(1))) in artistas:
            return ("artist", seguir(redir, int(m.group(1))), "alias (OK de Brian)")
        if d.get("cat_artist_id"):
            i = seguir(redir, int(d["cat_artist_id"]))
            if i in artistas:
                return ("artist", i, f"dossier ({d.get('cat_artist_via') or 'match'})")
        i = por_nombre.get(compact(nombre))
        if i and seguir(redir, i) in artistas:
            return ("artist", seguir(redir, i), "nombre exacto")
        p = creadas.get(f"rym-nuevos:person:{slug}") or d.get("cat_person_id")
        m = re.search(r"alias creado sobre persona (\d+)", dec)
        if p or m:
            return ("person", int(p or m.group(1)), "solo persona")
        return ("sin_ficha", None, dec[:60] or "sin alta")

    return resolver


# ------------------------------------------------------------------ plan

def main():
    t0 = time.time()
    os.makedirs(OUT, exist_ok=True)
    artistas, redir, por_nombre, albumes = cargar_catalogo()
    resolver = mapa_artistas(artistas, redir, por_nombre)
    cola = R.cargar_cola(os.path.join(NUEVOS, "cola-nuevos.jsonl"))
    estado, _ = R.cargar_estado(os.path.join(NUEVOS, "estado.json"))

    # filas de discografía por disco: [(href_artista, nombre, tipo, título, año)]
    filas = collections.defaultdict(list)
    for row in cola:
        h = R.norm_href(row.get("rymHref"))
        try:
            rec = json.load(open(os.path.join(PAGES, R.slugify(h) + ".json"), encoding="utf-8"))["rec"]
        except Exception:
            continue
        for r in rec.get("rows") or []:
            rel = R.norm_href(r.get("h"))
            if rel:
                filas[rel].append((h, row.get("name") or "", (r.get("ty") or "").strip(), (r.get("t") or "").strip(), r.get("y")))

    resueltos = {}

    def dueno(h, nombre):
        if h not in resueltos:
            resueltos[h] = resolver(h, nombre)
        return resueltos[h]

    plan, cont, motivos = [], collections.Counter(), collections.Counter()
    pistas_out, anios_out, portadas_out, generos_out, casos = [], [], [], [], []
    usadas = set()
    for rel, fs in filas.items():
        e = estado.get(rel) or {}
        base = {"rym_href": rel, "url": BASE + rel}
        if not R.es_ok_release(e):
            motivos["vacío en RYM"] += 1
            continue
        propias = [f for f in fs if f[2] not in NO_PROPIOS]
        seg = rel.split("/")[3] if len(rel.split("/")) > 4 else ""
        if not propias or seg == "various-artists":
            motivos["Appears On / V/A / video"] += 1
            continue
        # dueño: el artista acreditado primero en la URL del disco; si no tiene ficha, el siguiente coautor
        def orden(f):
            s = f[0].replace("/artist/", "")
            return (0, 0) if s == seg else ((1, seg.find(s)) if s and s in seg else (2, 0))
        propias.sort(key=orden)
        candidatos = [(f, dueno(f[0], f[1])) for f in propias]
        con_ficha = [(f, d) for f, d in candidatos if d[0] == "artist"]
        if not con_ficha:
            motivos["dueño " + candidatos[0][1][0]] += 1
            continue
        fila, (_, aid, via) = con_ficha[0]
        colab = len({f[0] for f in propias}) > 1
        try:
            rec = json.load(open(os.path.join(PAGES, R.slug_release(rel) + ".json"), encoding="utf-8"))["rec"]
            s = open(os.path.join(PAGES, R.slug_release(rel) + ".html"), encoding="utf-8", errors="replace").read()
        except Exception:
            motivos["ficha de disco ilegible"] += 1
            continue
        titulo = (rec.get("name") or fila[3]).strip()
        anio = None
        if fila[4]:
            m = re.match(r"(\d{4})", str(fila[4]).strip())
            anio = int(m.group(1)) if m and 1900 <= int(m.group(1)) <= 2026 else None
        anio = anio or anio_info(rec.get("info"))
        pistas, pistas_motivo = pistas_html(s)
        generos = generos_html(s) or list(rec.get("genres") or [])
        og = rec.get("og") or ""
        tipo = fila[2]

        # ¿ya existe? bajo el dueño o bajo cualquier coautor con ficha. Solo título IGUAL (el de la página o
        # el de la lista de discografía): el cruce por prefijo casaba remixes, demos, volúmenes y partes con
        # otro disco (corregido el 2026-10-06, ver revertir-prefijos.mts).
        # Con dos fichas del mismo título (EP y sencillo «The Journey»), una libre y del mismo tipo.
        claves = {c for c in (clave_titulo(titulo), clave_titulo(fila[3])) if c}
        hit = None
        for _, (_, cid, _) in con_ficha:
            iguales = [a for a in albumes.get(cid, []) if a["c"] in claves]
            iguales.sort(key=lambda a: (a["id"] in usadas, a["type"] != MAPA_TIPO.get(fila[2])))
            hit = iguales[0] if iguales else None
            if hit:
                break
        item = {**base, "titulo": titulo, "titulo_lista": fila[3], "artista_id": aid, "artista": artistas[aid], "via": via,
                "tipo_rym": tipo, "anio": anio, "n_pistas": len(pistas or []), "pistas_motivo": pistas_motivo,
                "generos": generos, "portada": og, "colab": colab}
        if hit:
            usadas.add(hit["id"])
            item.update(estado="ya_existe", album_id=hit["id"], album_titulo=hit["title"])
            cont["ya_existe"] += 1
            if pistas and not hit["tracks"]:
                pistas_out.append({"albumId": hit["id"], "title": hit["title"], "type": MAPA_TIPO.get(tipo, ""),
                                   "status": "ok", "source": "rateyourmusic", "url": BASE + rel,
                                   "tracks": [{"disc": p["disc"], "position": p["position"], "title": p["title"],
                                               "duration": p["duration"]} for p in pistas]})
            if pistas is None and not hit["tracks"]:
                cont["pistas rechazadas (" + pistas_motivo.split(" ")[0] + ")"] += 1
            if anio and hit["year"] is None:
                anios_out.append({"albumId": hit["id"], "title": hit["title"], "year": anio, "url": BASE + rel,
                                  "note": f"ficha de Rate Your Music: «{titulo}» ({anio})"})
            elif anio and hit["year"] and abs(hit["year"] - anio) > 1:
                cont["año distinto (no se toca)"] += 1
            if og.startswith("http"):
                portadas_out.append({"kind": "album", "id": hit["id"], "sourceUrl": og, "label": hit["title"],
                                     "artist": artistas[aid], "source": "rym", "snapshotUrl": BASE + rel,
                                     "ficha_con_portada": hit["cover"]})
            if generos and not hit["genre"]:
                generos_out.append({"caseId": f"rym-nuevos:{R.slug_release(rel)}", "kind": "album", "entityId": hit["id"],
                                    "source": "rateyourmusic", "url": BASE + rel, "title": hit["title"],
                                    "rawGenres": generos})
        else:
            item.update(estado="alta")
            cont["alta"] += 1
            casos.append({"tipo": "album", "origen": "nuevos", "rym_href": rel, "parent_href": fila[0],
                          "artist_id": aid, "album_type": MAPA_TIPO.get(tipo) or "other",
                          "motivo": f"Discografía RYM de «{artistas[aid]}» ({tipo or 'sin tipo'}), decisión «completar + altas» de Brian 2026-10-05"})
        plan.append(item)

    def escribir(nombre, filas_):
        with open(os.path.join(OUT, nombre), "w", encoding="utf-8") as fh:
            for f in filas_:
                fh.write(json.dumps(f, ensure_ascii=False) + "\n")

    escribir("plan-discos.jsonl", plan)
    escribir("completar-pistas.jsonl", pistas_out)
    escribir("completar-anios.jsonl", anios_out)
    escribir("completar-portadas.jsonl", portadas_out)
    escribir("completar-generos.jsonl", generos_out)
    json.dump({"nota": "Altas de discos RYM «nuevos» (decisión de Brian 2026-10-05: completar + altas)", "casos": casos},
              open(os.path.join(OUT, "solicitud-altas-discos.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    altas = [p for p in plan if p["estado"] == "alta"]
    resumen = {
        "generado": time.strftime("%Y-%m-%d %H:%M:%S"),
        "discos_capturados_unicos": len(filas),
        "aplicables": len(plan), **dict(cont),
        "fuera": dict(motivos),
        "completar_existentes": {
            "pistas (discos sin pistas)": len(pistas_out),
            "pistas totales": sum(len(p["tracks"]) for p in pistas_out),
            "años (discos sin año)": len(anios_out),
            "portadas: ficha vacía → se fija": sum(1 for p in portadas_out if not p["ficha_con_portada"]),
            "portadas: ficha con imagen → candidata": sum(1 for p in portadas_out if p["ficha_con_portada"]),
            "géneros (discos sin principal)": len(generos_out),
        },
        "altas": {
            "discos": len(altas),
            "por_tipo": dict(collections.Counter(p["tipo_rym"] or "?" for p in altas).most_common()),
            "con_pistas": sum(1 for p in altas if p["n_pistas"]),
            "con_portada": sum(1 for p in altas if p["portada"]),
            "con_géneros": sum(1 for p in altas if p["generos"]),
            "con_año": sum(1 for p in altas if p["anio"]),
            "colaboraciones": sum(1 for p in altas if p["colab"]),
        },
        "dueño_resuelto_por": dict(collections.Counter(p["via"] for p in plan)),
    }
    json.dump(resumen, open(os.path.join(OUT, "resumen-plan.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(resumen, ensure_ascii=False, indent=1))
    print(f"\nescrito en {os.path.relpath(OUT, ROOT)}/ ({time.time() - t0:.1f}s)")


if __name__ == "__main__":
    main()
