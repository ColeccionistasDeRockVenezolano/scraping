#!/usr/bin/env python3
"""CRV · Fase «bios» — captura de la pestaña de biografía de RYM.

Para cada artista de la cola de bios (name + rymHref), captura
https://rateyourmusic.com<rymHref>/biography con el navegador stealth de
Scrapling + las cookies del Firefox del dueño (una sola sesión RYM a la vez:
se lanza al cerrar «nuevos»).

Guarda en <outdir>/pages/ :
  bio-<slug>.json   (texto extraído + estado; lo consume el aplicador de bios)
  bio-<slug>.html   (crudo, por si el DOM cambia)
Reanudable: se salta las ya capturadas.

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
import tempfile
import time
from urllib.parse import unquote

from scrapling.fetchers import StealthySession

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
AVISOS = f"{REPO}/scripts/rym-etapa3-avisos.sh"
UA = "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"
COOKIE_SOURCES = ["/tmp/rym-prof", os.path.expanduser("~/.mozilla/firefox/d4qtp99b.default-esr")]
BASE = "https://rateyourmusic.com"
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


def norm_href(h):
    if not h:
        return ""
    h = unquote(h)
    if h.startswith(BASE):
        h = h[len(BASE):]
    return h.split("?")[0].split("#")[0].rstrip("/")


def slugify(href):
    s = norm_href(href).replace("/artist/", "").replace("/", "_")
    s = re.sub(r"[^A-Za-z0-9_\-\.]", "", s)
    return s[:90] or "sin-slug"


def ext_bio(page):
    """Texto de la biografía (sección de la página del artista; sin basura JS)."""
    partes = []
    for sel in ("div.section_artist_biography ::text", ".section_artist_biography ::text"):
        try:
            partes = page.css(sel).getall()
        except Exception:
            partes = []
        if partes:
            break
    txt = " ".join(" ".join(partes).split())[:8000]
    if txt.startswith("Biography "):
        txt = txt[len("Biography "):]
    elif txt == "Biography":
        txt = ""
    return txt


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
    pend = [r for r in cola if not os.path.exists(os.path.join(pages_dir, "bio-" + slugify(r["rymHref"]) + ".json"))]
    if args.limit:
        pend = pend[: args.limit]
    log(f"cola {len(cola)} · pendientes {len(pend)}")
    if not pend:
        log("BIOS TERMINADAS (nada pendiente)")
        return

    cookies, src, _ = load_cookies()
    log(f"cookies: {len(cookies)} (fuente {src})")
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

    avisar(f"📖 CRV · bios: arranco la captura de biografías de RYM ({len(pend)} pendientes, ritmo humano). "
           "Tablero: file:///tmp/crv-recon/crv-extracciones-tablero.html")
    hechos = fallos_seg = 0
    for pos, row in enumerate(pend, 1):
        url = BASE + norm_href(row["rymHref"]) + "/biography"
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
        slug = slugify(row["rymHref"])
        bio = ext_bio(page)
        rec = {"name": row["name"], "rymHref": norm_href(row["rymHref"]), "u": url,
               "bio": bio, "n": len(bio), "v": 3, "kind": "bio",
               "wall": not bool(bio), "at": time.strftime("%H:%M:%S")}
        try:
            with open(os.path.join(pages_dir, "bio-" + slug + ".json"), "w", encoding="utf-8") as f:
                json.dump(rec, f, ensure_ascii=False)
            html = ""
            try:
                html = str(page.html_content)
            except Exception:
                try:
                    html = str(page)
                except Exception:
                    html = ""
            with open(os.path.join(pages_dir, "bio-" + slug + ".html"), "w", encoding="utf-8") as f:
                f.write(html[:400000])
        except Exception as exc:
            log("aviso guardando:", str(exc)[:80])
        hechos += 1
        if hechos % 10 == 0 or pos == len(pend):
            log(f"  {pos}/{len(pend)} [{row['name'][:30]}] bio {rec['n']} chars")
        pausa = random.uniform(args.base_min, args.base_max)
        if random.random() < 0.08:
            pausa += random.uniform(15, 45)
        if hechos % 25 == 0:
            pausa += random.uniform(30, 70)
        time.sleep(pausa)
    log(f"BIOS TERMINADAS: {hechos}/{len(pend)} en esta corrida")
    avisar(f"📖 CRV · bios: corrida terminada — {hechos} biografías capturadas.")


if __name__ == "__main__":
    main()
