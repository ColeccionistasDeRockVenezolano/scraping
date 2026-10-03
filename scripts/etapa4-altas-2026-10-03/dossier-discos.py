#!/usr/bin/env python3
"""Etapa 4 «Altas» — Cruce de discos (dossier revisable).

SOLO LECTURA. Dos secciones:
  A) Los 547 discos fuera de catálogo de la campaña de los 222
     (`reports/rym-discos-fuera-2026-10-01.jsonl`, evidencia en
     `data/raw/fuentes-web-2026-10-01/rym-etapa3/pages/`), re-verificados
     contra el catálogo VIVO (pueden haber entrado desde el 01-10).
  B) Los discos de los 1.591 «nuevos» (filas de sus páginas de artista en
     `…/rym-nuevos/pages/`), con estado de captura de la fase 2 (se completa
     al terminar la extracción — re-ejecutar este script entonces).

Cada fila cita sus fuentes (ledger/página/BD). `decision` va vacía (la llena
Brian al revisar). El motor de altas consumirá `dossier-discos.jsonl`.

Salidas (reports/etapa4-altas-2026-10-03/):
  dossier-discos.tsv | dossier-discos.jsonl | dossier-discos-resumen.json

Uso: python3 scripts/etapa4-altas-2026-10-03/dossier-discos.py
"""
import json
import os
import re
import subprocess
import time
import unicodedata

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
ET3 = f"{ROOT}/data/raw/fuentes-web-2026-10-01/rym-etapa3"
NUEVOS = f"{ROOT}/data/raw/fuentes-web-2026-10-01/rym-nuevos"
OUTDIR = f"{ROOT}/reports/etapa4-altas-2026-10-03"
os.makedirs(OUTDIR, exist_ok=True)

MAPA_TIPO = {"Album": "studio_album", "Single": "single", "EP": "ep", "Compilation": "compilation",
             "V/A Compilation": "compilation", "Live Album": "live_album", "Demo": "demo",
             "Soundtrack": "soundtrack", "Remix": "remix", "Mixtape": "other", "DJ Mix": "other",
             "Additional release": "other", "Video": "na", "Music video": "na", "Appears On": "na"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s)).strip()


def nopunct(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def norm_href(h):
    from urllib.parse import unquote
    if not h:
        return ""
    h = unquote(h)
    if h.startswith("https://rateyourmusic.com"):
        h = h[len("https://rateyourmusic.com"):]
    return h.split("?")[0].split("#")[0].rstrip("/")


def slugify(href):
    s = norm_href(href).replace("/artist/", "").replace("/", "_")
    s = re.sub(r"[^A-Za-z0-9_\-\.]", "", s)
    return s[:90] or "sin-slug"


def slug_rel(href):
    return "rel_" + slugify(norm_href(href).replace("/release/", ""))


def tsv(v):
    return re.sub(r"[\t\r\n]+", " ", str(v if v is not None else ""))


def sql(q):
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv",
                        "-At", "-F", "\t", "-c", q], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("psql: " + r.stderr)
    return [l.split("\t") for l in r.stdout.strip().split("\n") if l.strip()]


def anio_pagina(info):
    """Año desde la ficha de disco (info): solo 1950-2026; si no, None."""
    m = re.search(r"[Rr]eleased[^\d]{0,20}(\d{4})", info or "")
    if m:
        y = int(m.group(1))
        return y if 1950 <= y <= 2026 else None
    m = re.search(r"\b(19[5-9]\d|20[0-2]\d)\b", info or "")
    return int(m.group(1)) if m else None


