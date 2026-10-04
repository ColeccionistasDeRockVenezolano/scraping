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
_ULTIMO_MURO = {"cf": False, "ts": 0.0}


def avisar_throttled(msg, min_gap=900, clave="gen"):
    """Avisos de bloqueo con anti-spam (1 cada min_gap segundos por clave)."""
    if time.time() - _LAST_AVISO.get(clave, 0.0) >= min_gap:
        _LAST_AVISO[clave] = time.time()
        avisar(msg)


def load_cookies():
    """Lee las cookies de RYM del perfil de Firefox más fresco (copia inmune a locks).

    Preferencia: el perfil del dueño (canónico). /tmp/rym-prof solo gana si su sqlite
    es >15 min más fresco — así no se elige su copia con sesión caducada solo porque
    el marionette tocó el archivo al arrancar (403 al primer fetch, visto 17:26)."""
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
    # ¿stub? página de artista servida completa pero SIN discografía NI foto en RYM
    # (verificado en vivo: #discography vacío en el HTML, 0 enlaces a /release/). No hay más que capturar.
    rec["sinDiscografia"] = bool(
        rec.get("name") and not rec.get("wall") and page.css("#discography")
        and not page.css('a[href*="/release/"]') and not rec.get("photo")
    )
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
    # ¿fantasma? página servida 200 pero SIN datos en origen (sin og, sin pistas, sin
    # géneros, con nombre): entradas vacías/caídas de RYM — no hay nada más que capturar.
    rec["sinDatos"] = bool(
        rec.get("name") and not rec.get("wall")
        and not rec.get("og") and not rec.get("tracks") and not rec.get("genres")
    )
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
            "at": time.strftime("%H:%M:%S"), "v": rec.get("v"), "src": "scrapling",
            "sinDiscografia": bool(rec.get("sinDiscografia")),
            "sinDatos": bool(rec.get("sinDatos"))}


def es_ok_artista(e):
    return bool(e.get("v") == EXTRACTOR_V and e.get("name") and not e.get("wall"))


def es_ok_release(e):
    return bool(e.get("v") == EXTRACTOR_V and (e.get("name") or e.get("og")) and (e.get("og") or e.get("nTracks", 0) or e.get("nGen", 0)))


def _tab_epoch(hms):
    """Epoch de un 'HH:MM:SS' de hoy; si cae en el futuro (>30 s), es de ayer."""
    try:
        h, m, s = (int(x) for x in hms.split(":"))
        t = time.localtime()
        e = int(time.mktime((t.tm_year, t.tm_mon, t.tm_mday, h, m, s, 0, 0, -1)))
        return e - 86400 if e > time.time() + 30 else e
    except Exception:
        return 0


def _tab_hace(ts):
    if not ts:
        return "—"
    d = int(max(0, time.time() - ts))
    if d < 60:
        return f"hace {d} s"
    if d < 3600:
        return f"hace {d // 60} min"
    return f"hace {d // 3600} h {(d % 3600) // 60} min"


def _tab_mm(ts):
    try:
        return time.strftime("%H:%M", time.localtime(ts))
    except Exception:
        return "—"


def _tab_tail(path, nbytes=300000):
    """Últimos nbytes de un archivo en texto (sin explotar si no existe)."""
    try:
        with open(path, "rb") as f:
            f.seek(0, 2)
            size = f.tell()
            f.seek(max(0, size - nbytes))
            data = f.read().decode("utf-8", "ignore")
        if size > nbytes:
            data = data.split("\n", 1)[-1]
        return data
    except Exception:
        return ""


