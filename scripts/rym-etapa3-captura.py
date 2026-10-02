#!/usr/bin/env python3
"""Etapa 3 — piloto RYM dirigido: captura SOLO LECTURA + tablero de enlaces.

Regla del proyecto: el asistente NUNCA navega a RYM; solo lee el DOM de las
pestañas que el propietario abre en su Firefox con marionette. Este script:
- Lee cada pestaña abierta; si es /artist/ extrae nombre, foto, géneros y
  discografía (tipo y año); si es /release/ extrae portada (og:image), año,
  géneros. Guarda JSON + HTML crudo por página.
- Regenera el tablero (pestaña file:// local) con un enlace por artista
  pendiente y, para los discos sin portada de artistas ya capturados, un
  enlace directo a la ficha del disco.

Uso:
  python3 rym-etapa3.py            # bucle de captura + tablero
  python3 rym-etapa3.py --tablero  # solo escribir el tablero y salir
"""
import json, os, re, socket, sys, time
from urllib.parse import unquote

HOST, PORT = "127.0.0.1", 2828
ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
OUT = os.path.join(ROOT, "data/raw/fuentes-web-2026-10-01/rym-etapa3")
PAGES = os.path.join(OUT, "pages")
STATE = os.path.join(OUT, "estado.json")
PILOTO = os.path.join(OUT, "piloto-100.jsonl")
DASH = os.path.join(OUT, "tablero.html")
DASH_TMP = "/tmp/crv-recon/rym-etapa3-tablero.html"
EXTRACTOR_V = 2
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


JS_PAGE = r"""return JSON.stringify((function(){
 const out = {u: document.URL, t: document.title, v: 2, kind: 'artist'};
 out.name = (document.querySelector('h1')||{}).textContent ? document.querySelector('h1').textContent.trim().slice(0,120) : null;
 out.wall = /Just a moment|Attention Required|Verify you are human|Checking your browser/i.test((document.body?document.body.innerText:'').slice(0,600));
 const md = (document.querySelector('meta[name=description]')||{}).content || '';
 const fm = md.match(/formed\s+(\d{4})/i); out.formed = fm ? Number(fm[1]) : null;
 const img = document.querySelector('.section_artist_image img');
 out.photo = img ? {src: img.getAttribute('src'), cls:(img.className||'').toString()} : null;
 out.og = (document.querySelector('meta[property="og:image"]')||{}).content || null;
 out.genres = [...new Set([...document.querySelectorAll('a[href^="/genre/"]')].map(a=>a.textContent.trim()))].slice(0,20);
 const labels = [...document.querySelectorAll('#discography .disco_header_label')];
 out.sections = labels.map(l=>l.textContent.trim());
 out.rows = [...document.querySelectorAll('#discography div.disco_release')].map(r=>{
   const a = r.querySelector('a[href*="/release/"]');
   const y = r.querySelector('.disco_year_y');
   let ty = null;
   for (const l of labels) { if (l.compareDocumentPosition(r) & Node.DOCUMENT_POSITION_FOLLOWING) ty = l.textContent.trim(); else break; }
   return {h: a? a.getAttribute('href') : null, t: a? a.textContent.trim().slice(0,140) : null, y: y? y.textContent.trim().slice(0,12) : null, ty: ty};
 }).filter(r=>r.h);
 return out;
})())"""
JS_RELEASE = r"""return JSON.stringify((function(){
 const out = {u: document.URL, t: document.title, v: 2, kind: 'release'};
 out.name = (document.querySelector('h1')||{}).textContent ? document.querySelector('h1').textContent.trim().slice(0,140) : null;
 out.wall = /Just a moment|Attention Required|Verify you are human|Checking your browser/i.test((document.body?document.body.innerText:'').slice(0,600));
 out.og = (document.querySelector('meta[property="og:image"]')||{}).content || null;
 out.genres = [...new Set([...document.querySelectorAll('a[href^="/genre/"]')].map(a=>a.textContent.trim()))].slice(0,20);
 const ar = document.querySelector('.release_page_header a[href^="/artist/"], .section_release_page a[href^="/artist/"], a.artist[href^="/artist/"]');
 out.artist = ar ? ar.textContent.trim().slice(0,140) : null;
 const info = document.querySelector('.section_release_info, .release_page_header, #content');
 out.info = info ? info.innerText.replace(/\s+/g,' ').trim().slice(0,1200) : null;
 return out;
})())"""
JS_URL = "return JSON.stringify({u:document.URL,t:document.title})"


