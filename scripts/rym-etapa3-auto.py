#!/usr/bin/env python3
"""Etapa 3 — RYM dirigido AUTOMÁTICO (autorizado por el propietario 2026-10-01).

- Navega el propio asistente, en una pestaña dedicada del Firefox con marionette
  y el perfil del propietario, a intervalos ALEATORIOS de 3-5 s.
- Al detectar un bloqueo por detector de bots (hCaptcha / interstitial) PARA y
  espera: el tablero local muestra un botón ▶/⏸; el propietario resuelve el
  captcha y pulsa ▶ (se lee por localStorage) y la captura sigue donde paró.
  También reanuda solo si la página se limpia.
- NO resuelve captchas automáticamente: la pausa es el mecanismo.
- Extrae de páginas /artist/ (nombre, foto, géneros, discografía) y de /release/
  (portada og:image, año, géneros). Guarda JSON + HTML por página; regenera el
  tablero con progreso.

Uso: python3 rym-etapa3-auto.py
"""
import json, os, random, re, socket, sys, time
from urllib.parse import unquote

HOST, PORT = "127.0.0.1", 2828
ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
OUT = os.path.join(ROOT, "data/raw/fuentes-web-2026-10-01/rym-etapa3")
PAGES = os.path.join(OUT, "pages")
STATE = os.path.join(OUT, "estado.json")
COLA = os.path.join(OUT, "cola.jsonl")
DASH = os.path.join(OUT, "tablero.html")
DASH_TMP = "/tmp/crv-recon/rym-etapa3-tablero.html"
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
JS_CTRL = r"""return JSON.stringify({play: localStorage.getItem('rymPlay'), pause: localStorage.getItem('rymPause')})"""
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


def compact(value):
    import unicodedata
    if not value:
        return ""
    s = unicodedata.normalize("NFKD", value.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s)


def cargar_cola():
    rows = []
    if os.path.exists(COLA):
        for line in open(COLA, encoding="utf-8"):
            if line.strip():
                rows.append(json.loads(line))
    return rows


_SIN_PORTADA = None


def discos_pendientes(artist_ids):
    """{artistId: [(albumId, title)]} discos sin portada o sin año de esos artistas."""
    global _SIN_PORTADA
    if _SIN_PORTADA is not None:
        return _SIN_PORTADA
    import subprocess
    if not artist_ids:
        _SIN_PORTADA = {}
        return {}
    q = ("SELECT artist_id, id, title FROM public.albums "
         f"WHERE (cover_url IS NULL OR btrim(cover_url)='' OR release_year IS NULL) AND artist_id IN ({','.join(str(i) for i in artist_ids)})")
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-At", "-F", "\t", "-c", q],
                       capture_output=True, text=True)
    out = {}
    for line in r.stdout.strip().split("\n"):
        if line.strip():
            aid, alid, title = line.split("\t")
            out.setdefault(int(aid), []).append((int(alid), title))
    _SIN_PORTADA = out
    return out


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


