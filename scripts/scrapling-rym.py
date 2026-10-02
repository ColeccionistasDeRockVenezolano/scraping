#!/usr/bin/env python3
"""Capturador RYM vía Scrapling — artistas y discografía (encargo explícito del dueño, 2026-10-02).

Usa el navegador stealth de Scrapling (Camoufox) + las cookies del perfil de Firefox del
dueño (cf_clearance de Cloudflare incluida) para leer fichas de artista y de disco de
rateyourmusic.com a ritmo humano. NO resuelve captchas: si RYM pone su muro, avisa por
Telegram y reintenta con enfriamiento. NO usa proxies.

Salidas compatibles con el resto de la etapa 3/4:
  <outdir>/pages/<slug>.json|.html   {href, rec:{...v3...}, capturedAt}
  <outdir>/estado.json               {href: recortar(rec)}
  <outdir>/tablero.html              tablero autorefrescante
  /tmp/crv-recon/rym-nuevos-tablero.html  copia del tablero

Uso:
  ~/.venvs/scrapling/bin/python scripts/scrapling-rym.py --cola data/.../cola-nuevos.jsonl \
      --outdir data/raw/fuentes-web-2026-10-01/rym-nuevos --phase both [--limit N] [--headful]
"""
import argparse, json, os, random, re, shutil, sqlite3, subprocess, tempfile, time

from scrapling.fetchers import StealthySession

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
AVISOS = f"{REPO}/scripts/rym-etapa3-avisos.sh"
UA = "Mozilla/5.0 (X11; Linux x86_64; rv:153.0) Gecko/20100101 Firefox/153.0"
COOKIE_SOURCES = ["/tmp/rym-prof", os.path.expanduser("~/.mozilla/firefox/d4qtp99b.default-esr")]
EXTRACTOR_V = 3


def log(*a):
    print(time.strftime("[%H:%M:%S]"), *a, flush=True)


def avisar(msg):
    try:
        subprocess.run(["timeout", "30", "bash", AVISOS, msg], capture_output=True, timeout=40)
    except Exception as exc:
        log("aviso Telegram falló:", str(exc)[:80])


_LAST_AVISO = {"t": 0.0}


def avisar_throttled(msg, min_gap=900):
    """Avisos de bloqueo con anti-spam (1 cada min_gap segundos)."""
    if time.time() - _LAST_AVISO["t"] >= min_gap:
        _LAST_AVISO["t"] = time.time()
        avisar(msg)


def load_cookies():
    """Lee las cookies de RYM del perfil de Firefox más fresco (copia inmune a locks)."""
    best = None
    for src in COOKIE_SOURCES:
        f = os.path.join(src, "cookies.sqlite")
        if not os.path.exists(f):
            continue
        mts = [os.path.getmtime(f)] + [os.path.getmtime(f + s) for s in ("-wal", "-shm") if os.path.exists(f + s)]
        mt = max(mts)
        if best is None or mt > best[0]:
            best = (mt, src)
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


def body_text(page, limit=8000):
    parts = page.xpath("//body//text()").getall()
    txt = " ".join(x.strip() for x in parts if x and x.strip())
    return re.sub(r"\s+", " ", txt)[:limit]


def attr(el, name):
    return (el.attrib.get(name) if el is not None else None) or None


def ext_artist(page):
    rec = {"u": "", "t": "", "v": EXTRACTOR_V, "kind": "artist"}
    h1 = page.css("h1::text").get()
    rec["name"] = h1.strip()[:120] if h1 else None
    bt = body_text(page, 600)
    rec["wall"] = bool(re.search(r"Just a moment|Attention Required|Verify you are human|Checking your browser", bt, re.I))
    md = ""
    mds = page.css('meta[name="description"]::attr(content)').get()
    if mds:
        md = mds
    m = re.search(r"formed\s+(\d{4})", md, re.I)
    rec["formed"] = int(m.group(1)) if m else None
    imgs = page.css(".section_artist_image img")
    if imgs:
        el = imgs[0]
        src = attr(el, "src")
        cls = attr(el, "class") or ""
        cover = bool(re.search(r"-cover-art\.(jpg|jpeg|png|webp)(\?|$)", src or "", re.I)) or bool(el.xpath("ancestor::div[contains(@class,'coverart')]"))
        rec["photo"] = {"src": src, "cls": cls}
        rec["photoEsCover"] = cover
    else:
        rec["photo"] = None
        rec["photoEsCover"] = None
    rec["og"] = page.css('meta[property="og:image"]::attr(content)').get()
    genres = []
    for t in page.css('a[href^="/genre/"]::text').getall():
        t = t.strip()
        if t and t not in genres:
            genres.append(t)
    rec["genres"] = genres[:20]
    rec["sections"] = [x.strip() for x in page.css("#discography .disco_header_label::text").getall()]
    rows = []
    for r in page.css("#discography div.disco_release"):
        links = r.css('.disco_mainline a[href*="/release/"]') or r.css('a[href*="/release/"]')
        h, t = None, None
        if links:
            h = attr(links[0], "href")
            tx = links[0].css("::text").get()
            t = tx.strip()[:140] if tx else None
        y = r.css('[class*="disco_year"]::text').get()
        ty = r.xpath("preceding::*[contains(@class,'disco_header_label')][1]//text()").get()
        rows.append({"h": h, "t": t, "y": (y.strip()[:12] if y else None), "ty": (ty.strip() if ty else None)})
    rec["rows"] = [x for x in rows if x["h"]]
    return rec