def norm_href(h):
    if not h:
        return ""
    h = unquote(h)
    if h.startswith("https://rateyourmusic.com"):
        h = h[len("https://rateyourmusic.com"):]
    h = h.split("?")[0].split("#")[0].rstrip("/")
    return h


def slugify(href):
    s = norm_href(href).replace("/artist/", "").replace("/", "_")
    s = re.sub(r"[^A-Za-z0-9_\-\.]", "", s)
    return s[:90] or "sin-slug"


def cargar_piloto():
    rows = []
    if os.path.exists(PILOTO):
        for line in open(PILOTO, encoding="utf-8"):
            if line.strip():
                rows.append(json.loads(line))
    return rows


def compact(value):
    import unicodedata
    if not value:
        return ""
    s = unicodedata.normalize("NFKD", value.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s)


def cargar_discos_sin_portada(artist_ids):
    """{artistId: [(albumId, title)]} de discos sin portada de los artistas dados."""
    if not artist_ids:
        return {}
    import subprocess
    q = ("SELECT artist_id, id, title FROM public.albums "
         f"WHERE (cover_url IS NULL OR btrim(cover_url)='') AND artist_id IN ({','.join(str(i) for i in artist_ids)})")
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-At", "-F", "\t", "-c", q],
                       capture_output=True, text=True)
    out = {}
    for line in r.stdout.strip().split("\n"):
        if not line.strip():
            continue
        aid, alid, title = line.split("\t")
        out.setdefault(int(aid), []).append((int(alid), title))
    return out


def cargar_captura(href):
    slug = slugify(href)
    f = os.path.join(PAGES, slug + ".json")
    if not os.path.exists(f):
        return None
    try:
        return json.load(open(f, encoding="utf-8"))
    except Exception:
        return None


def enlaces_discos(piloto, estado, sin_portada):
    """Filas de enlaces a fichas de disco RYM para los discos sin portada de
    artistas ya capturados (match por título contra su discografía RYM)."""
    filas = []
    for row in piloto:
        href = norm_href(row["rymHref"])
        e = estado.get(href) or {}
        if not e.get("name"):
            continue
        capt = cargar_captura(href)
        if not capt:
            continue
        rows = capt.get("rec", {}).get("rows") or []
        for album_id, title in (sin_portada.get(row["artistId"]) or []):
            ck = compact(title)
            match = None
            for r in rows:
                rk = compact(r.get("t"))
                if rk and ck and (rk == ck or (len(ck) >= 6 and (rk.startswith(ck) or ck.startswith(rk)))):
                    match = r
                    break
            if not match or not match.get("h"):
                continue
            rel_href = norm_href(match["h"])
            cap = estado.get(rel_href) or {}
            ok = bool(cap.get("name") and cap.get("og"))
            if ok:
                marca = '<span class="ok">&#10003;</span> con portada' + (" + gen" if cap.get("nGen") else "")
            else:
                marca = f'<a href="https://rateyourmusic.com{rel_href}" target="_blank">abrir disco &#9654;</a>'
            cls = "completa" if ok else ""
            filas.append(f'<tr class="{cls}"><td>{row["name"]}</td><td>{title}</td><td>{match.get("y") or ""} {match.get("ty") or ""}</td><td>{marca}</td></tr>')
    return filas


def es_ok(e):
    if e.get("kind") == "release":
        return bool(e.get("v") == EXTRACTOR_V and e.get("name") and e.get("og"))
    return bool(e.get("v") == EXTRACTOR_V and e.get("name")) and (e.get("nRows", 0) > 0 or e.get("photo"))


_SIN_PORTADA = None


