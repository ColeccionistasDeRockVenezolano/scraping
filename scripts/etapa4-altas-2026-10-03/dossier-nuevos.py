#!/usr/bin/env python3
"""Etapa 4 «Altas» — Dossier de revisión de los 1.591 artistas «nuevos» de RYM.

SOLO LECTURA. Cruza los candidatos de la fase «nuevos» contra el catálogo VIVO
(public.artists/persons + aliases + redirects) y suma la evidencia capturada en
data/raw/fuentes-web-2026-10-01/rym-nuevos/ (páginas de artista + estado.json).

Cada fila cita sus fuentes (cruce en BD + archivo de evidencia). Nada inventado:
los campos de evidencia salen del rec capturado o del meta del HTML; las señales,
del snippet de la cosecha asistida (archivo). La columna `decision` sale vacía:
la llena Brian al revisar; el motor de altas solo leerá filas aprobadas.

Salidas (reports/etapa4-altas-2026-10-03/):
  dossier-nuevos.tsv            — tabla revisable (TSV, una fila por candidato)
  dossier-nuevos.jsonl          — misma data en JSON (consumo del motor)
  dossier-nuevos-resumen.json   — conteos por acción/clase + muestras

Uso: python3 scripts/etapa4-altas-2026-10-03/dossier-nuevos.py
"""
import csv
import difflib
import json
import os
import re
import subprocess
import time
import unicodedata
from urllib.parse import unquote

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
RYM = f"{ROOT}/data/raw/fuentes-web-2026-10-01/rym-nuevos"
CONS = f"{ROOT}/data/raw/fuentes-web-2026-10-01/consolidado/rym-final"
OUTDIR = f"{ROOT}/reports/etapa4-altas-2026-10-03"
os.makedirs(OUTDIR, exist_ok=True)

# ---------------------------------------------------------------- utilidades

def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s)).strip()

def nopunct(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", s)

def norm_href(h):
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

def tsv(v):
    return re.sub(r"[\t\r\n]+", " ", str(v if v is not None else ""))

def sql(q):
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv",
                        "-At", "-F", "\t", "-c", q], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("psql: " + r.stderr)
    return [l.split("\t") for l in r.stdout.strip().split("\n") if l.strip()]

# ---------------------------------------------------------------- catálogo vivo

def cargar_catalogo():
    cat = {"artist": {}, "person": {}}
    names = {"artist": {}, "person": {}}
    comp = {"artist": {}, "person": {}}
    creados = {"artist": {}, "person": {}}
    for kind, table in (("artist", "public.artists"), ("person", "public.persons")):
        for r in sql(f"SELECT id, name, created_at::date FROM {table}"):
            i = int(r[0]); n = r[1]
            cat[kind][i] = n
            creados[kind][i] = r[2]
            names[kind].setdefault(norm(n), (i, n))
            comp[kind].setdefault(nopunct(n), (i, n))
    aliases = {"artist": {}, "person": {}}
    for kind, table in (("artist", "ingest.artist_aliases"), ("person", "ingest.person_aliases")):
        for r in sql(f"SELECT {kind}_id, alias FROM {table}"):
            i = int(r[0]); a = r[1]
            aliases[kind].setdefault(norm(a), (i, a))
            aliases[kind].setdefault(nopunct(a), (i, a))
    redirects = {}
    for r in sql("SELECT entity_kind, from_id, to_id FROM ingest.entity_redirects"):
        redirects.setdefault(r[0], {})[int(r[1])] = int(r[2])
    albums = {}
    for r in sql("SELECT id, artist_id, title FROM public.albums"):
        k = nopunct(r[2])
        if k:
            albums.setdefault(k, (int(r[0]), int(r[1]), r[2]))
    return cat, names, comp, aliases, redirects, albums, creados

# ---------------------------------------------------------------- carga de candidatos