def ext_release(page):
    rec = {"u": "", "t": "", "v": EXTRACTOR_V, "kind": "release"}
    h1 = page.css("h1::text").get()
    name = h1.strip()[:140] if h1 else None
    if not name:
        tt = page.css("title::text").get() or ""
        name = (re.split(r" by | \(", tt)[0] or "").strip()[:140] or None
    rec["name"] = name
    bt = body_text(page, 600)
    rec["wall"] = bool(re.search(r"Just a moment|Attention Required|Verify you are human|Checking your browser", bt, re.I))
    rec["og"] = page.css('meta[property="og:image"]::attr(content)').get()
    genres = []
    for t in page.css('a[href^="/genre/"]::text').getall():
        t = t.strip()
        if t and t not in genres:
            genres.append(t)
    rec["genres"] = genres[:20]
    a1 = page.css('.release_page_header a[href^="/artist/"]::text').getall() or page.css('.section_release_page a[href^="/artist/"]::text').getall() or page.css('a.artist[href^="/artist/"]::text').getall()
    rec["artist"] = a1[0].strip()[:140] if a1 else None
    info_parts = page.css('.section_release_info ::text').getall() + page.css(".release_page_header ::text").getall() + page.css("#content ::text").getall()
    rec["info"] = " ".join(x.strip() for x in info_parts if x and x.strip())[:4000]
    tracks = []
    for a in page.css('a[href*="/song/"]')[:120]:
        tx = a.css("::text").get()
        par = a.xpath("ancestor::tr[1] | ancestor::li[1] | ancestor::div[1]")
        rowa = ""
        if par:
            rowa = re.sub(r"\s+", " ", " ".join(par[0].xpath(".//text()").getall())).strip()[:240]
        tracks.append({"t": (tx or "").strip()[:140], "row": rowa})
    rec["tracks"] = tracks
    credits = []
    for a in page.css('a[href^="/artist/"], a[href^="/person/"]')[:300]:
        tx = a.css("::text").get()
        credits.append({"h": attr(a, "href"), "n": (tx or "").strip()[:90]})
    rec["creditLinks"] = credits
    return rec


def recortar(rec):
    rows = rec.get("rows") or []
    foto = None
    if rec.get("photo") and not rec.get("photoEsCover"):
        foto = (rec.get("photo") or {}).get("src")
    return {"name": rec.get("name"), "kind": rec.get("kind") or "artist", "nRows": len(rows),
            "nGen": len(rec.get("genres") or []), "photo": foto,
            "formed": rec.get("formed"), "og": rec.get("og"), "wall": bool(rec.get("wall")),
            "nTracks": len(rec.get("tracks") or []), "nCredits": len(rec.get("creditLinks") or []),
            "at": time.strftime("%H:%M:%S"), "v": rec.get("v"), "src": "scrapling"}


def es_ok_artista(e):
    return bool(e.get("v") == EXTRACTOR_V and e.get("name") and not e.get("wall"))


def es_ok_release(e):
    return bool(e.get("v") == EXTRACTOR_V and (e.get("name") or e.get("og")) and (e.get("og") or e.get("nTracks", 0) or e.get("nGen", 0)))