def _tab_datos():
    """Datos del log, supervisor y avisos para el tablero — nunca lanza."""
    now = time.time()
    d = {"bloq15": 0, "bloq_ult": None, "ev": None, "ult_ts": 0, "run_start": 0,
         "cookies": None, "cookies_live": None, "caps_ts": [], "clicker": None,
         "fase2_total": None, "sup_arranque": None, "sup_relanzos": 0,
         "sup_ult": None, "latido_ts": 0, "telegram": [],
         "fase1_mark": os.path.exists("/tmp/crv-scrapling-fase1mark")}
    try:
        for ln in _tab_tail(os.path.join(REPO, "reports", "scrapling-nuevos.log"), 1500000).splitlines():
            m = re.match(r"\[(\d{2}:\d{2}:\d{2})\]\s+\+ \[(artist|release)\] (.+) \((\d+)/(\d+)\)\s*$", ln)
            if m:
                nm = m.group(3).split(" -> ", 1)[-1].split(" | ", 1)[0]
                d["ev"] = {"t": m.group(1), "kind": m.group(2), "name": nm,
                           "n": int(m.group(4)), "tot": int(m.group(5))}
                d["ult_ts"] = _tab_epoch(m.group(1))
                d["caps_ts"].append(d["ult_ts"])
            m = re.match(r"\[(\d{2}:\d{2}:\d{2})\] \[bloqueo\] \((\d+)\) ([^-—]+)", ln)
            if m:
                be = _tab_epoch(m.group(1))
                if 0 < now - be <= 900:
                    d["bloq15"] += 1
                d["bloq_ult"] = {"ts": be, "status": int(m.group(2)), "title": m.group(3).strip()[:60]}
            m = re.search(r"cookies: (\d+) \(fuente (\S+), mtime (\d{2}:\d{2})\)", ln)
            if m:
                d["cookies"] = {"n": m.group(1), "src": m.group(2), "mt": m.group(3)}
            m = re.match(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] wrapper: arrancando", ln)
            if m:
                try:
                    d["run_start"] = int(time.mktime(time.strptime(m.group(1), "%Y-%m-%d %H:%M:%S")))
                except Exception:
                    pass
            m = re.search(r"fase 2 \(discos\): (\d+) fichas", ln)
            if m:
                d["fase2_total"] = int(m.group(1))
    except Exception:
        pass
    try:
        best = None
        for cand in ("/home/brian/.mozilla/firefox/d4qtp99b.default-esr", "/tmp/rym-prof"):
            p = os.path.join(cand, "cookies.sqlite")
            try:
                mt = os.path.getmtime(p)
            except Exception:
                continue
            if best is None or mt > best[1]:
                best = (cand, mt)
        if best:
            d["cookies_live"] = {"src": os.path.basename(best[0]), "mt": _tab_mm(best[1])}
    except Exception:
        pass
    try:
        with open(os.path.join(REPO, "reports", "crv-marcas", "clicker-ep"), encoding="utf-8") as f:
            d["clicker"] = int(json.loads(f.read()).get("clics", 0))
    except Exception:
        pass
    try:
        for ln in _tab_tail(os.path.join(REPO, "reports", "scrapling-nuevos-supervisor.log"), 120000).splitlines():
            m = re.match(r"\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] supervisor", ln)
            if m:
                d["sup_arranque"] = m.group(1)[11:16]
            if "relanzo" in ln:
                d["sup_relanzos"] += 1
            if ln.strip():
                d["sup_ult"] = ln.strip()[:200]
    except Exception:
        pass
    try:
        d["latido_ts"] = int(os.path.getmtime(os.path.join(REPO, "reports", "crv-super-nuevos.latido")))
    except Exception:
        pass
    try:
        tg = [l for l in _tab_tail(os.path.join(REPO, "reports", "telegram-avisos-nuevos.log"), 30000).splitlines() if l.strip()]
        d["telegram"] = tg[-5:][::-1]
    except Exception:
        pass
    return d