def escribir_tablero(estado):
    global _SIN_PORTADA
    piloto = cargar_piloto()
    if _SIN_PORTADA is None:
        try:
            _SIN_PORTADA = cargar_discos_sin_portada([r["artistId"] for r in piloto])
        except Exception as exc:
            print("aviso sin_portada:", str(exc)[:100], flush=True)
            _SIN_PORTADA = {}
    hechas = 0
    filas = []
    for row in piloto:
        href = norm_href(row["rymHref"])
        e = estado.get(href) or {}
        ok = es_ok(e)
        if ok:
            hechas += 1
            foto = "con foto" if e.get("photo") else "SIN foto"
            marca = f'<span class="ok">&#10003;</span> {foto} | rel {e.get("nRows",0)} | gen {e.get("nGen",0)}'
            nombre = row["name"]
        else:
            marca = f'<a href="https://rateyourmusic.com{href}" target="_blank">abrir &#9654;</a>'
            nombre = f'<a href="https://rateyourmusic.com{href}" target="_blank">{row["name"]}</a>'
        if e.get("wall"):
            marca += ' <span class="warn">muro</span>'
        cls = "completa" if ok else ("parcial" if e else "")
        filas.append(f'<tr class="{cls}"><td>{nombre}</td><td>{row["albums"]}</td><td>{row["albumsSinPortada"]}</td><td>{marca}</td></tr>')
    discos = enlaces_discos(piloto, estado, _SIN_PORTADA or {})
    hechos_discos = sum(1 for f in discos if "&#10003;" in f)
    html = ("<!doctype html><meta charset=\"utf-8\"><title>RYM etapa 3 - piloto 100 (1 clic por artista)</title>\n"
            "<meta http-equiv=\"refresh\" content=\"8\">\n"
            "<style>body{font:13px system-ui;background:#111;color:#eee;margin:16px}table{border-collapse:collapse;width:100%;margin-bottom:18px}\n"
            "td,th{border:1px solid #333;padding:3px 8px}th{background:#1e1e1e;position:sticky;top:0}\n"
            "a{color:#7fd1ff}b{color:#7CFC98}.ok{color:#7CFC98;font-weight:700}.warn{color:#ffd479}\n"
            ".parcial td{background:#2b270f}.completa td{background:#12301a}</style>\n"
            "<script>try{addEventListener('pagehide',()=>sessionStorage.setItem('dashY',scrollY));addEventListener('load',()=>{const y=sessionStorage.getItem('dashY');if(y!==null)scrollTo(0,+y)})}catch(e){}</script>\n"
            f"<h3>RYM etapa 3 - piloto: artistas <b>{hechas}</b>/{len(piloto)} capturados. Autorefresco 8 s.</h3>\n"
            "<p>Artistas: clic en «abrir» (o clic medio en el nombre), en tandas de 20-30; si sale captcha, resolucion manual y sigue.</p>\n"
            "<table><tr><th>Artista</th><th>Discos</th><th>Sin portada</th><th>Estado</th></tr>" + "\n".join(filas) + "</table>\n"
            f"<h3>Discos sin portada de los artistas capturados <b>{hechos_discos}</b>/{len(discos)} con portada.</h3>\n"
            "<p>Enlaces directos a la ficha del disco en RYM (aparecen al capturar el artista).</p>\n"
            "<table><tr><th>Artista</th><th>Disco</th><th>Año/Tipo (RYM)</th><th>Estado</th></tr>" + "\n".join(discos) + "</table>")
    for path in (DASH, DASH_TMP):
        try:
            open(path, "w", encoding="utf-8").write(html)
        except Exception as exc:
            print("aviso tablero:", exc, flush=True)


def abrir_tablero(m):
    try:
        url_dash = "file:///tmp/crv-recon/rym-etapa3-tablero.html"
        for h in m.cmd("WebDriver:GetWindowHandles", {}):
            try:
                m.cmd("WebDriver:SwitchToWindow", {"handle": h})
                info = json.loads(m.cmd("WebDriver:ExecuteScript", {"script": JS_URL, "args": []}))
            except Exception:
                continue
            if (info.get("u") or "").startswith(url_dash):
                m.cmd("WebDriver:Navigate", {"url": url_dash})
                return
        antes = set(m.cmd("WebDriver:GetWindowHandles", {}))
        m.cmd("WebDriver:NewWindow", {"type": "tab"})
        for h in m.cmd("WebDriver:GetWindowHandles", {}):
            if h not in antes:
                m.cmd("WebDriver:SwitchToWindow", {"handle": h})
                m.cmd("WebDriver:Navigate", {"url": url_dash})
                return
    except Exception as e:
        print("aviso tablero:", str(e)[:120], flush=True)