def cargar_recs():
    """Devuelve {href_norm: {"rec":…, "meta":…, "capturedAt":…}} desde pages/*.json + meta del HTML."""
    recs = {}
    for f in os.listdir(f"{RYM}/pages"):
        if not f.endswith(".json"):
            continue
        try:
            d = json.load(open(f"{RYM}/pages/{f}", encoding="utf-8"))
        except Exception:
            continue
        if d.get("rec", {}).get("kind") != "artist":
            continue
        href = norm_href(d.get("href"))
        rec = d["rec"]
        meta = ""
        html = f"{RYM}/pages/{f[:-5]}.html"
        if os.path.exists(html):
            try:
                head = open(html, encoding="utf-8", errors="replace").read(6000)
                m = re.search(r'<meta name="description" content="([^"]*)"', head)
                if m:
                    meta = m.group(1)
            except Exception:
                pass
        recs[href] = {"rec": rec, "meta": meta, "capturedAt": d.get("capturedAt") or ""}
    return recs

# ---------------------------------------------------------------- señales

INSTR = re.compile(
    r"guitar|bass|drum|vocal|singer|teclad|keyboard|bater|bajo|cantante|viol|piano|tromp|"
    r"saxo|percusi|coros|producer|productor|flauta|flute|congas|chelo|cello", re.I)

def extraer_miembro_de(m):
    if not m:
        return []
    mo = re.search(r"Member of\s*(.+?)(?:Currently|Born|Died|$)", m)
    if not mo:
        return []
    return [b.strip() for b in re.split(r",(?![^(]*\))", mo.group(1)) if b.strip()][:6]

def señales(row, recs, comp_artist, aliases, comp_person, nuevos_keys):
    href = norm_href(row["rymHref"])
    cap = recs.get(href)
    rec = cap["rec"] if cap else {}
    meta = cap["meta"] if cap else ""
    m = row.get("m") or row.get("detalle") or ""

    formed_meta = None
    fm = re.search(r"formed\s+(\d{4})", meta, re.I)
    if fm:
        formed_meta = int(fm.group(1))
    born_meta = bool(re.search(r"\bborn\b", meta, re.I)) and not formed_meta
    members_meta = bool(re.search(r"\bmembers\b", meta, re.I))

    member_of = extraer_miembro_de(m)
    ms = re.search(r"Members\s*(.+)$", m)
    members_instr = bool(ms and INSTR.search(ms.group(1)))

    rows = []
    vistos = set()
    for r in rec.get("rows") or []:
        h = norm_href(r.get("h"))
        if not h or h in vistos:
            continue
        vistos.add(h)
        rows.append({"h": h, "t": (r.get("t") or "").strip(), "y": r.get("y"), "ty": r.get("ty")})

    tipos = {}
    for r in rows:
        ty = (r["ty"] or "na").strip()[:24]
        tipos[ty] = tipos.get(ty, 0) + 1

    # banda vs persona: meta de la página manda (formed/born), luego snippet
    if formed_meta or members_instr:
        tipo_señal = "banda"
    elif member_of:
        tipo_señal = "persona_miembro"
    elif born_meta:
        tipo_señal = "persona_o_solista"
    elif re.search(r"\bBorn\d", m) or re.search(r"\bBorn\s", m):
        tipo_señal = "persona_o_solista"
    else:
        tipo_señal = "indeterminado"

    # miembro_de etiquetado
    etiquetas = []
    for b in member_of:
        b_n = norm(b)
        if b_n in comp_artist or b_n in aliases["artist"]:
            etiquetas.append(f"{b} [cat]")
        elif b_n in nuevos_keys:
            etiquetas.append(f"{b} [nuevo]")
        else:
            etiquetas.append(f"{b} [fuera]")

    foto = "sin_imagen"
    if rec.get("photo") and not rec.get("photoEsCover"):
        foto = "retrato"
    elif rec.get("photo") and rec.get("photoEsCover"):
        foto = "portada_rym"
    elif rec.get("og"):
        foto = "og"

    discos_propios = [r for r in rows if (r["ty"] or "") not in ("Appears On", "V/A Compilation", "Music video")]

    return {
        "rec": rec, "meta": meta, "capturedAt": cap["capturedAt"] if cap else "",
        "formed_meta": formed_meta, "born_meta": born_meta, "members_meta": members_meta,
        "member_of": member_of, "miembro_de": etiquetas, "members_instr": members_instr,
        "rows": rows, "tipos": tipos, "discos_propios": discos_propios,
        "tipo_señal": tipo_señal, "foto": foto,
        "n_gen": len(rec.get("genres") or []), "genres": (rec.get("genres") or [])[:6],
        "og": bool(rec.get("og")), "stub": bool(rec.get("sinDiscografia")),
        "ev_formed": rec.get("formed"),
    }

