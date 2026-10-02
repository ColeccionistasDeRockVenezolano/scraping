#!/usr/bin/env python3
"""Fase «nuevos» — captura de los artistas de RYM que NO están en el catálogo (1.591).

Mismo motor que rym-etapa3-auto.py (navegación autorizada por el propietario en SU
Firefox con marionette, pausa en captcha con tablero ▶/⏸, sin resolver captchas).

Fases:
  1) fichas de artista (nombre, géneros, formación, discografía listada) — 1.591 páginas.
  2) fichas de disco de todos esos artistas (portada, año, tracklist, créditos).
Al terminar la fase 1 imprime «FASE 1 TERMINADA (fichas)»; si se quiere parar ahí,
basta detener las unidades crv-rym-nuevos / crv-rym-nuevos-super.

Uso: python3 rym-nuevos-auto.py [--check]
"""
import json, os, random, re, socket, sys, time
from urllib.parse import unquote

HOST, PORT = "127.0.0.1", 2828
ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
OUT = os.path.join(ROOT, "data/raw/fuentes-web-2026-10-01/rym-nuevos")
PAGES = os.path.join(OUT, "pages")
STATE = os.path.join(OUT, "estado.json")
COLA = os.path.join(OUT, "cola-nuevos.jsonl")
DASH = os.path.join(OUT, "tablero.html")
DASH_TMP = "/tmp/crv-recon/rym-nuevos-tablero.html"
EXTRACTOR_V = 3
os.makedirs(PAGES, exist_ok=True)
os.makedirs("/tmp/crv-recon", exist_ok=True)


class Mar:
    def __init__(self):
        self.s = socket.create_connection((HOST, PORT), timeout=120)
        self.buf = b""
        self.mid = 0

    def _more(self):
        c = self.s.recv(65536)
        if not c:
            raise ConnectionError("marionette cerrado")
        self.buf += c

    def recv(self):
        while b":" not in self.buf:
            self._more()
        i = self.buf.index(b":")
        n = int(self.buf[:i])
        while len(self.buf) < i + 1 + n:
            self._more()
        p = self.buf[i + 1:i + 1 + n]
        self.buf = self.buf[i + 1 + n:]
        return json.loads(p.decode("utf-8"))

    def cmd(self, name, params=None):
        self.mid += 1
        pl = json.dumps([0, self.mid, name, params or {}]).encode("utf-8")
        self.s.sendall(str(len(pl)).encode() + b":" + pl)
        while True:
            msg = self.recv()
            if isinstance(msg, list) and len(msg) >= 4 and msg[1] == self.mid:
                if msg[2]:
                    raise RuntimeError(f"{name}: {msg[2]}")
                r = msg[3]
                return r["value"] if isinstance(r, dict) and set(r.keys()) == {"value"} else r

    def js(self, script):
        return self.cmd("WebDriver:ExecuteScript", {"script": script, "args": []})