def main():
    t0 = time.time()
    # ---- catálogo vivo
    live_artists = {}
    for r in sql("SELECT id, name, created_at::date FROM public.artists"):
        live_artists[int(r[0])] = {"name": r[1], "created": r[2]}
    live_a_norm, live_a_comp = {}, {}
    for i, a in live_artists.items():
        live_a_norm.setdefault(norm(a["name"]), i)
        live_a_comp.setdefault(nopunct(a["name"]), i)
    for r in sql("SELECT artist_id, alias FROM ingest.artist_aliases"):
        live_a_norm.setdefault(norm(r[1]), int(r[0]))
        live_a_comp.setdefault(nopunct(r[1]), int(r[0]))
    redirects = {int(r[0]): int(r[1]) for r in sql("SELECT from_id, to_id FROM ingest.entity_redirects WHERE entity_kind='artist'")}
    albums = {}       # artist_id -> [(album_id, title_compact, title, created)]
    alb_global = {}   # title_compact -> (album_id, artist_id, title, created)
    for r in sql("SELECT id, artist_id, title, created_at::date FROM public.albums"):
        c = nopunct(r[2])
        albums.setdefault(int(r[1]), []).append((int(r[0]), c, r[2], r[3]))
        if c:
            alb_global.setdefault(c, (int(r[0]), int(r[1]), r[2], r[3]))

    def match_album(artist_id, titulo):
        k = nopunct(titulo)
        for aid, c, t, cr in albums.get(artist_id, []):
            if k and (k == c or (len(c) >= 6 and (k.startswith(c) or c.startswith(k)))):
                return aid, t, cr
        return None

    def colision(titulo, artist_id):
        k = nopunct(titulo)
        if k and k in alb_global:
            aid, arid, t, cr = alb_global[k]
            if arid != artist_id:
                return f"«{t}» → álbum {aid} de «{live_artists.get(arid, {}).get('name', arid)}»"
        return ""

    def evidencia_disco(pages_dir, href):
        f = os.path.join(pages_dir, slug_rel(href) + ".json")
        if not os.path.exists(f):
            return {"path": "", "tracks": "", "genres": "", "cover": "", "credits": "", "anio_pag": ""}
        try:
            rec = json.load(open(f, encoding="utf-8"))["rec"]
        except Exception:
            return {"path": f, "tracks": "?", "genres": "?", "cover": "?", "credits": "?", "anio_pag": ""}
        return {"path": os.path.relpath(f, ROOT), "tracks": len(rec.get("tracks") or []),
                "genres": len(rec.get("genres") or []), "cover": "si" if rec.get("og") else "no",
                "credits": len(rec.get("creditLinks") or []), "anio_pag": anio_pagina(rec.get("info"))}

    filas = []
    stats = {"A": {}, "B": {}}

    # ---- Sección A: ledger de los 222
    ledger = [json.loads(l) for l in open(f"{ROOT}/reports/rym-discos-fuera-2026-10-01.jsonl", encoding="utf-8") if l.strip()]
    cola222 = [json.loads(l) for l in open(f"{ET3}/cola.jsonl", encoding="utf-8") if l.strip()]
    # filas de las páginas de artista de los 222 (para tipo/año del disco)
    rows222 = {}
    for row in cola222:
        f = os.path.join(ET3, "pages", slugify(row["rymHref"]) + ".json")
        if not os.path.exists(f):
            continue
        try:
            rec = json.load(open(f, encoding="utf-8"))["rec"]
        except Exception:
            continue
        for r in rec.get("rows") or []:
            h = norm_href(r.get("h"))
            if h:
                rows222[h] = r

    for led in ledger:
        aid0 = int(led["artistId"])
        aid = redirects.get(aid0, aid0)
        fusion = f"{aid0}→{aid}" if aid != aid0 else ""
        dest = live_artists.get(aid, {}).get("name", led["artist"])
        art = f"{led['artist']} → {dest}" if fusion else dest
        href = norm_href(led["rymHref"])
        row = rows222.get(href) or {}
        ev = evidencia_disco(f"{ET3}/pages", href)
        anio_row = None
        if row.get("y"):
            m = re.match(r"(\d{4})", str(row["y"]).strip())
            if m:
                anio_row = int(m.group(1))
        anio_led = led.get("year") if isinstance(led.get("year"), int) and 1950 <= (led.get("year") or 0) <= 2026 else None
        anio = anio_row or anio_led or ev["anio_pag"] or ""
        nota = []
        if anio_row and led.get("year") and led.get("year") != anio_row:
            nota.append(f"ledger {led['year']} vs fila {anio_row}")
        if not anio_row and led.get("year") and not anio_led:
            nota.append(f"ledger {led['year']} fuera de rango")
        tipo = row.get("ty") or ""
        hit = match_album(aid, row.get("t") or led["rymTitle"])
        estado = "ya_en_catalogo" if hit else "fuera"
        stats["A"][estado] = stats["A"].get(estado, 0) + 1
        stats["A"]["capturado" if ev["path"] else "sin_captura"] = stats["A"].get("capturado" if ev["path"] else "sin_captura", 0) + 1
        filas.append({
            "seccion": "222", "artista": art, "artista_ref": f"id {aid}" + (f" (fusionado {fusion})" if fusion else ""),
            "disco": row.get("t") or led["rymTitle"], "rym_href": href,
            "tipo_rym": tipo, "album_type_sug": MAPA_TIPO.get(tipo, ""),
            "anio": anio, "anio_nota": "; ".join(nota),
            "evidencia": ev["path"], "ev_tracks": ev["tracks"], "ev_genres": ev["genres"],
            "ev_cover": ev["cover"], "ev_credits": ev["credits"],
            "estado": estado, "ya_album": f"{hit[0]} «{hit[1]}» (creado {hit[2]})" if hit else "",
            "colision_titulo": colision(row.get("t") or led["rymTitle"], aid),
            "fuente": f"ledger rym-discos-fuera-2026-10-01.jsonl; {ev['path'] or 'sin ficha de disco'}; BD viva albums/{aid}",
            "decision": "", "nota_revisor": "",
        })

    # ---- Sección B: discos de los «nuevos»
    cola = [json.loads(l) for l in open(f"{NUEVOS}/cola-nuevos.jsonl", encoding="utf-8") if l.strip()]
    estado = json.load(open(f"{NUEVOS}/estado.json", encoding="utf-8"))
    total_listados = 0
    for row in cola:
        href_a = norm_href(row["rymHref"])
        f = os.path.join(NUEVOS, "pages", slugify(href_a) + ".json")
        if not os.path.exists(f):
            continue
        try:
            rec = json.load(open(f, encoding="utf-8"))["rec"]
        except Exception:
            continue
        live_id = live_a_comp.get(nopunct(row["name"])) or live_a_norm.get(norm(row["name"]))
        live_id = redirects.get(live_id, live_id) if live_id else None
        vistos = set()
        for r in rec.get("rows") or []:
            h = norm_href(r.get("h"))
            if not h or h in vistos:
                continue
            vistos.add(h)
            total_listados += 1
            tipo = (r.get("ty") or "").strip()
            proprio = tipo not in ("Appears On", "V/A Compilation", "Music video", "Video")
            ev = evidencia_disco(f"{NUEVOS}/pages", h)
            anio = ""
            if r.get("y"):
                m = re.match(r"(\d{4})", str(r["y"]).strip())
                if m:
                    anio = int(m.group(1))
            if not anio and ev["anio_pag"]:
                anio = ev["anio_pag"]
            hit = match_album(live_id, r.get("t")) if live_id else None
            estado_d = "ya_en_catalogo" if hit else ("fuera" if live_id else "artista_fuera")
            stats["B"][estado_d] = stats["B"].get(estado_d, 0) + 1
            if ev["path"]:
                stats["B"]["capturado"] = stats["B"].get("capturado", 0) + 1
            filas.append({
                "seccion": "nuevos", "artista": row["name"],
                "artista_ref": (f"id {live_id} (vivo)" if live_id else href_a),
                "disco": (r.get("t") or "").strip(), "rym_href": h,
                "tipo_rym": tipo, "album_type_sug": MAPA_TIPO.get(tipo, ""),
                "anio": anio, "anio_nota": ("" if proprio else "no propio"),
                "evidencia": ev["path"], "ev_tracks": ev["tracks"], "ev_genres": ev["genres"],
                "ev_cover": ev["cover"], "ev_credits": ev["credits"],
                "estado": estado_d, "ya_album": f"{hit[0]} «{hit[1]}» (creado {hit[2]})" if hit else "",
                "colision_titulo": colision(r.get("t"), live_id),
                "fuente": f"pages/{slugify(href_a)}.json (fila discografía); {ev['path'] or 'ficha de disco sin capturar'}; BD viva",
                "decision": "", "nota_revisor": "",
            })

    # ---- salidas
    orden = {"222": 0, "nuevos": 1}
    filas.sort(key=lambda f: (orden[f["seccion"]], 0 if f["estado"] == "ya_en_catalogo" else 1, f["artista"].lower()))
    cols = list(filas[0].keys())
    with open(f"{OUTDIR}/dossier-discos.tsv", "w", encoding="utf-8") as fh:
        fh.write("\t".join(cols) + "\n")
        for f in filas:
            fh.write("\t".join(tsv(f[c]) for c in cols) + "\n")
    with open(f"{OUTDIR}/dossier-discos.jsonl", "w", encoding="utf-8") as fh:
        for f in filas:
            fh.write(json.dumps(f, ensure_ascii=False) + "\n")

    resumen = {"generado": time.strftime("%Y-%m-%d %H:%M:%S"),
               "seccion_222": {"filas": sum(1 for f in filas if f["seccion"] == "222"), **stats["A"]},
               "seccion_nuevos": {"filas": sum(1 for f in filas if f["seccion"] == "nuevos"),
                                  "listados_fase2": total_listados, **stats["B"]},
               "nota": "seccion_nuevos se completa al terminar la fase 2 (re-ejecutar este script)"}
    json.dump(resumen, open(f"{OUTDIR}/dossier-discos-resumen.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(json.dumps(resumen, ensure_ascii=False, indent=1))
    print(f"\nescrito: {OUTDIR}/dossier-discos.{{tsv,jsonl,resumen.json}}  ({time.time()-t0:.1f}s)")


if __name__ == "__main__":
    main()
