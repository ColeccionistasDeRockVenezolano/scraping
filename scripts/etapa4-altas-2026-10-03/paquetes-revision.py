#!/usr/bin/env python3
"""Etapa 4 «Altas» — constructor de los paquetes de revisión (SOLO LECTURA).

Genera tres paquetes para confirmación de Brian, con evidencia citada y veredicto sugerido:
  1. careo-discos-49.tsv/.jsonl    — los 49 discos en cola (album_match): misma obra vs otra.
  2. careo-homonimos-79.tsv/.jsonl — los 79 «revisar_homonimo» del dossier: alias vs distinto.
  3. descartes-269.tsv/.jsonl      — 246 personas sin evidencia musical + 23 fríos: descartar.

Nada se escribe en la BD. Uso: python3 scripts/etapa4-altas-2026-10-03/paquetes-revision.py
"""
import difflib
import json
import re
import subprocess
import unicodedata
from collections import Counter

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
OUT = f"{ROOT}/reports/etapa4-altas-2026-10-03"
RUNS = "11726,11729,11732,11741,11746,11752"

SEQ = {"vol", "volume", "volumen", "pt", "parte", "part", "acto", "apendice", "appendix", "chapter", "tomo"}
STOP = {"de", "del", "la", "el", "los", "las", "y", "e", "and", "the", "of", "a"}
ROMAN = {"i": "1", "ii": "2", "iii": "3", "iv": "4", "v": "5", "vi": "6", "vii": "7", "viii": "8", "ix": "9", "x": "10"}


def norm(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    s = s.replace("&", " y ")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s)).strip()


def normseq(s):
    """normaliza, mapea sinónimos de secuencia y pasa romanos a dígitos tras la palabra de secuencia."""
    toks = [{"vol": "volume", "volumen": "volume", "pt": "parte", "part": "parte",
             "apendice": "appendix"}.get(t, t) for t in norm(s).split()]
    out = []
    for idx, t in enumerate(toks):
        if t in ROMAN and idx > 0 and toks[idx - 1] in SEQ:
            t = ROMAN[t]
        out.append(t)
    return " ".join(out)


def sql(q):
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv",
                        "-At", "-F", "\t", "-c", q], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("psql: " + r.stderr)
    return [l.split("\t") for l in r.stdout.strip().split("\n") if l.strip()]


def sqlj(q):
    """Igual que sql() pero devuelve lista de dicts vía json_agg (inmune a tabs/newlines)."""
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-tAc",
                        f"SELECT coalesce(json_agg(row_to_json(t)), '[]'::json)::text FROM ({q}) t"],
                       capture_output=True, text=True)
    if r.returncode:
        raise SystemExit("psql: " + r.stderr)
    return json.loads(r.stdout.strip() or "[]")


def tsv(v):
    return re.sub(r"[\t\r\n]+", " ", str(v if v is not None else ""))


def escribir(nombre, filas):
    with open(f"{OUT}/{nombre}.tsv", "w", encoding="utf-8") as fh:
        fh.write("\t".join(filas[0].keys()) + "\n")
        for f in filas:
            fh.write("\t".join(tsv(v) for v in f.values()) + "\n")
    with open(f"{OUT}/{nombre}.jsonl", "w", encoding="utf-8") as fh:
        for f in filas:
            fh.write(json.dumps(f, ensure_ascii=False) + "\n")
    print(f"{nombre}: {len(filas)} filas")


# ------------------------------------------------------------------ paquete 1