def tablero_html(estado, cola, nota):
    hechas = sum(1 for r in cola if es_ok_artista(estado.get(norm_href(r["rymHref"])) or {}))
    rel = sum(1 for e in estado.values() if e.get("kind") == "release")
    rel_ok = sum(1 for e in estado.values() if e.get("kind") == "release" and es_ok_release(e))
    filas = []
    for r in cola:
        href = norm_href(r["rymHref"])
        e = estado.get(href) or {}
        ok = es_ok_artista(e)
        nombre = r["name"] if ok else f'<a href="https://rateyourmusic.com{href}" target="_blank">{r["name"]}</a>'
        marca = f'<span class="ok">&#10003;</span> rel {e.get("nRows", 0)} | gen {e.get("nGen", 0)}' if ok else "&#8226; pendiente"
        filas.append(f'<tr class="{"completa" if ok else "parcial"}"><td>{nombre}</td><td>{marca}</td></tr>')
    return ("<!doctype html><meta charset=\"utf-8\"><title>RYM via Scrapling - etapa 4</title>\n"
            "<meta http-equiv=\"refresh\" content=\"10\">\n"
            "<style>body{font:14px system-ui;background:#111;color:#eee;margin:16px}table{border-collapse:collapse;width:100%}\n"
            "td,th{border:1px solid #333;padding:3px 8px}th{background:#1e1e1e} a{color:#7fd1ff}.ok{color:#7CFC98;font-weight:700}\n"
            ".parcial td{background:#2b270f}.completa td{background:#12301a}</style>\n"
            f"<p><b>Scrapling RYM</b> — artistas <b>{hechas}</b>/{len(cola)} · discos <b>{rel_ok}</b>/{rel} · {nota} · <span class=\"meta\">{time.strftime('%H:%M:%S')}</span></p>\n"
            "<table><tr><th>Artista</th><th>Estado</th></tr>" + "\n".join(filas) + "</table>")


def escribir_tablero(outdir, estado, cola, nota="en marcha"):
    html = tablero_html(estado, cola, nota)
    for p in (os.path.join(outdir, "tablero.html"), "/tmp/crv-recon/rym-nuevos-tablero.html"):
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            open(p, "w", encoding="utf-8").write(html)
        except Exception as exc:
            log("aviso tablero:", str(exc)[:80])


