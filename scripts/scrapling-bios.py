#!/usr/bin/env python3
"""CRV · Fase «bios» — captura de la biografía de RYM.

Para cada artista de la cola de bios (name + rymHref):

  1. Pasada OFFLINE (preferida): si su ficha ya está capturada en las páginas de
     «nuevos» (data/raw/fuentes-web-2026-10-01/rym-nuevos/pages/<slug>.html), la
     biografía se extrae de ahí — sin tocar RYM.
  2. Pasada EN VIVO (solo si no hay ficha guardada): se captura la página del
     artista https://rateyourmusic.com<rymHref> con el navegador stealth de
     Scrapling + las cookies del Firefox del dueño (una sola sesión RYM a la vez:
     se lanza al cerrar «nuevos»).

La URL con sufijo /biography devuelve un cascarón SIN la sección de biografía
(verificado 2026-10-05) — se usa siempre la página del artista a secas.

Guarda en <outdir>/pages/ :
  bio-<slug>.json   {name, rymHref, u, bio, n, sin_bio, wall, fuente, at}
  bio-<slug>.html   (crudo, por si el DOM cambia)
Reanudable: se salta las ya capturadas. Un muro (wall=true) NO cuenta como
terminado: se reintenta en la siguiente corrida. Página sin biografía queda
sin_bio=true (terminado: RYM no la tiene).

Uso: ~/.venvs/scrapling/bin/python -u scripts/scrapling-bios.py [--limit N]
"""
import argparse
import json
import os
import random
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import time

from scrapling.fetchers import StealthySession

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from rym_reglas import norm_href, slugify  # noqa: E402  (regla única de la campaña)

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
AVISOS = f"{REPO}/scripts/rym-etapa3-avisos.sh"
UA = "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"
COOKIE_SOURCES = ["/tmp/rym-prof", os.path.expanduser("~/.mozilla/firefox/d4qtp99b.default-esr")]
BASE = "https://rateyourmusic.com"
NUEVOS_PAGES = f"{REPO}/data/raw/fuentes-web-2026-10-01/rym-nuevos/pages"
_LAST_AVISO = {}


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def avisar(msg):
    try:
        subprocess.run(["timeout", "30", "bash", AVISOS, msg], capture_output=True, timeout=40)
    except Exception as exc:
        log("aviso Telegram falló:", str(exc)[:80])


def avisar_throttled(msg, min_gap=3600, clave="gen"):
    if time.time() - _LAST_AVISO.get(clave, 0.0) >= min_gap:
        _LAST_AVISO[clave] = time.time()
        avisar(msg)


def load_cookies():
    """Cookies de RYM del perfil de Firefox más fresco (copia inmune a locks)."""
    cands = []
    for src in COOKIE_SOURCES:
        f = os.path.join(src, "cookies.sqlite")
        if not os.path.exists(f):
            continue
        mts = [os.path.getmtime(f)] + [os.path.getmtime(f + s) for s in ("-wal", "-shm") if os.path.exists(f + s)]
        cands.append((max(mts), src))
    own = next((c for c in cands if ".mozilla" in c[1]), None)
    if own and all(c[0] <= own[0] + 900 for c in cands):
        best = own
    else:
        best = max(cands, key=lambda c: c[0]) if cands else None
    if best is None:
        raise SystemExit("no hay cookies.sqlite en las fuentes configuradas")
    tmp = tempfile.mkdtemp(prefix="crv-cookies-")
    for suf in ("", "-wal", "-shm"):
        s = os.path.join(best[1], "cookies.sqlite" + suf)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(tmp, "cookies.sqlite" + suf))
    con = sqlite3.connect(os.path.join(tmp, "cookies.sqlite"))
    rows = con.execute(
        "SELECT host,name,value,path,expiry,isSecure,isHttpOnly FROM moz_cookies "
        "WHERE host LIKE '%rateyourmusic%' OR host LIKE '%sonemic%' OR name LIKE 'cf_%'"
    ).fetchall()
    now = time.time()
    out = []
    for host, name, value, path, expiry, sec, http in rows:
        if expiry and expiry < now:
            continue
        out.append({"name": name, "value": value, "domain": host, "path": path or "/",
                    "secure": bool(sec), "httpOnly": bool(http)})
    return out, best[1], best[0]


def ficha_nuevos(href):
    """Ruta de la ficha ya capturada en «nuevos» (variantes guion↔guion_bajo)."""
    s = slugify(href)
    for v in (s, s.replace("-", "_"), s.replace("_", "-")):
        f = os.path.join(NUEVOS_PAGES, v + ".html")
        if os.path.exists(f):
            return f
    return None