def tablero_html(estado, cola, nota):
    """Tablero v2: métricas globales, salud (supervisor/sesión/muros) y avisos."""
    from html import escape as esc
    now = time.time()
    tot = len(cola)
    art_ok = sum(1 for r in cola if es_ok_artista(estado.get(norm_href(r["rymHref"])) or {}))
    rels = [e for e in estado.values() if e.get("kind") == "release"]
    rel_ok = sum(1 for e in rels if es_ok_release(e))
    d = _tab_datos()
    ev = d.get("ev") or {}
    pct = (art_ok * 100 // tot) if tot else 0
    faltan = max(0, tot - art_ok)
    edad = int(now - d["ult_ts"]) if d.get("ult_ts") else None

    rate = None
    ct = (d.get("caps_ts") or [])[-150:]
    if len(ct) >= 30 and ct[-1] - ct[0] >= 120:
        rate = (len(ct) - 1) / max((ct[-1] - ct[0]) / 60.0, 0.3)
    if rate is None and d.get("run_start") and ev.get("n") and now > d["run_start"] + 30:
        rate = ev["n"] / max((now - d["run_start"]) / 60.0, 0.3)
    rem = (ev.get("tot", 0) - ev.get("n", 0)) if ev else None
    eta = None
    eta_txt = None
    if rate and rem and rem > 0:
        eta = now + (rem / max(rate, 0.1)) * 60
        seg = eta - now
        eta_txt = (_tab_mm(eta) if seg <= 43200
                   else f"~{seg / 3600:.0f} h ({time.strftime('%a', time.localtime(eta))})")

    if "COLA TERMINADA" in nota:
        pcls, ptxt = "done", "✅ COLA TERMINADA"
    elif edad is not None and edad > 900:
        pcls, ptxt = "warn", "⚠️ sin capturas " + _tab_hace(d["ult_ts"])
    elif "fase 1 terminada" in nota and ev.get("kind") != "release":
        pcls, ptxt = "run", "🟡 fase 1 terminada — preparando la cola de discos"
    elif ev:
        pcls, ptxt = "run", ("🟢 fase 2 en marcha" if ev.get("kind") == "release" else "🟢 fase 1 en marcha")
    else:
        pcls, ptxt = "run", "🟢 " + esc(nota)

    bq = d.get("bloq_ult") or {}
    bq_rec = bool(bq) and (now - bq.get("ts", 0)) <= 3600
    bq_cf = bq_rec and (bq.get("status") in (403, 503) or
                        bool(re.search(r"Un momento|Just a moment|Attention Required|Security check",
                                       bq.get("title", ""), re.I)))
    hace_ult = (f'<span class="ago" data-t="{d["ult_ts"]}">{_tab_hace(d["ult_ts"])}</span>'
                if d.get("ult_ts") else "—")
    banner = ""
    if "COLA TERMINADA" not in nota and (edad is None or edad > 360):
        if bq_cf:
            ctxt = (f' Cliquer: {d["clicker"]} clics en tu Firefox.' if d.get("clicker")
                    else ' El cliquer hará clics en tu Firefox para renovar la sesión.')
            banner = (f'<div class="banner cf"><b>🟠 Muro de Cloudflare.</b> '
                      f'Sin capturas {hace_ult}.{ctxt} Sin acción tuya — si cede, lo verás aquí.</div>')
        elif bq_rec:
            banner = (f'<div class="banner soft"><b>🟡 Muro suave de RYM.</b> Auto-recupera con enfriamiento '
                      f'y reintentos; sin acción tuya. Sin capturas {hace_ult}.</div>')
        else:
            banner = (f'<div class="banner wait"><b>⏳ Sin capturas {hace_ult}.</b> Reintentando/enfriando; '
                      f'el supervisor avisa por Telegram si se alarga.</div>')

    def card(titulo, cuerpo, sub="", barra=None, cls=""):
        b = f'<div class="bar"><i style="width:{barra}%"></i></div>' if barra is not None else ""
        return (f'<div class="card {cls}"><h3>{titulo}</h3><div class="big">{cuerpo}</div>{b}'
                f'<div class="sub">{sub}</div></div>')

    c_art = card("Artistas (fase 1)", f"{art_ok} / {tot}", f"faltan {faltan} · {pct} %", barra=pct)
    if d.get("fase2_total"):
        bp2 = int(rel_ok * 100 / max(d["fase2_total"], 1))
        c_dis = card("Discos (fase 2)", f"{rel_ok} / {d['fase2_total']}", f"{bp2} % de la cola de discos", barra=bp2)
    else:
        c_dis = card("Discos (fase 2)", "—", f"arranca al cerrar la fase 1 · faltan {faltan} artistas")
    c_rit = card("Ritmo", (f"~{rate:.1f}/min" if rate else "—"),
                 ((f"{ev.get('n')}/{ev.get('tot')} esta corrida" +
                   (f" · desde {_tab_mm(d['run_start'])}" if d.get("run_start") else "")) if ev else "sin datos todavía"))
    c_eta = card("ETA fase en curso", (eta_txt or "—"), (f"faltan ≈{rem} ítems de la fase" if rem else "—"))
    if ev:
        c_ult = card("Última captura", esc(ev["name"][:26]),
                     f'<span class="ago" data-t="{d["ult_ts"]}">{_tab_hace(d["ult_ts"])}</span> · {ev["kind"]}')
    else:
        c_ult = card("Última captura", "—", "sin capturas en el log")
    if "COLA TERMINADA" not in nota and edad is not None and edad > 360 and bq_cf:
        mur_big = "🔴 CF activo"
    elif "COLA TERMINADA" not in nota and edad is not None and edad > 360 and bq_rec:
        mur_big = "🟡 suave (auto)"
    else:
        mur_big = "sin muro"
    mur_sub = (f"{d['bloq15']} en 15 min" +
               (f" · último {_tab_hace(d['bloq_ult']['ts'])}" if d.get("bloq_ult") else ""))
    if d.get("clicker") is not None:
        mur_sub += f" · 🛠️ cliquer: {d['clicker']} clics"
    c_mur = card("Muro", mur_big, mur_sub, cls=("warn" if mur_big.startswith("🔴") else ""))
    ck = d.get("cookies")
    ckl = d.get("cookies_live")
    if ck:
        src = os.path.basename(ck["src"].rstrip("/")) or ck["src"]
        extra = f" · archivo al {esc(ckl['mt'])}" if ckl else ""
        c_ses = card("Sesión (cookies)", "OK",
                     f"{esc(src)} · {ck['n']} cookies · cargada {esc(ck['mt'])}{extra}")
    elif ckl:
        c_ses = card("Sesión (cookies)", "OK", f"archivo más fresco: {esc(ckl['src'])} · {esc(ckl['mt'])}")
    else:
        c_ses = card("Sesión (cookies)", "—", "sin dato")
    lat = d.get("latido_ts") or 0
    if lat and now - lat < 420:
        sup_big, sup_sub = "🟢 activo", f'latido <span class="ago" data-t="{lat}">{_tab_hace(lat)}</span>'
    elif lat:
        sup_big, sup_sub = "⚠️ sin latido reciente", f'último latido <span class="ago" data-t="{lat}">{_tab_hace(lat)}</span>'
    else:
        sup_big, sup_sub = "— sin latido", "supervisor v2 sin instalar o caído"
    sup_sub += (f" · arrancó {esc(d['sup_arranque'] or '—')} · relanzos {d['sup_relanzos']}" +
                (" · fase 1 ✓" if d.get("fase1_mark") else "") +
                f'<div class="mono">{esc(d.get("sup_ult") or "—")}</div>')
    c_sup = card("Supervisor", sup_big, sup_sub, cls=("warn" if (not lat or now - lat >= 420) else ""))
    tg_html = ("".join(f'<div class="tg">{esc(l[:150])}</div>' for l in d["telegram"]) or
               '<div class="tg dim">(sin avisos del supervisor todavía)</div>')
    c_tg = (f'<div class="card wide"><h3>Avisos Telegram (supervisor)</h3>{tg_html}'
            '<div class="sub">Hitos fase 1 (25/50/75 %) · resumen cada 2 h · atascos · relanzos · cierre.</div></div>')

    ufilas = []
    for href, e in list(estado.items())[-9:][::-1]:
        t = e.get("at") or ""
        et = _tab_epoch(t) if t else 0
        kind = "disco" if e.get("kind") == "release" else "artista"
        ufilas.append(f'<tr><td>{esc(str(e.get("name") or href))}</td><td>{kind}</td>'
                      f'<td><span class="ago" data-t="{et}">{esc(t)}</span></td></tr>')

    filas = []
    for r in cola:
        href = norm_href(r["rymHref"])
        e = estado.get(href) or {}
        ok = es_ok_artista(e)
        nm = r["name"] or href
        link = f'<a href="https://rateyourmusic.com{href}" target="_blank">{esc(nm)}</a>'
        if ok:
            marca = f'<span class="oktag">✓</span> rel {e.get("nRows", 0)} · gen {e.get("nGen", 0)}'
            hora = e.get("at") or ""
        else:
            marca, hora = '<span class="pendtag">pendiente</span>', ""
        filas.append(f'<tr class="{"completa" if ok else "parcial"}" data-n="{esc(str(nm).lower(), quote=True)}">'
                     f'<td>{link}</td><td>{marca}</td><td class="h">{hora}</td></tr>')

    css = ("*{box-sizing:border-box}"
           "body{font:13.5px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;background:#0e1116;color:#e6e9ee;margin:0;padding:18px 20px 40px}"
           "a{color:#6cb6ff;text-decoration:none}a:hover{text-decoration:underline}"
           ".hdr{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;margin-bottom:14px}"
           ".hdr h1{font-size:17px;margin:0;font-weight:700}"
           ".pill{padding:3px 11px;border-radius:99px;font-size:12px;font-weight:600;white-space:nowrap}"
           ".pill.run{background:#0f2f1c;color:#4ade80;border:1px solid #1f6f3f}"
           ".pill.warn{background:#3a2b10;color:#fbbf24;border:1px solid #7a5b1a}"
           ".pill.done{background:#0f2b3a;color:#67b7ff;border:1px solid #1f4f7a}"
           ".banner{margin:0 0 12px;padding:9px 13px;border-radius:9px;border:1px solid;font-size:13px;line-height:1.45}"
           ".banner.cf{background:#3a1414;border-color:#8f2b2b;color:#ffc2c2}"
           ".banner.soft{background:#33280d;border-color:#8a6a1a;color:#fbd98a}"
           ".banner.wait{background:#1b222c;border-color:#2c3644;color:#c8d1dc}"
           ".banner b{font-weight:700}"
           ".upd{margin-left:auto;color:#8b98a9;font-size:12px}"
           ".grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px;margin-bottom:2px}"
           ".card{background:#151a21;border:1px solid #232b36;border-radius:10px;padding:11px 13px}"
           ".card.warn{border-color:#7a5b1a}"
           ".card.wide{grid-column:1/-1}"
           ".card h3{margin:0 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:#8b98a9;font-weight:600}"
           ".big{font-size:21px;font-weight:700}"
           ".sub{color:#8b98a9;font-size:11.5px;margin-top:5px}.sub .ago{color:#c8d1dc}"
           ".bar{height:6px;background:#232b36;border-radius:4px;overflow:hidden;margin-top:8px}"
           ".bar i{display:block;height:100%;background:linear-gradient(90deg,#2f81f7,#3fb950);border-radius:4px}"
           ".mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;color:#9aa7b6;margin-top:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}"
           ".tg{font-family:ui-monospace,monospace;font-size:11.5px;color:#c8d1dc;padding:2px 0;border-bottom:1px dashed #232b36}"
           ".tg:last-of-type{border-bottom:0}"
           ".dim{color:#8b98a9}"
           "table{width:100%;border-collapse:collapse}.card table th{text-align:left;color:#aab6c4;font-weight:600}"
           "#tbl{font-size:12.5px}"
           "#tbl th{position:sticky;top:0;background:#1b222c;color:#aab6c4;font-weight:600;text-align:left;z-index:1}"
           "#tbl th,#tbl td{border:1px solid #232b36;padding:3px 8px}"
           "#tbl tr:hover td{background:#1a2029}"
           "#tbl tr.completa td{background:#0f1a13}"
           "#tbl tr.completa:hover td{background:#15251b}"
           "#tbl tr.parcial td{background:#191713}"
           "#tbl tr.parcial:hover td{background:#211e18}"
           ".oktag{color:#4ade80;font-weight:700}.pendtag{color:#fbbf24}"
           ".h{color:#8b98a9;font-size:11px;white-space:nowrap}"
           ".fbar{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:14px 0 8px}"
           ".fbtn{background:#1b222c;color:#c8d1dc;border:1px solid #2c3644;border-radius:7px;padding:4px 11px;font-size:12px;cursor:pointer}"
           ".fbtn.on{background:#22304a;border-color:#3b5b8f;color:#dfe9ff}"
           ".fbtn:hover{border-color:#3b5b8f}"
           "#q{background:#12171e;border:1px solid #2c3644;border-radius:7px;color:#e6e9ee;padding:5px 10px;font-size:12.5px;min-width:200px}"
           "h2{font-size:13px;margin:18px 0 8px;color:#aab6c4;font-weight:600}"
           "#wrap{max-height:72vh;overflow:auto;border:1px solid #232b36;border-radius:10px}")
    js = ("(function(){"
          "function hace(el){var t=+el.getAttribute('data-t');if(!t){el.textContent='—';return;}"
          "var d=Math.floor(Date.now()/1000)-t;var s;"
          "if(d<2){s='ahora';}else if(d<60){s='hace '+d+' s';}"
          "else if(d<3600){s='hace '+Math.floor(d/60)+' min';}"
          "else{s='hace '+Math.floor(d/3600)+' h '+Math.floor((d%3600)/60)+' min';}el.textContent=s;}"
          "function tick(){var els=document.querySelectorAll('.ago[data-t]');for(var i=0;i<els.length;i++){hace(els[i]);}}"
          "tick();setInterval(tick,1000);"
          "var rows=Array.prototype.slice.call(document.querySelectorAll('#tbl tbody tr'));"
          "var inp=document.getElementById('q'),cnt=document.getElementById('cnt'),filt='all';"
          "var btns=Array.prototype.slice.call(document.querySelectorAll('.fbtn'));"
          "function apply(){var q=(inp&&inp.value?inp.value:'').toLowerCase();var n=0;"
          "for(var i=0;i<rows.length;i++){var r=rows[i];var ok=r.className.indexOf('completa')>=0;"
          "var vis=(filt==='all')||(filt==='ok'&&ok)||(filt==='pend'&&!ok);"
          "if(vis&&q){var nm=(r.getAttribute('data-n')||'');vis=nm.indexOf(q)>=0;}"
          "r.style.display=vis?'':'none';if(vis)n++;}"
          "if(cnt)cnt.textContent=n+' de '+rows.length;}"
          "for(var i=0;i<btns.length;i++){(function(b){b.addEventListener('click',function(){"
          "filt=b.getAttribute('data-f');for(var j=0;j<btns.length;j++){btns[j].className=(btns[j]===b)?'fbtn on':'fbtn';}apply();});})(btns[i]);}"
          "if(inp)inp.addEventListener('input',apply);apply();})();")

    return ("<!doctype html><html lang=\"es\"><head><meta charset=\"utf-8\">"
            "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">"
            "<meta http-equiv=\"refresh\" content=\"10\">"
            "<title>CRV · «nuevos» — captura RYM</title>"
            f"<style>{css}</style></head><body>"
            f'<div class="hdr"><h1>CRV · «nuevos» — captura RYM</h1><span class="pill {pcls}">{ptxt}</span>'
            f'<span class="upd">Actualizado <span class="ago" data-t="{int(now)}">{time.strftime("%H:%M:%S")}</span> · auto-refresco 10 s</span></div>'
            + banner
            + '<div class="grid">' + c_art + c_dis + c_rit + c_eta + c_ult + c_mur + c_ses + c_sup + c_tg + '</div>'
            + '<h2>Últimas capturas</h2><div class="card"><table><tr><th>Nombre</th><th>Tipo</th><th>Hace</th></tr>'
            + "".join(ufilas) + '</table></div>'
            + f'<h2>Cola completa — artistas ({tot})</h2>'
            + f'<div class="fbar"><button class="fbtn on" data-f="all">Todas ({tot})</button>'
            + f'<button class="fbtn" data-f="ok">Capturadas ({art_ok})</button>'
            + f'<button class="fbtn" data-f="pend">Pendientes ({faltan})</button>'
            + '<input id="q" placeholder="filtrar por nombre…" ><span id="cnt" class="dim"></span></div>'
            + '<div id="wrap"><table id="tbl"><thead><tr><th>Artista</th><th>Estado</th><th>Hora</th></tr></thead><tbody>'
            + "".join(filas) + '</tbody></table></div>'
            + f"<script>{js}</script></body></html>")


def escribir_tablero(outdir, estado, cola, nota="en marcha"):
    html = tablero_html(estado, cola, nota)
    for p in (os.path.join(outdir, "tablero.html"), "/tmp/crv-recon/rym-nuevos-tablero.html"):
        try:
            os.makedirs(os.path.dirname(p), exist_ok=True)
            tmp = p + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                f.write(html)
            os.replace(tmp, p)
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
    ap.add_argument("--prioridad", default="", help="archivo con hrefs de artistas (uno por línea) cuyos discos van primero")
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
            blocked = page.status in (403, 503) or re.search(r"Un momento|Just a moment|Security check|Attention Required", title, re.I)
            if not blocked:
                return page
            log(f"[bloqueo] ({page.status}) {title} — refresco cookies y enfrío (intento {intento}/{max_tries})")
            tipo_cf = page.status == 403 or bool(re.search(r"Un momento|Just a moment|Attention Required", title, re.I))
            _ULTIMO_MURO["cf"] = tipo_cf
            _ULTIMO_MURO["ts"] = time.time()
            if intento == 1:
                if tipo_cf:
                    avisar_throttled("🔒 CRV · «nuevos»: muro de Cloudflare («Un momento…» = sesión vencida). Reintentar NO lo destraba: abre rateyourmusic.com en tu Firefox ~30 s. Nada se pierde (los ítems quedan pendientes).", min_gap=3600, clave="cf")
                else:
                    avisar_throttled("🟡 CRV · «nuevos»: muro suave de RYM (503). Auto-recupera con enfriamiento; sin acción tuya.", min_gap=3600, clave="soft")
            # El 503 suave de RYM suele ceder en segundos: primera espera corta; solo
            # el muro CF (necesita al dueño) o los reintentos tardíos enfrían largo.
            if not tipo_cf and intento == 1:
                time.sleep(random.uniform(15, 35))
            else:
                time.sleep(random.uniform(90, 240))
            nueva_sesion()
        return None

    def procesar(items, fase, total_fase):
        hechos = 0
        fallos_seguidos = 0
        for pos, (kind, href, row) in enumerate(items):
            if args.limit and hechos >= args.limit:
                return hechos
            url = "https://rateyourmusic.com" + href
            if not url.endswith("/"):
                url += "/"
            page = fetch_una(url)
            if page is None:
                fallos_seguidos += 1
                log(f"[fallo] {href}: bloqueo persistente ({fallos_seguidos} seguidos)")
                if fallos_seguidos >= 5:
                    # Cortacircuitos: muro sostenido -> espera paciente con sondas cada ~20 min
                    # (refresca cookies en cada sonda; no quema la cola).
                    log("[muro] sostenido: modo espera paciente (sondas cada ~20 min)")
                    if _ULTIMO_MURO.get("cf") and time.time() - _ULTIMO_MURO.get("ts", 0.0) < 3600:
                        avisar_throttled("🔒 CRV · «nuevos»: el muro de Cloudflare sigue (espera paciente, sondas ~20 min). Si aún no lo hiciste: abre rateyourmusic.com en tu Firefox ~30 s — es lo único que lo destraba.", min_gap=3600, clave="cf")
                    else:
                        avisar_throttled("🟡 CRV · «nuevos»: muro sostenido de RYM — espera paciente (~20 min entre sondas); sin acción tuya.", min_gap=3600, clave="soft")
                    ciclos = 0
                    while True:
                        time.sleep(random.uniform(900, 1500))
                        ciclos += 1
                        page = fetch_una(url, max_tries=2)
                        if page is not None:
                            log("[muro] cedió: reanudo la cola")
                            avisar_throttled("▶️ CRV · Scrapling-RYM: el muro cedió; reanudé la captura.", min_gap=0)
                            fallos_seguidos = 0
                            break
                        # ¿ítem malo o tormenta global? sonda a un vecino de la cola:
                        if ciclos >= 3 and pos + 1 < len(items):
                            _k2, href2, _r2 = items[pos + 1]
                            alt = fetch_una("https://rateyourmusic.com" + href2, max_tries=1)
                            if alt is not None:
                                log(f"[muro] hay página para otros: salto {href} (queda pendiente en esta pasada)")
                                page = None
                                break
                        if ciclos >= 12:
                            log(f"[muro] {ciclos} ciclos sin ceder: salto {href} (queda pendiente en esta pasada)")
                            page = None
                            break
                if page is None:
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
        prio = set()
        if args.prioridad and os.path.exists(args.prioridad):
            prio = {l.strip() for l in open(args.prioridad, encoding="utf-8") if l.strip()}
        if prio:
            from collections import Counter
            nrel = Counter(it[2].get("parent") for it in releases)
            def orden(it):
                parent = it[2].get("parent") or ""
                return (0 if parent in prio else 1, -nrel[parent])
            releases.sort(key=orden)
            # shuffle solo DENTRO de bloques de igual prioridad (dispersa patrones sin perder el orden de valor)
            ordenados = []
            i = 0
            while i < len(releases):
                j = i
                k = orden(releases[i])
                while j < len(releases) and orden(releases[j]) == k:
                    j += 1
                bloque = releases[i:j]
                random.shuffle(bloque)
                ordenados.extend(bloque)
                i = j
            releases = ordenados
            n_prio = sum(1 for it in releases if orden(it)[0] == 0)
            log(f"fase 2 (discos): prioridad aplicada — {n_prio} de artistas en catálogo van primero")
        else:
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