def recortar(rec):
    """Deja solo lo útil del registro para el estado (sin HTML gigante)."""
    rows = rec.get("rows") or []
    return {"name": rec.get("name"), "kind": rec.get("kind") or "artist", "nRows": len(rows),
            "nGen": len(rec.get("genres") or []), "photo": (rec.get("photo") or {}).get("src"),
            "formed": rec.get("formed"), "og": rec.get("og"), "wall": bool(rec.get("wall")),
            "at": time.strftime("%H:%M:%S"), "v": rec.get("v")}


def main():
    modo_tablero = "--tablero" in sys.argv[1:]
    estado = {}
    if os.path.exists(STATE):
        estado = json.load(open(STATE, encoding="utf-8"))
    escribir_tablero(estado)
    if modo_tablero:
        print(f"tablero escrito: {DASH} / {DASH_TMP}")
        return
    m = Mar()
    m.cmd("WebDriver:NewSession", {"capabilities": {}})
    escribir_tablero(estado)
    abrir_tablero(m)
    print("capturador etapa3 listo: navega tu; yo leo.", flush=True)
    ociosos = 0
    while True:
        try:
            handles = m.cmd("WebDriver:GetWindowHandles", {})
        except Exception as e:
            print("sin handles:", str(e)[:80], flush=True)
            time.sleep(5)
            continue
        algo = False
        rym_vistas = 0
        for h in handles:
            try:
                m.cmd("WebDriver:SwitchToWindow", {"handle": h})
                info = json.loads(m.cmd("WebDriver:ExecuteScript", {"script": JS_URL, "args": []}))
            except Exception:
                continue
            u = info.get("u") or ""
            if "rateyourmusic.com/artist/" in u:
                kind = "artist"
            elif "rateyourmusic.com/release/" in u:
                kind = "release"
            else:
                continue
            rym_vistas += 1
            href = norm_href(u)
            prev = estado.get(href) or {}
            if es_ok(prev) and not prev.get("wall"):
                continue
            try:
                script = JS_PAGE if kind == "artist" else JS_RELEASE
                rec = json.loads(m.cmd("WebDriver:ExecuteScript", {"script": script, "args": []}))
                html = m.cmd("WebDriver:ExecuteScript", {"script": "return document.documentElement.outerHTML", "args": []})
            except Exception as e:
                print(f"err leyendo {href[:70]}: {str(e)[:90]}", flush=True)
                continue
            slug = ("rel_" + slugify(href.replace("/release/", ""))) if kind == "release" else slugify(href)
            with open(os.path.join(PAGES, slug + ".json"), "w", encoding="utf-8") as f:
                json.dump({"href": href, "rec": rec, "capturedAt": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=1)
            if isinstance(html, str) and len(html) > 3000:
                with open(os.path.join(PAGES, slug + ".html"), "w", encoding="utf-8") as f:
                    f.write(html)
            estado[href] = recortar(rec)
            json.dump(estado, open(STATE, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
            algo = True
            e = estado[href]
            print(f"+ [{kind}] {href} -> {e['name']} | rel {e['nRows']} | gen {e['nGen']} | foto {bool(e['photo'])} | og {bool(e.get('og'))}", flush=True)
            try:
                escribir_tablero(estado)
            except Exception as exc:
                print("aviso tablero:", str(exc)[:100], flush=True)
        if algo:
            ociosos = 0
            time.sleep(1.5)
            continue
        ociosos += 1
        if ociosos % 20 == 0:
            print(f"latido: {len(handles)} pestanas, {rym_vistas} de artista pendientes; capturadas {len(estado)}", flush=True)
        time.sleep(3)


if __name__ == "__main__":
    main()