def limpia_bio(txt):
    txt = " ".join(txt.split())[:8000]
    if txt.startswith("Biography"):
        txt = txt[len("Biography"):].strip()
    elif txt == "Biography":
        txt = ""
    return txt


def ext_bio_html(html):
    """Biografía desde un HTML en disco (div.section_artist_biography, sin JS)."""
    body = html.split("</head>")[-1]
    m = re.search(r'<div class="[^"]*\bsection_artist_biography\b[^"]*"', body)
    if not m:
        return ""
    i = m.start()
    fin = len(body)
    depth = 0
    for tag in re.finditer(r"<(/?)div\b[^>]*>", body[i:], re.I):
        depth += 1 if not tag.group(1) else -1
        if depth == 0:
            fin = i + tag.end()
            break
    inner = body[i:fin]
    return limpia_bio(" ".join(re.sub(r"<[^>]+>", " ", inner).split()))


def ext_bio(page):
    """Biografía desde la página viva (misma sección; sin basura JS)."""
    try:
        els = page.css(".section_artist_biography")
    except Exception:
        return ""
    if not els:
        return ""
    el = els[0]
    try:
        txt = el.get_all_text() if hasattr(el, "get_all_text") else str(el)
    except Exception:
        return ""
    return limpia_bio(txt)


def ya_hecho(path):
    """Terminado = existe el JSON y no es un muro (los muros se reintentan)."""
    if not os.path.exists(path):
        return False
    try:
        return not json.load(open(path, encoding="utf-8")).get("wall")
    except Exception:
        return False