def paquete_discos():
    rev = sqlj(f"""
      SELECT rq.id::text AS rid, (rq.payload->>'score')::numeric::text AS score,
             (rq.payload->>'resolutionDecisionId')::text AS did
      FROM ingest.review_queue rq
      WHERE rq.claim_a_id IN (SELECT id FROM ingest.claims WHERE run_id IN ({RUNS}))
        AND rq.kind='album_match' AND rq.status='open' ORDER BY rq.id""")
    dids = [r["did"] for r in rev if r["did"] and r["did"].isdigit()]
    dec = {r["id"]: r for r in sqlj(f"""
      SELECT id::text AS id, input_name_original,
             coalesce(candidates->0->>'candidateId','') AS cid,
             coalesce(candidates->0->>'canonicalName','') AS cname
      FROM ingest.entity_resolution_decisions WHERE id IN ({','.join(dids)})""")}
    cand_ids = sorted({r["cid"] for r in dec.values() if r["cid"] and r["cid"].isdigit()})
    alb = {r["id"]: r for r in sqlj(f"""
      SELECT id::text AS id, title, coalesce(release_year::text,'') AS anio, artist_id::text AS artist_id
      FROM public.albums WHERE id IN ({','.join(cand_ids)})""")}
    art_ids = sorted({r["artist_id"] for r in alb.values() if r["artist_id"] and r["artist_id"].isdigit()})
    art = {r["id"]: r["name"] for r in sqlj(f"SELECT id::text AS id, name FROM public.artists WHERE id IN ({','.join(art_ids)})")}
    # lado nuevo: dossier-discos sección 222
    nuevas = {}
    for l in open(f"{OUT}/dossier-discos.jsonl", encoding="utf-8"):
        r = json.loads(l)
        if r["seccion"] == "222":
            nuevas.setdefault(norm(r["disco"]), r)
    filas = []
    for rv in rev:
        d = dec.get(rv["did"])
        if not d:
            continue
        titulo, cand_id, cand_name = d["input_name_original"], d["cid"], d["cname"]
        cat = alb.get(cand_id)
        cat_title, cat_year = (cat["title"], cat["anio"]) if cat else ("(no encontrado)", "")
        cat_artist = art.get(cat["artist_id"], "?") if cat else "?"
        n = nuevas.get(norm(titulo), {})
        a, b = normseq(titulo), normseq(cat_title)
        ratio = round(difflib.SequenceMatcher(None, a, b).ratio(), 3)
        ta = [t for t in a.split() if t not in STOP]
        tb = [t for t in b.split() if t not in STOP]
        if a == b or sorted(ta) == sorted(tb):
            clase, veredicto = "misma_escritura", "misma"
        else:
            d1, d2 = Counter(a.split()) - Counter(b.split()), Counter(b.split()) - Counter(a.split())
            only = lambda c: all(t in SEQ or t in STOP or re.fullmatch(r"\d+|[a-e]", t) for t in c.elements())
            if (d1 and only(d1) and (not d2 or only(d2))) or (d2 and only(d2) and not d1):
                clase, veredicto = "secuencia", "otra"
            elif ratio >= 0.955:
                clase, veredicto = "typo_probable", "misma"
            else:
                clase, veredicto = "dudoso", "revisar"
        nota = f"ratio {ratio}"
        if clase == "misma_escritura":
            nota += "; misma obra (puntuación/mayúsculas)"
        elif clase == "secuencia":
            nota += "; secuencia distinta (vol./acto/apéndice/nº)"
        elif clase == "typo_probable":
            nota += "; probable typo de la misma obra"
        filas.append({
            "review_id": rv["rid"], "score_er": rv["score"], "artista": cat_artist if cat_artist != "?" else "",
            "disco_rym": titulo, "anio_rym": n.get("anio", ""), "tipo_rym": n.get("tipo_rym", ""),
            "pistas_rym": n.get("ev_tracks", ""), "rym_href": n.get("rym_href", ""),
            "cat_album_id": cand_id, "cat_titulo": cat_title, "cat_anio": cat_year,
            "clase": clase, "veredicto_sugerido": veredicto, "nota": nota,
            "fuente": f"review_queue#{rv['rid']}+er_decision#{rv['did']}+albums#{cand_id or '-'}+dossier-discos.jsonl",
            "decision": ""})
    filas.sort(key=lambda f: (f["veredicto_sugerido"], -float(f["score_er"])))
    escribir("careo-discos", filas)
    print("  veredictos:", dict(Counter(f["veredicto_sugerido"] for f in filas)))


# ------------------------------------------------------------------ paquete 2