JS_PAGE = r"""return JSON.stringify((function(){
 const out = {u: document.URL, t: document.title, v: 3, kind: 'artist'};
 out.name = (document.querySelector('h1')||{}).textContent ? document.querySelector('h1').textContent.trim().slice(0,120) : null;
 out.wall = /Just a moment|Attention Required|Verify you are human|Checking your browser/i.test((document.body?document.body.innerText:'').slice(0,600));
 const md = (document.querySelector('meta[name=description]')||{}).content || '';
 const fm = md.match(/formed\s+(\d{4})/i); out.formed = fm ? Number(fm[1]) : null;
 const img = document.querySelector('.section_artist_image img');
 out.photo = img ? {src: img.getAttribute('src'), cls:(img.className||'').toString()} : null;
 out.photoEsCover = img ? (/-cover-art\.(jpg|jpeg|png|webp)(\?|$)/i.test(img.getAttribute('src')||'') || !!img.closest('div[class*="coverart"]')) : null;
 out.og = (document.querySelector('meta[property="og:image"]')||{}).content || null;
 out.genres = [...new Set([...document.querySelectorAll('a[href^="/genre/"]')].map(a=>a.textContent.trim()))].slice(0,20);
 const labels = [...document.querySelectorAll('#discography .disco_header_label')];
 out.sections = labels.map(l=>l.textContent.trim());
 out.rows = [...document.querySelectorAll('#discography div.disco_release')].map(r=>{
   const ttl = r.querySelector('.disco_mainline a[href*="/release/"]') || [...r.querySelectorAll('a[href*="/release/"]')].find(a=>a.textContent.trim());
   const y = r.querySelector('[class*="disco_year"]');
   let ty = null;
   for (const l of labels) { if (l.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) ty = l.textContent.trim(); else break; }
   return {h: ttl? ttl.getAttribute('href') : null, t: ttl? ttl.textContent.trim().slice(0,140) : null, y: y? y.textContent.trim().slice(0,12) : null, ty: ty};
 }).filter(r=>r.h);
 return out;
})())"""
JS_RELEASE = r"""return JSON.stringify((function(){
 const out = {u: document.URL, t: document.title, v: 3, kind: 'release'};
 out.name = (document.querySelector('h1')||{}).textContent ? document.querySelector('h1').textContent.trim().slice(0,140) : ((document.title||'').split(/ by | \(/)[0] || '').trim().slice(0,140) || null;
 out.wall = /Just a moment|Attention Required|Verify you are human|Checking your browser/i.test((document.body?document.body.innerText:'').slice(0,600));
 out.og = (document.querySelector('meta[property="og:image"]')||{}).content || null;
 out.genres = [...new Set([...document.querySelectorAll('a[href^="/genre/"]')].map(a=>a.textContent.trim()))].slice(0,20);
 const ar = document.querySelector('.release_page_header a[href^="/artist/"], .section_release_page a[href^="/artist/"], a.artist[href^="/artist/"]');
 out.artist = ar ? ar.textContent.trim().slice(0,140) : null;
 const info = document.querySelector('.section_release_info, .release_page_header, #content');
 out.info = info ? info.innerText.replace(/\s+/g,' ').trim().slice(0,4000) : null;
 out.tracks = [...document.querySelectorAll('a[href*="/song/"]')].map(a=>{const box=a.closest('tr, li, .tracklist_track, .track, div');return {t:a.textContent.trim().slice(0,140), row:(box?box.textContent.replace(/\s+/g,' ').trim():'').slice(0,240)};}).slice(0,120);
 out.creditLinks = [...document.querySelectorAll('a[href^="/artist/"], a[href^="/person/"]')].map(a=>({h:a.getAttribute('href'), n:a.textContent.trim().slice(0,90)})).slice(0,300);
 return out;
})())"""
JS_STATUS = r"""return JSON.stringify((function(){
 const bad = [...document.querySelectorAll('iframe')].filter(function(f){
   const src=(f.getAttribute('src')||'');
   if(!/hcaptcha|captcha|challenge/i.test(src)) return false;
   const r=f.getBoundingClientRect(); const st=getComputedStyle(f);
   return r.width>60 && r.height>40 && st.display!=='none' && st.visibility!=='hidden';
 }).length>0;
 const t=document.title||''; const body=(document.body?document.body.innerText:'').slice(0,500);
 const txt=/Just a moment|Attention Required|Verify you are human|Checking your browser|unusual traffic|Security check/i.test(t+' '+body);
 return JSON.stringify({u:document.URL, t:document.title, ready:document.readyState, blocked: bad||txt});
})())"""
# Claves de localStorage PROPIAS de esta fase (no chocan con el tablero de los 222).
JS_CTRL = r"""return JSON.stringify({play: localStorage.getItem('rymNPlay'), pause: localStorage.getItem('rymNPause')})"""
JS_URL = "return JSON.stringify({u:document.URL,t:document.title})"
JS_READY = r"""return JSON.stringify({ok: (document.readyState !== 'loading') && (!!document.querySelector('h1') || /Security check|Just a moment|Attention Required/i.test(document.title||'')), wall: /Security check|Just a moment|Attention Required/i.test(document.title||''), u: document.URL, ready: document.readyState})"""


def jd(m, script):
    """Ejecuta script y devuelve dict tolerante (str/str-doble/dict/errores)."""
    try:
        raw = m.js(script)
    except Exception as exc:
        return {"_err": str(exc)[:120]}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            val = json.loads(raw)
        except Exception:
            return {"_err": "nojson:" + raw[:80]}
        if isinstance(val, dict):
            return val
        if isinstance(val, str):
            try:
                val2 = json.loads(val)
                if isinstance(val2, dict):
                    return val2
            except Exception:
                pass
        return {"_err": "tipo:" + type(val).__name__}
    return {"_err": "tipo:" + type(raw).__name__}


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


def cargar_cola():
    rows = []
    if os.path.exists(COLA):
        for line in open(COLA, encoding="utf-8"):
            if line.strip():
                rows.append(json.loads(line))
    return rows