def guarda(pages_dir, slug, rec, html):
    with open(os.path.join(pages_dir, "bio-" + slug + ".json"), "w", encoding="utf-8") as f:
        json.dump(rec, f, ensure_ascii=False)
    with open(os.path.join(pages_dir, "bio-" + slug + ".html"), "w", encoding="utf-8") as f:
        f.write(html[:400000])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cola", default=f"{REPO}/data/raw/fuentes-web-2026-10-01/rym-bios/cola-bios.jsonl")
    ap.add_argument("--outdir", default=f"{REPO}/data/raw/fuentes-web-2026-10-01/rym-bios")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--headful", action="store_true")
    ap.add_argument("--base-min", type=float, default=5.0)
    ap.add_argument("--base-max", type=float, default=7.0)
    args = ap.parse_args()

    pages_dir = os.path.join(args.outdir, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    cola = [json.loads(l) for l in open(args.cola, encoding="utf-8") if l.strip()]
    pend = [r for r in cola if not ya_hecho(os.path.join(pages_dir, "bio-" + slugify(r["rymHref"]) + ".json"))]
    if args.limit:
        pend = pend[: args.limit]
    log(f"cola {len(cola)} · pendientes {len(pend)}")
    if not pend:
        log("BIOS TERMINADAS (nada pendiente)")
        return

    # 1) Pasada offline: fichas de «nuevos» ya en disco (no toca RYM).
    offline = [r for r in pend if ficha_nuevos(r["rymHref"])]
    vivo = [r for r in pend if not ficha_nuevos(r["rymHref"])]
    log(f"offline {len(offline)} (ficha de «nuevos») · en vivo {len(vivo)}")
    con_texto = sin_bio = 0
    for pos, row in enumerate(offline, 1):
        ruta = ficha_nuevos(row["rymHref"])
        if not ruta:
            vivo.append(row)
            continue
        try:
            html = open(ruta, encoding="utf-8", errors="replace").read()
        except Exception as exc:
            log(f"[offline-err] {row['name']}: {str(exc)[:80]}")
            vivo.append(row)
            continue
        bio = ext_bio_html(html)
        rec = {"name": row["name"], "rymHref": norm_href(row["rymHref"]),
               "u": BASE + norm_href(row["rymHref"]), "bio": bio, "n": len(bio),
               "v": 4, "kind": "bio", "wall": False, "sin_bio": not bio,
               "fuente": "nuevos", "at": time.strftime("%H:%M:%S")}
        guarda(pages_dir, slugify(row["rymHref"]), rec, html)
        if bio:
            con_texto += 1
        else:
            sin_bio += 1
        if pos % 100 == 0 or pos == len(offline):
            log(f"  offline {pos}/{len(offline)} · con texto {con_texto} · sin bio {sin_bio}")

    # 2) Pasada en vivo: sin ficha en disco → RYM (ritmo humano, una sesión).
    session = {"s": None}

    def nueva_sesion():
        if session["s"] is not None:
            try:
                session["s"].close()
            except Exception:
                pass
        cs, _, _ = load_cookies()
        session["s"] = StealthySession(headless=not args.headful, cookies=cs, useragent=UA,
                                       timeout=120000, retries=1, solve_cloudflare=False)
        session["s"].start()

    def fetch_una(url, max_tries=4):
        for intento in range(1, max_tries + 1):
            s = session["s"]
            if s is None:
                nueva_sesion()
                s = session["s"]
            assert s is not None
            try:
                page = s.fetch(url, timeout=60000)
            except Exception as exc:
                log(f"[fetch-err] {url}: {str(exc)[:100]}")
                time.sleep(10 + intento * 10)
                if intento >= 2:
                    nueva_sesion()
                continue
            title = ""
            try:
                title = (page.css("title::text").get() or "")[:80]
            except Exception:
                pass
            blocked = page.status in (403, 503) or re.search(r"Un momento|Just a moment|Security check|Attention Required", title, re.I)
            if not blocked:
                return page
            log(f"[bloqueo] ({page.status}) {title} — intento {intento}/{max_tries}")
            tipo_cf = page.status == 403 or bool(re.search(r"Un momento|Just a moment|Attention Required", title, re.I))
            if intento == 1:
                if tipo_cf:
                    avisar_throttled("🔒 CRV · bios: muro de Cloudflare («Un momento…» = sesión vencida). Abre rateyourmusic.com en tu Firefox ~30 s; nada se pierde.", min_gap=3600, clave="cf")
                else:
                    avisar_throttled("🟡 CRV · bios: muro suave de RYM (503); auto-recupera sin acción tuya.", min_gap=3600, clave="soft")
            if not tipo_cf and intento == 1:
                time.sleep(random.uniform(15, 35))
            else:
                time.sleep(random.uniform(90, 240))
            nueva_sesion()
        return None

    fallos_seg = 0
    if vivo:
        avisar(f"📖 CRV · bios: arranco la captura de biografías de RYM ({len(cola)} en cola; "
               f"{len(vivo)} en vivo, el resto ya estaba en disco). "
               "Tablero: file:///tmp/crv-recon/crv-extracciones-tablero.html")
    for pos, row in enumerate(vivo, 1):
        url = BASE + norm_href(row["rymHref"])
        page = fetch_una(url)
        if page is None:
            fallos_seg += 1
            log(f"[fallo] {row['name']} — queda pendiente para otro intento")
            if fallos_seg >= 4:
                log("4 fallos seguidos: enfrío 5 min")
                time.sleep(300)
                fallos_seg = 0
            continue
        fallos_seg = 0
        bio = ext_bio(page)
        if not bio:
            # ¿la página trae la ficha del artista (no un cascarón)? sin sección = RYM no la tiene
            try:
                tiene_ficha = bool(page.css(".disco_release") or page.css(".section_artist_info"))
            except Exception:
                tiene_ficha = False
            if not tiene_ficha:
                log(f"[cascarón?] {row['name']}: sin ficha de artista — se reintenta luego")
                continue
        rec = {"name": row["name"], "rymHref": norm_href(row["rymHref"]), "u": url,
               "bio": bio, "n": len(bio), "v": 4, "kind": "bio", "wall": False,
               "sin_bio": not bio, "fuente": "live", "at": time.strftime("%H:%M:%S")}
        html = ""
        try:
            html = str(page.html_content)
        except Exception:
            try:
                html = str(page)
            except Exception:
                html = ""
        try:
            guarda(pages_dir, slugify(row["rymHref"]), rec, html)
        except Exception as exc:
            log("aviso guardando:", str(exc)[:80])
        if bio:
            con_texto += 1
            log(f"  {pos}/{len(vivo)} [{row['name'][:30]}] bio {rec['n']} chars")
        else:
            sin_bio += 1
            log(f"  {pos}/{len(vivo)} [{row['name'][:30]}] sin bio en RYM")
        pausa = random.uniform(args.base_min, args.base_max)
        if random.random() < 0.08:
            pausa += random.uniform(15, 45)
        time.sleep(pausa)
    fallos = len(pend) - con_texto - sin_bio
    log(f"BIOS TERMINADAS: {con_texto} con texto · {sin_bio} sin bio en RYM · {fallos} pendientes (muros)")
    if not fallos:
        avisar(f"📖 CRV · bios: cola cerrada — {con_texto} biografías capturadas, {sin_bio} sin bio en RYM.", )
        log("BIOS TERMINADAS (nada pendiente)")


if __name__ == "__main__":
    main()