def paquete_homonimos():
    rows = [json.loads(l) for l in open(f"{OUT}/dossier-nuevos.jsonl", encoding="utf-8")]
    hom = [r for r in rows if r["accion_sugerida"] == "revisar_homonimo"]
    # solapamiento de discografía (solo lado artista)
    art_ids = sorted({str(r["cat_artist_id"]) for r in hom if r.get("cat_artist_id")})
    als = {}
    if art_ids:
        for a in sqlj(f"SELECT artist_id::text AS aid, title FROM public.albums WHERE artist_id IN ({','.join(art_ids)})"):
            als.setdefault(a["aid"], []).append(norm(a["title"]).replace(" ", ""))
    filas = []
    for r in hom:
        ca, cp = r.get("cat_artist_via", ""), r.get("cat_person_via", "")
        near_a = "near" in ca
        near_p = "near" in cp
        sim = max(float(r.get("cat_artist_sim") or 0), float(r.get("cat_person_sim") or 0))
        lado = "artista" if (near_a and (not near_p or float(r.get("cat_artist_sim") or 0) >= float(r.get("cat_person_sim") or 0))) else "persona"
        cat_id = r["cat_artist_id"] if lado == "artista" else r["cat_person_id"]
        cat_nombre = r["cat_artist_name"] if lado == "artista" else r["cat_person_name"]
        cat_creado = r["cat_artist_created"] if lado == "artista" else r["cat_person_created"]
        # solape de discos si el lado es artista
        solape, ej = 0, []
        if lado == "artista" and cat_id and str(cat_id) in als:
            propias = als[str(cat_id)]
            try:
                rec = json.load(open(f"{ROOT}/data/raw/fuentes-web-2026-10-01/rym-nuevos/pages/{r['rym_href'].replace('/artist/', '').replace('/', '_')}.json", encoding="utf-8"))["rec"]
            except Exception:
                rec = {}
            for rr in rec.get("rows") or []:
                k = norm(rr.get("t") or "").replace(" ", "")
                if k and k in propias:
                    solape += 1
                    if len(ej) < 3:
                        ej.append(rr.get("t"))
        if solape >= 2:
            veredicto = "alias_probable"
        elif sim >= 0.95:
            veredicto = "alias_probable"
        elif sim >= 0.92:
            veredicto = "alias_dudoso"
        else:
            veredicto = "distinto_probable"
        nota = f"sim {sim:.2f}"
        if solape:
            nota += f"; {solape} discos coinciden: {', '.join(ej)}"
        if near_a and near_p:
            nota += "; también cerca del otro tipo (artista+persona)"
        filas.append({
            "rym_name": r["rym_name"], "rym_href": r["rym_href"], "nlocs": r["nlocs"],
            "clase_etapa2": r["clase_etapa2"],
            "cat_tipo": lado, "cat_id": cat_id, "cat_nombre": cat_nombre,
            "cat_sim": round(sim, 3), "cat_via": (ca if lado == "artista" else cp), "cat_creado": cat_creado,
            "ev_formado": r["ev_formed"] or "", "ev_generos": r["ev_genres"], "ev_discos": r["ev_n_discos"],
            "ev_miembro_de": r["miembro_de"],
            "discos_solapan": solape, "veredicto_sugerido": veredicto, "nota": nota,
            "fuente": f"dossier-nuevos.jsonl#revisar_homonimo + BD cats#{cat_id}",
            "decision": ""})
    filas.sort(key=lambda f: -f["cat_sim"])
    escribir("careo-homonimos", filas)
    print("  veredictos:", dict(Counter(f["veredicto_sugerido"] for f in filas)))


# ------------------------------------------------------------------ paquete 3

def paquete_descartes():
    rows = [json.loads(l) for l in open(f"{OUT}/dossier-nuevos.jsonl", encoding="utf-8")]
    desc = [r for r in rows if r["accion_sugerida"] == "revisar_persona" and r["ev_musicalidad"] == "sin_evidencia"]
    frios = [r for r in rows if r["accion_sugerida"] == "cola_fria"]
    filas = []
    for r in desc + frios:
        cat = "persona_sin_evidencia" if r["accion_sugerida"] == "revisar_persona" else "frio_sin_senales"
        born = "sí" if "born" in (r["sugerencia_revisor"] or "") else "no"
        motivo = f"RYM: {r['ev_n_gen']} géneros, {r['ev_n_discos']} discos" + ("; ficha stub" if "stub" in r["sugerencia_revisor"] else "")
        filas.append({
            "categoria": cat, "rym_name": r["rym_name"], "rym_href": r["rym_href"], "nlocs": r["nlocs"],
            "nacido": born, "n_generos": r["ev_n_gen"], "n_discos": r["ev_n_discos"],
            "miembro_de": r["miembro_de"], "stub": "sí" if "stub" in r["sugerencia_revisor"] else "no",
            "motivo": motivo, "propuesta": "descartar (sin alta)",
            "fuente": "dossier-nuevos.jsonl#sin_evidencia_musical",
            "decision": ""})
    filas.sort(key=lambda f: (f["categoria"], f["rym_name"].lower()))
    escribir("descartes", filas)
    print("  categorías:", dict(Counter(f["categoria"] for f in filas)))


if __name__ == "__main__":
    print("== paquete 1: careo de discos ==")
    paquete_discos()
    print("== paquete 2: homónimos ==")
    paquete_homonimos()
    print("== paquete 3: descartes ==")
    paquete_descartes()
    print("listo (solo lectura; nada escrito en la BD)")