def guardar_pagina(pages_dir, kind, href, rec, html):
    slug = ("rel_" + slugify(href.replace("/release/", ""))) if kind == "release" else slugify(href)
    with open(os.path.join(pages_dir, slug + ".json"), "w", encoding="utf-8") as f:
        json.dump({"href": href, "rec": rec, "capturedAt": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=1)
    if isinstance(html, str) and len(html) > 3000:
        with open(os.path.join(pages_dir, slug + ".html"), "w", encoding="utf-8") as f:
            f.write(html)
    return slug


def construir_releases(cola, pages_dir, estado):
    releases, vistos = [], set()
    for row in cola:
        href = norm_href(row["rymHref"])
        f = os.path.join(pages_dir, slugify(href) + ".json")
        if not os.path.exists(f):
            continue
        try:
            capt = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        for r in capt.get("rec", {}).get("rows") or []:
            rel = norm_href(r.get("h"))
            if not rel or rel in vistos:
                continue
            vistos.add(rel)
            if not es_ok_release(estado.get(rel) or {}):
                releases.append(("release", rel, {"name": f"{row['name']} - {r.get('t') or ''}", "parent": href}))
    return releases


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cola", required=True)
    ap.add_argument("--outdir", required=True)
    ap.add_argument("--phase", choices=["artists", "releases", "both"], default="both")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--headful", action="store_true")
    ap.add_argument("--base-min", type=float, default=7.0)
    ap.add_argument("--base-max", type=float, default=12.0)
    args = ap.parse_args()

    outdir = args.outdir
    pages_dir = os.path.join(outdir, "pages")
    os.makedirs(pages_dir, exist_ok=True)
    os.makedirs("/tmp/crv-recon", exist_ok=True)
    state_path = os.path.join(outdir, "estado.json")
    estado = {}
    if os.path.exists(state_path):
        estado = json.load(open(state_path, encoding="utf-8"))
    cola = [json.loads(l) for l in open(args.cola, encoding="utf-8") if l.strip()]

    cookies, src, mt = load_cookies()
    log(f"cookies: {len(cookies)} (fuente {src}, mtime {time.strftime('%H:%M', time.localtime(mt))})")

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
                    # Segundo fallo seguido: sesión nueva (limpia el estado del navegador)
                    nueva_sesion()
                continue
            title = ""
            try:
                title = (page.css("title::text").get() or "")[:80]
            except Exception:
                pass
            blocked = page.status in (403, 503) or re.search(r"Un momento|Just a moment|Security check|Attention Required", title, re.I) or (page.status == 200 and not page.css("h1"))
            if not blocked:
                return page
            log(f"[bloqueo] ({page.status}) {title} — refresco cookies y enfrío (intento {intento}/{max_tries})")
            if intento == 1:
                avisar_throttled("⚠️ CRV · Scrapling-RYM encontró el muro de RYM. Refresco cookies y enfrío; si persiste, abre RYM un momento en tu Firefox para renovar cf_clearance.")
            time.sleep(random.uniform(90, 240))
            nueva_sesion()
        return None

    def procesar(items, fase, total_fase):
        hechos = 0
        fallos_seguidos = 0
        for kind, href, row in items:
            if args.limit and hechos >= args.limit:
                return hechos
            url = "https://rateyourmusic.com" + href
            page = fetch_una(url)
            if page is None:
                fallos_seguidos += 1
                log(f"[fallo] {href}: bloqueo persistente ({fallos_seguidos} seguidos)")
                if fallos_seguidos >= 5:
                    # Cortacircuitos: muro sostenido -> espera paciente con sondas cada ~20 min
                    # (refresca cookies en cada sonda; NO quema la cola saltando ítems).
                    log("[muro] sostenido: modo espera paciente (sondas cada ~20 min)")
                    avisar_throttled("⚠️ CRV · Scrapling-RYM: RYM sostiene el muro. Quedo en espera paciente; si puedes, resuelve el captcha en el Firefox del marionette para refrescar la sesión compartida.")
                    while True:
                        time.sleep(random.uniform(900, 1500))
                        page = fetch_una(url, max_tries=2)
                        if page is not None:
                            log("[muro] cedió: reanudo la cola")
                            avisar_throttled("▶️ CRV · Scrapling-RYM: el muro cedió; reanudé la captura.", min_gap=0)
                            fallos_seguidos = 0
                            break
                continue
            fallos_seguidos = 0
            try:
                rec = ext_artist(page) if kind == "artist" else ext_release(page)
                html = page.html_content or ""
            except Exception as exc:
                log(f"[parse-err] {href}: {str(exc)[:100]}")
                continue
            if rec.get("wall") or (kind == "artist" and not rec.get("name")):
                log(f"[muro-en-pagina] {href}: reintento tras enfriar")
                avisar(f"⚠️ CRV · Scrapling-RYM: página-muro en {href}. Si se repite, abre RYM en tu Firefox.")
                time.sleep(random.uniform(120, 300))
                page = fetch_una(url)
                if page is None:
                    continue
                rec = ext_artist(page) if kind == "artist" else ext_release(page)
                html = page.html_content or ""
                if rec.get("wall") or (kind == "artist" and not rec.get("name")):
                    log(f"[muro-persistente] {href}: se deja pendiente")
                    continue
            guardar_pagina(pages_dir, kind, href, rec, html)
            estado[href] = recortar(rec)
            json.dump(estado, open(state_path, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
            e = estado[href]
            hechos += 1
            log(f"+ [{kind}] {href} -> {e['name']} | rel {e['nRows']} | gen {e['nGen']} | og {bool(e.get('og'))} | pistas {e.get('nTracks',0)} | cred {e.get('nCredits',0)} ({hechos}/{total_fase})")
            escribir_tablero(outdir, estado, cola)
            p = random.uniform(args.base_min, args.base_max)
            if random.random() < 0.06:
                p += random.uniform(15, 40)
            if hechos % 40 == 0:
                p += random.uniform(30, 60)
                log(f"[pausa] descanso de {p:.0f}s tras {hechos} ítems de la fase {fase}")
            time.sleep(p)
        return hechos

    escribir_tablero(outdir, estado, cola, "arrancando")
    nueva_sesion()
    log(f"scrapling-rym listo: cola {len(cola)} | fase {args.phase}")

    if args.phase in ("artists", "both"):
        pendientes = [("artist", norm_href(r["rymHref"]), r) for r in cola
                      if norm_href(r["rymHref"]) and not es_ok_artista(estado.get(norm_href(r["rymHref"])) or {})]
        random.shuffle(pendientes)
        log(f"fase 1 (fichas): {len(pendientes)} artistas por capturar")
        procesar(pendientes, 1, len(pendientes))
        log("FASE 1 TERMINADA (fichas)")
        escribir_tablero(outdir, estado, cola, "fase 1 terminada")
        avisar("ℹ️ CRV · Scrapling-RYM: FASE 1 terminada (fichas de artista capturadas).")
        if args.limit:
            log("--limit usado: no se encadenan los discos")
            return

    if args.phase in ("releases", "both"):
        releases = construir_releases(cola, pages_dir, estado)
        random.shuffle(releases)
        log(f"fase 2 (discos): {len(releases)} fichas por capturar")
        procesar(releases, 2, len(releases))
        log("COLA TERMINADA")
        escribir_tablero(outdir, estado, cola, "COLA TERMINADA")
        avisar("✅ CRV · Scrapling-RYM: COLA TERMINADA — artistas y discos capturados.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("interrumpido", flush=True)
