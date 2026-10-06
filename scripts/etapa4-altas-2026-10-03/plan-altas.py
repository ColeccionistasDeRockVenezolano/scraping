#!/usr/bin/env python3
"""Etapa 4 «Altas» — genera el plan de altas (entrada del motor) desde una solicitud.

SOLO LECTURA del catálogo/archivos. La solicitud es un JSON:
{
  "nota": "...",
  "casos": [
    {"tipo": "artist", "rym_href": "/artist/serenada", "motivo": "..."},
    {"tipo": "person", "rym_href": "/artist/marianne-mali", "motivo": "..."},
    {"tipo": "album", "origen": "ledger", "rym_href": "/release/album/la-puta-electrica/automatron", "artist_id": 138, "motivo": "..."},
    {"tipo": "album", "origen": "nuevos", "rym_href": "/release/...", "parent_href": "/artist/los-imperials", "motivo": "..."}
  ]
}

Cada caso se arma con los datos del dossier (reports/etapa4-altas-2026-10-03/) + la captura
(pages/*.json + meta del .html) y sale a plan-altas.jsonl listo para `altas-motor.mts`.

Uso: python3 scripts/etapa4-altas-2026-10-03/plan-altas.py <solicitud.json> [salida.jsonl]
"""
import json
import os
import re
import sys

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
OUTDIR = f"{ROOT}/reports/etapa4-altas-2026-10-03"
RYM_NUEVOS = f"{ROOT}/data/raw/fuentes-web-2026-10-01/rym-nuevos"
RYM_ET3 = f"{ROOT}/data/raw/fuentes-web-2026-10-01/rym-etapa3"

MAPA_TIPO = {"Album": "studio_album", "Single": "single", "EP": "ep", "Compilation": "compilation",
             "V/A Compilation": "compilation", "Live Album": "live_album", "Demo": "demo",
             "Remix": "remix", "Mixtape": "other", "DJ Mix": "other", "Additional release": "other",
             "Bootleg / Unauthorized": "other", "Video": None, "Music video": None, "Appears On": None}


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


def limpiar(v):
    s = re.sub(r"\s+", " ", str(v or "")).strip()
    if "\ufffd" in s:
        raise ValueError(f"contiene U+FFFD: {s!r}")
    return s


def cargar(path):
    return [json.loads(l) for l in open(path, encoding="utf-8") if l.strip()]