def es_ok(e):
    if e.get("kind") == "release":
        return bool(e.get("v") == EXTRACTOR_V and (e.get("name") or e.get("og")) and (e.get("og") or e.get("nTracks", 0) or e.get("nGen", 0)))
    return bool(e.get("v") == EXTRACTOR_V and e.get("name")) and (e.get("nRows", 0) > 0 or e.get("photo"))


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
    hechas = 0
    filas = []
    for row in cola:
        href = norm_href(row["rymHref"])
        e = estado.get(href) or {}
        ok = es_ok(e)
        if ok:
            hechas += 1
            foto = "con foto" if e.get("photo") else "SIN foto"
            marca = f'<span class="ok">&#10003;</span> {foto} | rel {e.get("nRows",0)} | gen {e.get("nGen",0)}'
            nombre = row["name"]
        else:
            marca = "&#8226; pendiente"
            nombre = f'<a href="https://rateyourmusic.com{href}" target="_blank">{row["name"]}</a>'
        if e.get("wall"):
            marca += ' <span class="warn">muro</span>'
        filas.append(f'<tr class="{"completa" if ok else "parcial"}"><td>{nombre}</td><td>{row["albums"]}</td><td>{marca}</td></tr>')
    discos = []
    for href, e in estado.items():
        if e.get("kind") == "release":
            discos.append(href)
    total_rel = sum(1 for e in estado.values() if e.get("kind") == "release" and e.get("og"))

    if bloqueado:
        banner = ('<div class="alerta">BLOQUEO POR DETECTOR DE BOTS &#9888; Resuelve el captcha en la otra pestaña '
                  'y pulsa <b>&#9654; Continuar</b>.</div>')
    elif pausado:
        banner = '<div class="pausa">PAUSADO &#9208; Pulsa <b>&#9654; Continuar</b> para reanudar.</div>'
    else:
        banner = '<div class="okbar">Autom&#225;tico en marcha &#9881; (pulsa PAUSA para tomar el control).</div>'

    html = ("<!doctype html><meta charset=\"utf-8\"><title>" + ("\u26a0 CAPTCHA - resuelve y pulsa PLAY - RYM etapa 3" if bloqueado else "RYM etapa 3 - control") + "</title>\n"
            "<meta http-equiv=\"refresh\" content=\"5\">\n"
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
            "window.addEventListener('load',function(){try{var p=localStorage.getItem('rymPlay')||'-';var q=localStorage.getItem('rymPause')||'-';document.getElementById('st').textContent='play: '+p+' | pause: '+q;}catch(e){}});\n"
            "</script>\n"
            f"{banner}\n"
            f"<p>Artistas <b>{hechas}</b>/{len(cola)} capturados &middot; fichas de disco con portada <b>{total_rel}</b> &middot; {('leyendo ahora: <b>'+actual+'</b>') if actual else ''}</p>\n"
            f"<p>{nota or ''} <span class='meta' id='st'></span></p>\n"
            "<p><button class='big' onclick=\"ctrl('rymPlay')\">&#9654; Continuar</button>"
            "<button class='big pause' onclick=\"ctrl('rymPause')\">&#9208; Pausa</button>"
            "<button class='big' onclick=\"try{location.reload()}catch(e){}\">&#8635; Refrescar</button></p>\n"
            "<table><tr><th>Artista</th><th>Discos</th><th>Estado</th></tr>" + "\n".join(filas) + "</table>\n"
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
    h = buscar_pestana(m, "file:///tmp/crv-recon/rym-etapa3-tablero.html")
    if h:
        m.cmd("WebDriver:SwitchToWindow", {"handle": h})
        m.cmd("WebDriver:Navigate", {"url": "file:///tmp/crv-recon/rym-etapa3-tablero.html"})
        return h
    antes = set(m.cmd("WebDriver:GetWindowHandles", {}))
    m.cmd("WebDriver:NewWindow", {"type": "tab"})
    for hh in m.cmd("WebDriver:GetWindowHandles", {}):
        if hh not in antes:
            m.cmd("WebDriver:SwitchToWindow", {"handle": hh})
            m.cmd("WebDriver:Navigate", {"url": "file:///tmp/crv-recon/rym-etapa3-tablero.html"})
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
    # crear una nueva para trabajo
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


def main():
    estado = {}
    if os.path.exists(STATE):
        estado = json.load(open(STATE, encoding="utf-8"))
    cola = cargar_cola()
    discos = discos_pendientes([r["artistId"] for r in cola])
    m = Mar()
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    escribir_tablero(estado)
    tablero = asegurar_tablero(m)
    trabajo = elegir_pestana_trabajo(m, tablero)
    print(f"auto listo: tablero={bool(tablero)} trabajo={bool(trabajo)}", flush=True)

    pendientes = []
    for row in cola:
        href = norm_href(row["rymHref"])
        if not es_ok(estado.get(href) or {}):
            pendientes.append(("artist", href, row))
    releases = []
    vistos = set()
    for row in cola:
        capt = None
        f = os.path.join(PAGES, slugify(norm_href(row["rymHref"])) + ".json")
        if os.path.exists(f):
            try:
                capt = json.load(open(f, encoding="utf-8"))
            except Exception:
                capt = None
        if not capt:
            continue
        rows = capt.get("rec", {}).get("rows") or []
        for r in rows:
            rel = norm_href(r.get("h"))
            if not rel or rel in vistos:
                continue
            vistos.add(rel)
            if not es_ok(estado.get(rel) or {}):
                releases.append(("release", rel, {"name": f"{row['name']} - {r.get('t') or ''}", "parent": norm_href(row["rymHref"])}))
    cola_trabajo = pendientes + releases
    print(f"pendientes: {len(pendientes)} artistas + {len(releases)} discos", flush=True)

    _k = {"lastPlay": 0, "lastPause": 0, "blocked": False, "blockedAt": 0}
    pausado = False
    i = 0
    nav_errs = 0
    ultima_pagina = None
    while i < len(cola_trabajo):
        kind, href, row = cola_trabajo[i]
        # control: leer play/pause del tablero
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
        # navegar
        url = "https://rateyourmusic.com" + href
        try:
            m.cmd("WebDriver:SwitchToWindow", {"handle": trabajo})
            if kind == "release":
                # Las fichas de disco solo cargan con clic real desde la página
                # del artista (la navegación directa devuelve un muro).
                parent = (row or {}).get("parent")
                if not parent:
                    print(f"[release-sin-padre] {href}", flush=True)
                    i += 1
                    continue
                if ultima_pagina != parent:
                    m.cmd("WebDriver:Navigate", {"url": "https://rateyourmusic.com" + parent})
                    ultima_pagina = parent
                    st0 = esperar_carga(m, 45)
                    time.sleep(0.6)
                click = ('return (function(){var tgt=' + json.dumps(href) +
                         ';var a=[...document.querySelectorAll(\'#discography a[href]\')].find(function(x){'
                         'var h=(x.getAttribute(\'href\')||\'\').split(\'?\')[0].replace(/\\/$/,\'\');return h===tgt;});'
                         'if(!a)return \'no\';a.click();return \'ok\';})()')
                res = m.js(click)
                if res != "ok":
                    print(f"[click-no] {href} en {parent}", flush=True)
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
            # el clic dispara la navegación: esperar a que la URL cambie a la ficha
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
            # muchos muros son transitorios (reto de Cloudflare que pasa solo)
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
                _k["blockedAt"] = time.time()
                print(f"[bloqueo] persistente en {href}; pauso y aviso al tablero", flush=True)
                escribir_tablero(estado, bloqueado=True, actual=row.get("name") or href)
                while True:
                    time.sleep(5)
                    play, pause = leer_control(m, tablero) if tablero else (0, 0)
                    if play > _k["lastPlay"]:
                        _k["lastPlay"] = play
                        _k["blocked"] = False
                        print("[bloqueo] play: reintento el mismo", flush=True)
                        break
                    try:
                        m.cmd("WebDriver:SwitchToWindow", {"handle": trabajo})
                        st3 = jd(m, JS_STATUS)
                        if st3.get("ready") == "complete" and not st3.get("blocked") and "rateyourmusic.com" in (st3.get("u") or ""):
                            _k["blocked"] = False
                            print("[bloqueo] página limpia: reintento", flush=True)
                            break
                    except Exception:
                        pass
                continue  # reintenta el MISMO ítem
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
        ultima_pagina = href if kind == "artist" else ultima_pagina
        estado[href] = recortar(rec)
        json.dump(estado, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
        e = estado[href]
        if kind == "artist":
            # intercala los discos de la página recién capturada justo después
            nuevos = []
            for r in (rec.get("rows") or []):
                rel = norm_href(r.get("h"))
                if not rel or rel in vistos:
                    continue
                vistos.add(rel)
                if not es_ok(estado.get(rel) or {}):
                    nuevos.append(("release", rel, {"name": f"{e.get('name')} - {r.get('t') or ''}", "parent": href}))
            cola_trabajo[i + 1:i + 1] = nuevos
        print(f"+ [{kind}] {href} -> {e['name']} | rel {e['nRows']} | gen {e['nGen']} | foto {bool(e['photo'])} | og {bool(e.get('og'))} | pistas {e.get('nTracks',0)} | cred {e.get('nCredits',0)} ({i+1}/{len(cola_trabajo)})", flush=True)
        try:
            escribir_tablero(estado, actual=row.get("name") or href)
        except Exception as exc:
            print("aviso tablero:", str(exc)[:100], flush=True)
        i += 1
        time.sleep(random.uniform(3, 5))
    print("COLA TERMINADA", flush=True)
    escribir_tablero(estado, nota="Cola terminada.")


if __name__ == "__main__":
    main()