# ---------------------------------------------------------------- main

def main():
    t0 = time.time()
    cola = [json.loads(l) for l in open(f"{RYM}/cola-nuevos.jsonl", encoding="utf-8") if l.strip()]
    clasif = {norm_href(r["rym_href"]): r for r in csv.DictReader(open(f"{CONS}/candidatos-clasificados.csv", encoding="utf-8"))}
    print(f"cola: {len(cola)} | clasificados CSV: {len(clasif)}")

    cat, names, comp, aliases, redirects, albums, creados = cargar_catalogo()
    print(f"catálogo vivo: {len(cat['artist'])} artistas, {len(cat['person'])} personas, "
          f"aliases {len(aliases['artist'])}+{len(aliases['person'])}, redirects {sum(len(v) for v in redirects.values())}, álbumes {len(albums)}")

    recs = cargar_recs()
    print(f"páginas de artista capturadas: {len(recs)}")

    nuevos_keys = {norm(r["name"]): r["rymHref"] for r in cola}

    # índices para fuzzy
    def construir_indice(names_map):
        idx = {}
        for k in names_map:
            for tok in k.split():
                if len(tok) >= 3:
                    idx.setdefault(tok, []).append(k)
        return idx
    idx_artist = construir_indice(names)
    idx_person = construir_indice(names)

    def fuzzy(n, names_map, idx, tipo):
        """near-match contra nombres primarios (mismo criterio etapa2: sim>=0.86)."""
        if len(n) < 4:
            return None
        cands = set()
        toks = [t for t in n.split() if len(t) >= 3]
        for t in toks:
            cands.update(idx.get(t, []))
        if not cands:
            cands = {k for k in names_map if k[:1] == n[:1]}
        best, best_r = None, 0.0
        for k in cands:
            if abs(len(k) - len(n)) > 3:
                continue
            r = difflib.SequenceMatcher(None, n, k).ratio()
            if r > best_r:
                best, best_r = k, r
        if best and best_r >= 0.86:
            i, nm = names_map[best] if tipo == "artist" else names_map[best]
            return {"id": i, "name": nm, "sim": round(best_r, 3),
                    "kind": "artista" if tipo == "artist" else "persona"}
        return None

    def cruzar(n, np_, kind):
        """exacto compacto → exacto norm → alias (norm/compacto) → fuzzy → redirects."""
        if np_ and np_ in comp[kind]:
            i, nm = comp[kind][np_]
            return {"id": i, "name": nm, "via": "compacto", "sim": 1.0, "alias": None}
        if n and n in names[kind]:
            i, nm = names[kind][n]
            return {"id": i, "name": nm, "via": "exacto", "sim": 1.0, "alias": None}
        if n and n in aliases[kind]:
            i, a = aliases[kind][n]
            nm = cat[kind].get(i, a)
            return {"id": i, "name": nm, "via": "alias", "sim": 1.0, "alias": a}
        if np_ and np_ in aliases[kind]:
            i, a = aliases[kind][np_]
            nm = cat[kind].get(i, a)
            return {"id": i, "name": nm, "via": "alias", "sim": 1.0, "alias": a}
        f = fuzzy(n, names[kind], idx_artist if kind == "artist" else idx_person, kind)
        if f:
            return {"id": f["id"], "name": f["name"], "via": "near", "sim": f["sim"], "alias": None}
        return None

    filas = []
    stats = {}
    for row in cola:
        nombre = row["name"]
        href = norm_href(row["rymHref"])
        nlocs = int(row.get("nlocs") or 0)
        c = clasif.get(href, {})
        clase = (c.get("clase") or "").strip()
        n = norm(nombre)
        np_ = nopunct(nombre)

        s = señales({**row, "m": c.get("m") or c.get("detalle") or ""}, recs, comp["artist"], aliases, comp["person"], nuevos_keys)

        ca = cruzar(n, np_, "artist")
        cp = cruzar(n, np_, "person")
        # redirects: si el id cruzado fue fusionado, seguir destino
        for obj, kind in ((ca, "artist"), (cp, "person")):
            if obj and obj["id"] in redirects.get(kind, {}):
                to = redirects[kind][obj["id"]]
                obj["via"] += f"+fusionado→{to}"
                obj["id"] = to
                obj["name"] = cat[kind].get(to, obj["name"])
            if obj:
                obj["created"] = creados[kind].get(obj["id"], "")

        # discos que coinciden (por título) con álbumes del catálogo
        ejemplos = []
        for r in s["discos_propios"]:
            k = nopunct(r["t"])
            if k and k in albums:
                aid, arid, atitle = albums[k]
                aname = cat["artist"].get(arid, f"artista {arid}")
                ejemplos.append(f"«{r['t']}» → álbum {aid} de «{aname}»")

        # ---- acción sugerida
        via_ca = ca["via"].split("+")[0] if ca else ""
        via_cp = cp["via"].split("+")[0] if cp else ""
        if via_ca and via_ca != "near" and via_cp and via_cp != "near":
            accion = "ya_ambos"
        elif via_ca and via_ca != "near":
            accion = "ya_artista" if via_ca in ("exacto", "compacto") else "ya_artista_alias"
        elif via_cp and via_cp != "near":
            accion = "ya_persona" if via_cp in ("exacto", "compacto") else "ya_persona_alias"
        elif via_ca == "near" or via_cp == "near":
            accion = "revisar_homonimo"
        elif clase.startswith("C_miembro"):
            accion = "alta_persona_miembro"
        elif s["tipo_señal"] == "persona_miembro":
            accion = "alta_persona_miembro" if any("[cat]" in e or "[nuevo]" in e for e in s["miembro_de"]) else "revisar_persona"
        elif s["tipo_señal"] == "banda":
            accion = "alta_artista_banda"
        elif s["tipo_señal"] == "persona_o_solista":
            accion = "revisar_persona_solista" if (s["n_gen"] or s["discos_propios"]) else "revisar_persona"
        elif s["n_gen"] or s["discos_propios"]:
            accion = "revisar_tipo"
        else:
            accion = "cola_fria"

        # ---- sugerencia del revisor (texto con razones y fuentes)
        razones = []
        if ca:
            razones.append(f"artista {ca['via']}→#{ca['id']} «{ca['name']}»" + (f" (sim {ca['sim']}, creado {ca.get('created','')})" if ca["via"].split("+")[0] == "near" else f" (creado {ca.get('created','')})"))
        if cp:
            razones.append(f"persona {cp['via']}→#{cp['id']} «{cp['name']}»" + (f" (sim {cp['sim']}, creado {cp.get('created','')})" if cp["via"].split("+")[0] == "near" else f" (creado {cp.get('created','')})"))
        if s["formed_meta"]:
            razones.append(f"meta: formed {s['formed_meta']}")
        if s["born_meta"]:
            razones.append("meta: born (persona)")
        if s["member_of"]:
            razones.append("snippet: Member of " + "|".join(s["miembro_de"]))
        if s["members_instr"]:
            razones.append("snippet: Members con instrumentos")
        if s["ev_formed"] and s["ev_formed"] != s["formed_meta"]:
            razones.append(f"rec.formed {s['ev_formed']}")
        if s["n_gen"]:
            razones.append(f"{s['n_gen']} géneros: {', '.join(s['genres'][:3])}")
        if s["discos_propios"]:
            razones.append(f"{len(s['discos_propios'])} discos propios")
        if s["stub"]:
            razones.append("ficha RYM stub (sin discografía ni foto)")
        if ejemplos:
            razones.append("discos ya en catálogo: " + "; ".join(ejemplos[:2]))
        if not s["rec"]:
            razones.append("SIN página capturada")

        fuente_cruce = "BD:public." + ("artists" if accion.startswith("ya_artista") else "persons" if accion.startswith("ya_persona") else "artists+persons")
        if ca or cp:
            fuente_cruce += " (consulta viva 2026-10-03, aliases+redirects)"
        fuente_ev = f"pages/{slugify(href)}.json"
        if s["meta"]:
            fuente_ev += "+.html(meta)"

        filas.append({
            "rym_href": href,
            "rym_name": nombre,
            "nlocs": nlocs,
            "clase_etapa2": clase,
            "detalle_etapa2": (c.get("detalle") or "")[:120],
            "cat_artist_id": ca["id"] if ca else "",
            "cat_artist_name": ca["name"] if ca else "",
            "cat_artist_via": ca["via"] if ca else "",
            "cat_artist_sim": ca["sim"] if ca else "",
            "cat_artist_created": ca.get("created", "") if ca else "",
            "cat_person_id": cp["id"] if cp else "",
            "cat_person_name": cp["name"] if cp else "",
            "cat_person_via": cp["via"] if cp else "",
            "cat_person_sim": cp["sim"] if cp else "",
            "cat_person_created": cp.get("created", "") if cp else "",
            "tipo_señal": s["tipo_señal"],
            "miembro_de": "; ".join(s["miembro_de"]),
            "ev_formed": s["ev_formed"] or s["formed_meta"] or "",
            "ev_n_gen": s["n_gen"],
            "ev_genres": ", ".join(s["genres"]),
            "ev_n_discos": len(s["discos_propios"]),
            "ev_tipos": "; ".join(f"{k}:{v}" for k, v in sorted(s["tipos"].items(), key=lambda x: -x[1])),
            "ev_foto": s["foto"],
            "ev_musicalidad": "con" if (s["n_gen"] or s["discos_propios"] or s["members_instr"] or s["member_of"]) else "sin_evidencia",
            "ev_captured": s["capturedAt"],
            "discos_match_cat_n": len(ejemplos),
            "discos_match_cat_ej": "; ".join(ejemplos[:3]),
            "accion_sugerida": accion,
            "sugerencia_revisor": " | ".join(razones)[:600],
            "fuente_cruce": fuente_cruce,
            "fuente_evidencia": fuente_ev,
            "decision": "",
            "nota_revisor": "",
        })
        stats[accion] = stats.get(accion, 0) + 1

    orden = ["ya_ambos", "ya_artista", "ya_artista_alias", "ya_persona", "ya_persona_alias",
             "revisar_homonimo", "alta_persona_miembro", "alta_artista_banda",
             "revisar_persona_solista", "revisar_persona", "revisar_tipo", "cola_fria"]
    filas.sort(key=lambda f: (orden.index(f["accion_sugerida"]) if f["accion_sugerida"] in orden else 99, -f["nlocs"]))

    cols = list(filas[0].keys())
    with open(f"{OUTDIR}/dossier-nuevos.tsv", "w", encoding="utf-8") as fh:
        fh.write("\t".join(cols) + "\n")
        for f in filas:
            fh.write("\t".join(tsv(f[c]) for c in cols) + "\n")
    with open(f"{OUTDIR}/dossier-nuevos.jsonl", "w", encoding="utf-8") as fh:
        for f in filas:
            fh.write(json.dumps(f, ensure_ascii=False) + "\n")

    # cross-tab clase etapa2 × acción
    ct = {}
    for f in filas:
        k = (f["clase_etapa2"].split(":")[0].split("_miembro")[0] if f["clase_etapa2"].startswith("D_miembro") else f["clase_etapa2"]) or "(sin clase)"
        ct.setdefault(k, {})
        ct[k][f["accion_sugerida"]] = ct[k].get(f["accion_sugerida"], 0) + 1

    resumen = {"generado": time.strftime("%Y-%m-%d %H:%M:%S"), "total": len(filas),
               "por_accion": stats, "clase_x_accion": ct,
               "sin_pagina_capturada": sum(1 for f in filas if not f["ev_captured"])}
    frescura = {"artist": {}, "person": {}}
    for f in filas:
        for kind, key in (("artist", "cat_artist_created"), ("person", "cat_person_created")):
            d = f[key]
            if d:
                frescura[kind][d] = frescura[kind].get(d, 0) + 1
    resumen["frescura_catalogo"] = {k: dict(sorted(v.items())) for k, v in frescura.items()}
    resumen["matches_creados_desde_2026-10-01"] = {
        k: sum(n for d, n in v.items() if d >= "2026-10-01") for k, v in frescura.items()}
    json.dump(resumen, open(f"{OUTDIR}/dossier-nuevos-resumen.json", "w", encoding="utf-8"), ensure_ascii=False, indent=1)

    print(f"\nacciones: {json.dumps(stats, ensure_ascii=False)}")
    print(f"sin página capturada: {resumen['sin_pagina_capturada']}")
    print(f"escrito: {OUTDIR}/dossier-nuevos.{{tsv,jsonl,resumen.json}}  ({time.time()-t0:.1f}s)")

if __name__ == "__main__":
    main()