def main():
    if len(sys.argv) < 2:
        raise SystemExit("uso: plan-altas.py <solicitud.json> [salida.jsonl]")
    sol_path = sys.argv[1]
    sol = json.load(open(sol_path, encoding="utf-8"))
    salida = sys.argv[2] if len(sys.argv) > 2 else f"{OUTDIR}/plan-altas.jsonl"

    dossier = {r["rym_href"]: r for r in cargar(f"{OUTDIR}/dossier-nuevos.jsonl")}
    discos = {}
    for r in cargar(f"{OUTDIR}/dossier-discos.jsonl"):
        discos[(r["seccion"], r["rym_href"])] = r

    plan, errores = [], []

    def meta_de(href, dir_pages):
        f = os.path.join(dir_pages, f"{slugify(href)}.json")
        meta, snap = "", ""
        if os.path.exists(f):
            snap = os.path.relpath(f, ROOT)
            html = f[:-5] + ".html"
            if os.path.exists(html):
                try:
                    head = open(html, encoding="utf-8", errors="replace").read(6000)
                    m = re.search(r'<meta name="description" content="([^"]*)"', head)
                    if m:
                        meta = m.group(1)
                except Exception:
                    pass
        return meta, snap

    for caso in sol["casos"]:
        tipo = caso["tipo"]
        href = norm_href(caso["rym_href"])
        try:
            if tipo in ("artist", "person"):
                d = dossier.get(href)
                if not d:
                    raise ValueError("no está en dossier-nuevos.jsonl")
                nombre = limpiar(d["rym_name"])
                meta, snap = meta_de(href, f"{RYM_NUEVOS}/pages")
                if not snap:
                    raise ValueError("sin página capturada")
                meta = limpiar(meta) or limpiar(d["detalle_etapa2"])
                if tipo == "artist":
                    values = {"name": nombre, "artist_type": caso.get("artist_type") or "band"}
                    f = d.get("ev_formed")
                    if isinstance(f, int) and 1900 <= f <= 2026:
                        values["formed_year"] = f
                    excerpt = (meta or f"Ficha RYM de «{nombre}»")[:280]
                else:
                    values = {"name": nombre}
                    excerpt = (meta or f"Ficha RYM de «{nombre}»")[:280]
                    if d.get("miembro_de"):
                        excerpt = f"{excerpt} — {d['miembro_de']}"[:280]
                plan.append({"tipo": tipo, "clave": f"rym-nuevos:{tipo}:{slugify(href)}",
                             "rym_href": href, "url": f"https://rateyourmusic.com{href}",
                             "nombre": nombre, "values": values,
                             "evidencia": {"url": f"https://rateyourmusic.com{href}", "excerpt": excerpt,
                                           "snapshot": snap, "captura": d.get("ev_captured", "")},
                             "origen": f"dossier-nuevos#{d['accion_sugerida']}", "motivo": caso.get("motivo", "")})
            elif tipo == "album":
                origen = caso.get("origen", "")
                sec = "222" if origen == "ledger" else "nuevos"
                d = discos.get((sec, href))
                if not d:
                    raise ValueError(f"no está en dossier-discos.jsonl ({sec})")
                titulo = limpiar(d["disco"])
                values = {"title": titulo}
                anio = d.get("anio")
                if isinstance(anio, int) and 1950 <= anio <= 2026:
                    values["release_year"] = anio
                tipo_rym = d.get("tipo_rym") or ""
                # El tipo que manda es el de la fila del dueño (caso["album_type"]); la del dossier
                # puede venir de otro padre donde el disco es «Appears On» («na» no es un album_type).
                at = caso.get("album_type") or MAPA_TIPO.get(tipo_rym) or d.get("album_type_sug") or None
                if at and at != "na":
                    values["album_type"] = at
                parent = {}
                if origen == "ledger":
                    aid = caso.get("artist_id")
                    if not aid:
                        m = re.match(r"id (\d+)", str(d.get("artista_ref") or ""))
                        aid = int(m.group(1)) if m else None
                    if not aid:
                        raise ValueError("sin artist_id para el ledger")
                    parent = {"artist_id": int(aid)}
                else:
                    ph = norm_href(caso.get("parent_href") or "")
                    if not ph:
                        raise ValueError("album de «nuevos» exige parent_href")
                    en_plan = any(c.get("tipo") == "artist" and norm_href(c.get("rym_href")) == ph for c in sol["casos"])
                    dn = dossier.get(ph)
                    if caso.get("artist_id"):
                        parent = {"artist_id": int(caso["artist_id"])}
                    elif en_plan:
                        parent = {"rym_href": ph, "name": d["artista"]}
                    elif dn and dn.get("cat_artist_id"):
                        parent = {"artist_id": int(dn["cat_artist_id"])}
                    elif dn:
                        parent = {"rym_href": ph, "name": d["artista"]}
                    else:
                        raise ValueError(f"padre {ph} ni en el plan ni en el dossier")
                snap = limpiar(d.get("evidencia"))
                excerpt = (f"Discografía RYM de «{d['artista']}» (ficha capturada): «{titulo}»"
                           f"{' (' + str(anio) + ')' if anio else ''}{', ' + tipo_rym if tipo_rym else ''}")
                if snap:
                    excerpt += f"; ficha de disco con {d['ev_tracks']} pistas"
                plan.append({"tipo": "album", "clave": f"rym:{sec}:album:{slugify(href)}",
                             "rym_href": href, "url": f"https://rateyourmusic.com{href}",
                             "nombre": titulo, "values": values,
                             "evidencia": {"url": f"https://rateyourmusic.com{href}", "excerpt": excerpt[:300],
                                           "snapshot": snap, "captura": ""},
                             "parent": parent,
                             "origen": f"dossier-discos#{sec}", "motivo": caso.get("motivo", "")})
            else:
                raise ValueError(f"tipo desconocido: {tipo}")
        except Exception as exc:
            errores.append({"caso": caso, "error": str(exc)})

    with open(salida, "w", encoding="utf-8") as fh:
        for p in plan:
            fh.write(json.dumps(p, ensure_ascii=False) + "\n")

    print(f"solicitud: {len(sol['casos'])} casos → plan: {len(plan)} ítems, errores: {len(errores)}")
    for e in errores:
        print("  ERROR:", e["caso"].get("rym_href", "?"), "-", e["error"])
    import collections
    print("por tipo:", dict(collections.Counter(p["tipo"] for p in plan)))
    print("escrito:", salida)


if __name__ == "__main__":
    main()