def recortar(rec):
    rows = rec.get("rows") or []
    foto = None
    if rec.get("photo") and not rec.get("photoEsCover"):
        foto = (rec.get("photo") or {}).get("src")
    return {"name": rec.get("name"), "kind": rec.get("kind") or "artist", "nRows": len(rows),
            "nGen": len(rec.get("genres") or []), "photo": foto,
            "formed": rec.get("formed"), "og": rec.get("og"), "wall": bool(rec.get("wall")),
            "nTracks": len(rec.get("tracks") or []), "nCredits": len(rec.get("creditLinks") or []),
            "at": time.strftime("%H:%M:%S"), "v": rec.get("v")}


def es_ok_artista(e):
    return bool(e.get("v") == EXTRACTOR_V and e.get("name") and not e.get("wall"))


def es_ok_release(e):
    return bool(e.get("v") == EXTRACTOR_V and (e.get("name") or e.get("og")) and (e.get("og") or e.get("nTracks", 0) or e.get("nGen", 0)))


def guardar_pagina(kind, href, rec, html):
    slug = ("rel_" + slugify(href.replace("/release/", ""))) if kind == "release" else slugify(href)
    with open(os.path.join(PAGES, slug + ".json"), "w", encoding="utf-8") as f:
        json.dump({"href": href, "rec": rec, "capturedAt": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=1)
    if isinstance(html, str) and len(html) > 3000:
        with open(os.path.join(PAGES, slug + ".html"), "w", encoding="utf-8") as f:
            f.write(html)
    return slug


def escribir_tablero(estado, bloqueado=False, pausado=False, actual=None, nota=None):
    cola = cargar_cola()
    hechas = sum(1 for row in cola if es_ok_artista(estado.get(norm_href(row["rymHref"])) or {}))
    filas = []
    for row in cola:
        href = norm_href(row["rymHref"])
        e = estado.get(href) or {}
        ok = es_ok_artista(e)
        if ok:
            marca = f'<span class="ok">&#10003;</span> gen {e.get("nGen", 0)} | rel {e.get("nRows", 0)}'
            nombre = row["name"]
        else:
            marca = "&#8226; pendiente"
            nombre = f'<a href="https://rateyourmusic.com{href}" target="_blank">{row["name"]}</a>'
        if e.get("wall"):
            marca += ' <span class="warn">muro</span>'
        filas.append(f'<tr class="{"completa" if ok else "parcial"}"><td>{nombre}</td><td>{row.get("nlocs", "")}</td><td>{marca}</td></tr>')
    total_rel = sum(1 for e in estado.values() if e.get("kind") == "release" and e.get("og"))

    if bloqueado:
        banner = ('<div class="alerta">BLOQUEO POR DETECTOR DE BOTS &#9888; Resuelve el captcha en la otra pestaña '
                  'y pulsa <b>&#9654; Continuar</b>.</div>')
    elif pausado:
        banner = '<div class="pausa">PAUSADO &#9208; Pulsa <b>&#9654; Continuar</b> para reanudar.</div>'
    else:
        banner = '<div class="okbar">Autom&#225;tico en marcha &#9881; (pulsa PAUSA para tomar el control).</div>'

    html = ("<!doctype html><meta charset=\"utf-8\"><title>" + ("\u26a0 CAPTCHA - resuelve y pulsa PLAY - RYM nuevos" if bloqueado else "RYM nuevos - control") + "</title>\n"
            "<meta http-equiv=\"refresh\" content=\"8\">\n"
            "<style>body{font:14px system-ui;background:#111;color:#eee;margin:16px}table{border-collapse:collapse;width:100%;margin-bottom:16px}\n"
            "td,th{border:1px solid #333;padding:3px 8px}th{background:#1e1e1e;position:sticky;top:0}\n"
            "a{color:#7fd1ff}b{color:#7CFC98}.ok{color:#7CFC98;font-weight:700}.warn{color:#ffd479}\n"
            ".parcial td{background:#2b270f}.completa td{background:#12301a}\n"
            ".alerta{background:#5a1010;border:2px solid #ff5252;padding:12px;margin:10px 0;font-size:15px;border-radius:6px}\n"
            ".pausa{background:#4a3a10;border:2px solid #ffd479;padding:12px;margin:10px 0;border-radius:6px}\n"
            ".okbar{background:#123a18;border:1px solid #2e7d32;padding:10px;margin:10px 0;border-radius:6px}\n"
            "button.big{font-size:20px;padding:12px 26px;margin:6px 8px 6px 0;border-radius:8px;border:0;cursor:pointer;background:#2e7d32;color:#fff;font-weight:700}\n"
            "button.big.pause{background:#8a6d00}\n"
            ".meta{color:#9aa;font-size:12px}\n"
            "</style>\n"
            "<script>\n"
            "function ctrl(k){try{localStorage.setItem(k,''+Date.now());}catch(e){var p=document.getElementById('fb');p.textContent='localStorage bloqueado: '+e;} }\n"
            "window.addEventListener('load',function(){try{var p=localStorage.getItem('rymNPlay')||'-';var q=localStorage.getItem('rymNPause')||'-';document.getElementById('st').textContent='play: '+p+' | pause: '+q;}catch(e){}});\n"
            "</script>\n"
            f"{banner}\n"
            f"<p>Artistas <b>{hechas}</b>/{len(cola)} capturados &middot; fichas de disco con portada <b>{total_rel}</b> &middot; {('leyendo ahora: <b>'+actual+'</b>') if actual else ''}</p>\n"
            f"<p>{nota or ''} <span class='meta' id='st'></span></p>\n"
            "<p><button class='big' onclick=\"ctrl('rymNPlay')\">&#9654; Continuar</button>"
            "<button class='big pause' onclick=\"ctrl('rymNPause')\">&#9208; Pausa</button>"
            "<button class='big' onclick=\"try{location.reload()}catch(e){}\">&#8635; Refrescar</button></p>\n"
            "<table><tr><th>Artista</th><th>Ubicaciones</th><th>Estado</th></tr>" + "\n".join(filas) + "</table>\n"
            f"<p class='meta' id='fb'></p><p class='meta'>P&#225;ginas de disco capturadas: {total_rel} &middot; estados: {len(estado)}</p>")
    for path in (DASH, DASH_TMP):
        try:
            open(path, "w", encoding="utf-8").write(html)
        except Exception as exc:
            print("aviso tablero:", exc, flush=True)


def buscar_pestana(m, url_prefix):
    for h in m.cmd("WebDriver:GetWindowHandles", {}):
        try:
            m.cmd("WebDriver:SwitchToWindow", {"handle": h})
            info = jd(m, "return JSON.stringify({u:document.URL})")
        except Exception:
            continue
        if (info.get("u") or "").startswith(url_prefix):
            return h
    return None


def asegurar_tablero(m):
    h = buscar_pestana(m, "file:///tmp/crv-recon/rym-nuevos-tablero.html")
    if h:
        m.cmd("WebDriver:SwitchToWindow", {"handle": h})
        m.cmd("WebDriver:Navigate", {"url": "file:///tmp/crv-recon/rym-nuevos-tablero.html"})
        return h
    antes = set(m.cmd("WebDriver:GetWindowHandles", {}))
    m.cmd("WebDriver:NewWindow", {"type": "tab"})
    for hh in m.cmd("WebDriver:GetWindowHandles", {}):
        if hh not in antes:
            m.cmd("WebDriver:SwitchToWindow", {"handle": hh})
            m.cmd("WebDriver:Navigate", {"url": "file:///tmp/crv-recon/rym-nuevos-tablero.html"})
            return hh
    return None


def leer_control(m, tablero_handle):
    """Devuelve (playTs, pauseTs) del tablero (0 si no hay)."""
    try:
        m.cmd("WebDriver:SwitchToWindow", {"handle": tablero_handle})
        info = jd(m, JS_CTRL)
        play = int(info.get("play") or 0)
        pause = int(info.get("pause") or 0)
        return play, pause
    except Exception:
        return 0, 0


def elegir_pestana_trabajo(m, tablero_handle):
    handles = m.cmd("WebDriver:GetWindowHandles", {})
    for h in handles:
        if h == tablero_handle:
            continue
        try:
            m.cmd("WebDriver:SwitchToWindow", {"handle": h})
            info = jd(m, "return JSON.stringify({u:document.URL})")
        except Exception:
            continue
        if "rateyourmusic.com" in (info.get("u") or ""):
            return h
    antes = set(handles)
    m.cmd("WebDriver:NewWindow", {"type": "tab"})
    for h in m.cmd("WebDriver:GetWindowHandles", {}):
        if h not in antes:
            return h
    return handles[0] if handles else None


def esperar_carga(m, timeout=45):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            st = jd(m, JS_READY)
            if st.get("ok"):
                return st
        except Exception:
            pass
        time.sleep(0.7)
    return {"ready": "timeout"}


def url_actual(m):
    """URL normalizada de la pestaña activa ('' si no se pudo leer)."""
    try:
        return norm_href(jd(m, JS_URL).get("u") or "")
    except Exception:
        return ""


def click_js(href):
    """JS que pulsa el enlace del disco DESDE la página del artista."""
    return ('return (function(){var tgt=' + json.dumps(href) +
            ';function dec(s){try{return decodeURIComponent(s)}catch(e){return s}}'
            ';function nrm(s){s=dec(String(s||"")).split("?")[0].split("#")[0];'
            's=s.replace(/^https?:\\/\\/rateyourmusic\\.com/,"");return s.replace(/\\/$/,"")}'
            ';var t=nrm(tgt);'
            ';var a=[...document.querySelectorAll("#discography a[href]")].find(function(x){return nrm(x.getAttribute("href"))===t})'
            '||[...document.querySelectorAll("a[href]")].find(function(x){return nrm(x.getAttribute("href"))===t});'
            'if(!a)return "no";a.click();return "ok"})()')


def pausa_humana(i):
    p = random.uniform(5, 9)
    if random.random() < 0.08:
        p += random.uniform(20, 60)
    if (i + 1) % 30 == 0:
        p += random.uniform(40, 90)
        print(f"[pausa] descanso humano de {p:.0f}s tras {i + 1} ítems", flush=True)
    time.sleep(p)


def correr(cola_trabajo, m, tablero, trabajo, estado):
    """Procesa una lista de (kind, href, row) con el handshake de pausa/captcha."""
    _k = {"lastPlay": 0, "lastPause": 0, "blocked": False}
    pausado = False
    i = 0
    nav_errs = 0
    while i < len(cola_trabajo):
        kind, href, row = cola_trabajo[i]
        play, pause = leer_control(m, tablero) if tablero else (0, 0)
        if play > _k["lastPlay"]:
            _k["lastPlay"] = play
            _k["blocked"] = False
            pausado = False
        if pause > _k["lastPause"]:
            _k["lastPause"] = pause
            if pause > play and not pausado:
                print("[ctrl] pausa pedida por el tablero", flush=True)
                pausado = True
                escribir_tablero(estado, pausado=True, actual=row.get("name") or href)
        while pausado:
            time.sleep(3)
            play, pause = leer_control(m, tablero) if tablero else (0, 0)
            if play > _k["lastPlay"]:
                _k["lastPlay"] = play
                pausado = False
                _k["blocked"] = False
                print("[ctrl] play: reanudo", flush=True)
                break
        url = "https://rateyourmusic.com" + href
        parent = None
        try:
            m.cmd("WebDriver:SwitchToWindow", {"handle": trabajo})
            if kind == "release":
                parent = (row or {}).get("parent")
                if not parent:
                    print(f"[release-sin-padre] {href}", flush=True)
                    i += 1
                    continue
                cur = url_actual(m)
                if cur != parent:
                    try:
                        m.cmd("WebDriver:Back", {})
                    except Exception:
                        pass
                    time.sleep(0.8)
                    cur = url_actual(m)
                    if cur != parent:
                        m.cmd("WebDriver:Navigate", {"url": "https://rateyourmusic.com" + parent})
                    esperar_carga(m, 45)
                    time.sleep(0.6)
                res = m.js(click_js(href))
                if res != "ok":
                    print(f"[click-no] {href} en {parent} (desde {url_actual(m) or '?'})", flush=True)
                    i += 1
                    continue
            else:
                m.cmd("WebDriver:Navigate", {"url": url})
        except Exception as exc:
            nav_errs += 1
            print(f"[nav-err] {href}: {str(exc)[:80]}", flush=True)
            if nav_errs >= 3:
                i += 1
                nav_errs = 0
            time.sleep(5)
            continue
        nav_errs = 0
        if kind == "release":
            t0b = time.time()
            ok_nav = False
            while time.time() - t0b < 20:
                time.sleep(0.7)
                try:
                    st_u = jd(m, JS_URL)
                except Exception:
                    continue
                if href in (st_u.get("u") or ""):
                    ok_nav = True
                    break
            if not ok_nav:
                print(f"[release-sin-nav] {href} en {parent}", flush=True)
                i += 1
                continue
        st = esperar_carga(m, 45)
        time.sleep(0.8)
        try:
            st = jd(m, JS_STATUS)
        except Exception:
            st = {}
        if st.get("blocked"):
            persistente = True
            for _ in range(6):
                time.sleep(2)
                try:
                    st2 = jd(m, JS_STATUS)
                except Exception:
                    continue
                if not st2.get("blocked"):
                    persistente = False
                    break
            if persistente:
                _k["blocked"] = True
                print(f"[bloqueo] persistente en {href}; pauso y aviso al tablero", flush=True)
                escribir_tablero(estado, bloqueado=True, actual=row.get("name") or href)
                while True:
                    time.sleep(5)
                    play, pause = leer_control(m, tablero) if tablero else (0, 0)
                    if play > _k["lastPlay"]:
                        _k["lastPlay"] = play
                        _k["blocked"] = False
                        enfriar = random.uniform(120, 300)
                        print(f"[bloqueo] play: enfriamiento de {enfriar:.0f}s y reintento del mismo", flush=True)
                        time.sleep(enfriar)
                        break
                    try:
                        m.cmd("WebDriver:SwitchToWindow", {"handle": trabajo})
                        st3 = jd(m, JS_STATUS)
                        if st3.get("ready") == "complete" and not st3.get("blocked") and "rateyourmusic.com" in (st3.get("u") or ""):
                            _k["blocked"] = False
                            enfriar = random.uniform(150, 360)
                            print(f"[bloqueo] página limpia: enfriamiento de {enfriar:.0f}s y reintento", flush=True)
                            time.sleep(enfriar)
                            break
                    except Exception:
                        pass
                continue
        try:
            script = JS_PAGE if kind == "artist" else JS_RELEASE
            rec = jd(m, script)
            html = m.js("return document.documentElement.outerHTML")
            if not rec.get("name") and not rec.get("rows") and not rec.get("og"):
                time.sleep(2)
                rec = jd(m, script)
                html = m.js("return document.documentElement.outerHTML")
        except Exception as exc:
            print(f"[read-err] {href}: {str(exc)[:80]}", flush=True)
            i += 1
            continue
        guardar_pagina(kind, href, rec, html)
        estado[href] = recortar(rec)
        json.dump(estado, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
        e = estado[href]
        print(f"+ [{kind}] {href} -> {e['name']} | rel {e['nRows']} | gen {e['nGen']} | foto {bool(e['photo'])} | og {bool(e.get('og'))} | pistas {e.get('nTracks',0)} | cred {e.get('nCredits',0)} ({i+1}/{len(cola_trabajo)})", flush=True)
        try:
            escribir_tablero(estado, actual=row.get("name") or href)
        except Exception as exc:
            print("aviso tablero:", str(exc)[:100], flush=True)
        i += 1
        pausa_humana(i)


def construir_releases(cola, estado):
    releases, vistos = [], set()
    for row in cola:
        href = norm_href(row["rymHref"])
        f = os.path.join(PAGES, slugify(href) + ".json")
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
    grupos = {}
    for rel in releases:
        grupos.setdefault(rel[2].get("parent") or "?", []).append(rel)
    orden = list(grupos.values())
    random.shuffle(orden)
    return [rel for grupo in orden for rel in grupo]


def main():
    estado = {}
    if os.path.exists(STATE):
        estado = json.load(open(STATE, encoding="utf-8"))
    cola = cargar_cola()
    pendientes = []
    for row in cola:
        href = norm_href(row["rymHref"])
        if not href:
            continue
        if not es_ok_artista(estado.get(href) or {}):
            pendientes.append(("artist", href, row))

    if "--check" in sys.argv:
        releases = construir_releases(cola, estado)
        escribir_tablero(estado)
        print(f"check: cola {len(cola)} | pendientes fase 1 {len(pendientes)} | releases por capturar {len(releases)}")
        return

    random.shuffle(pendientes)
    print(f"nuevos-auto listo: fase 1 = {len(pendientes)} artistas por capturar (cola {len(cola)})", flush=True)
    m = Mar()
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    escribir_tablero(estado)
    tablero = asegurar_tablero(m)
    trabajo = elegir_pestana_trabajo(m, tablero)
    print(f"nuevos-auto listo: tablero={bool(tablero)} trabajo={bool(trabajo)}", flush=True)

    correr(pendientes, m, tablero, trabajo, estado)
    print("FASE 1 TERMINADA (fichas)", flush=True)
    escribir_tablero(estado, nota="Fase 1 terminada (fichas). Encolando discos…")

    releases = construir_releases(cola, estado)
    print(f"fase 2: {len(releases)} fichas de disco por capturar", flush=True)
    correr(releases, m, tablero, trabajo, estado)
    print("COLA TERMINADA", flush=True)
    escribir_tablero(estado, nota="Cola terminada.")


if __name__ == "__main__":
    main()
