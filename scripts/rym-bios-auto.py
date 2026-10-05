#!/usr/bin/env python3
"""CRV · Fase «bios» — captura de la pestaña de biografía de RYM.

Captura `/artist/<slug>/biography` para los artistas SIN biografía del catálogo
(los 1.591 de «nuevos» + el residuo con slug RYM conocido). El crudo queda en
disco (JSON + HTML) y la extracción fina se hace offline, como con «nuevos».

⚠️  NO lanzar mientras corre CUALQUIER otra captura de RYM (una sola sesión a
la vez — regla anti-muro de la campaña). Antes de lanzar:
  systemctl --user is-active crv-scrapling-nuevos.service crv-scrapling-nuevos-super.service
  (deben estar «inactive» → la fase 2 cerró)

LANZAMIENTO (ventana libre):
  systemd-run --user --collect --unit=crv-rym-bios \
    --setenv=DISPLAY=:0 --setenv=XAUTHORITY=/home/brian/.Xauthority \
    python3 scripts/rym-bios-auto.py

Requisitos: Firefox del dueño con marionette en 127.0.0.1:2828 (el de los
«nuevos» ya lo trae; si no, relanzarlo como en la campaña). La cola se genera
antes con scripts/rym-bios-cola.py (cruza cola-nuevos.jsonl con la BD).

Progreso: data/raw/fuentes-web-2026-10-01/rym-bios/estado.json + pages/.
"""
import json
import os
import random
import re
import socket
import sys
import time
from urllib.parse import unquote

HOST, PORT = "127.0.0.1", 2828
ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
OUT = os.path.join(ROOT, "data/raw/fuentes-web-2026-10-01/rym-bios")
PAGES = os.path.join(OUT, "pages")
STATE = os.path.join(OUT, "estado.json")
COLA = os.path.join(OUT, "cola-bios.jsonl")
os.makedirs(PAGES, exist_ok=True)


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


# La pestaña de biografía vive en /artist/<slug>/biography; el texto útil está
# en .section_artist_biography (o #content como respaldo). Se guarda el crudo.
JS_BIO = r"""return JSON.stringify((function(){
 const out = {u: document.URL, t: document.title, v: 1, kind: 'biography'};
 out.wall = /Just a moment|Attention Required|Verify you are human|Checking your browser/i.test((document.body?document.body.innerText:'').slice(0,600));
 const bio = document.querySelector('.section_artist_biography') || document.querySelector('#content');
 out.bio = bio ? bio.innerText.replace(/\s+/g,' ').trim().slice(0,12000) : null;
 out.name = (document.querySelector('h1')||{}).textContent ? document.querySelector('h1').textContent.trim().slice(0,120) : null;
 return out;
})())"""

JS_URL = "return JSON.stringify({u:document.URL})"


def jd(m, script):
    try:
        raw = m.js(script)
    except Exception as exc:
        return {"_err": str(exc)[:120]}
    if isinstance(raw, dict):
        return raw
    if isinstance(raw, str):
        try:
            val = json.loads(raw)
            return val if isinstance(val, dict) else {"_err": "tipo"}
        except Exception:
            return {"_err": "nojson:" + raw[:60]}
    return {"_err": "tipo"}


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


def esperar_carga(m, timeout=45):
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            st = jd(m, "return JSON.stringify({ready: document.readyState, t: document.title})")
            if st.get("ready") == "complete" and not re.search(r"Just a moment|Attention Required|Verify", st.get("t") or ""):
                return st
        except Exception:
            pass
        time.sleep(0.7)
    return {"ready": "timeout"}


def pausa_humana(i):
    p = random.uniform(5, 9)
    if random.random() < 0.08:
        p += random.uniform(20, 60)
    if (i + 1) % 30 == 0:
        p += random.uniform(40, 90)
        print(f"[pausa] descanso humano de {p:.0f}s tras {i + 1} ítems", flush=True)
    time.sleep(p)


def guardar(slug, href, rec, html):
    with open(os.path.join(PAGES, slug + ".json"), "w", encoding="utf-8") as f:
        json.dump({"href": href, "rec": rec, "capturedAt": time.strftime("%Y-%m-%d %H:%M:%S")}, f, ensure_ascii=False, indent=1)
    if isinstance(html, str) and len(html) > 3000:
        with open(os.path.join(PAGES, slug + ".html"), "w", encoding="utf-8") as f:
            f.write(html)


def main():
    if not os.path.exists(COLA):
        print("falta la cola:", COLA, "- genera antes con scripts/rym-bios-cola.py")
        sys.exit(1)
    cola = [json.loads(l) for l in open(COLA, encoding="utf-8") if l.strip()]
    estado = {}
    if os.path.exists(STATE):
        try:
            estado = json.load(open(STATE, encoding="utf-8"))
        except Exception:
            estado = {}

    print(f"cola: {len(cola)} artistas sin bio · hechos: {sum(1 for v in estado.values() if v.get('bio'))}", flush=True)
    m = Mar()
    m.cmd("WebDriver:GetWindowHandles", {})  # handshake

    hechos = 0
    for i, row in enumerate(cola):
        href = norm_href(row["rymHref"])
        e = estado.get(href) or {}
        if e.get("bio"):
            continue
        bio_href = href + "/biography"
        try:
            m.cmd("WebDriver:Navigate", {"url": "https://rateyourmusic.com" + bio_href})
            st = esperar_carga(m)
            rec = jd(m, JS_BIO)
            html = None
            try:
                html = m.cmd("WebDriver:GetPageSource", {})
            except Exception:
                pass
            estado[href] = {"name": row.get("name"), "kind": "biography", "bio": bool(rec.get("bio")),
                            "wall": bool(rec.get("wall")), "at": time.strftime("%H:%M:%S"), "u": rec.get("u", "")}
            guardar(slugify(href) + "-bio", bio_href, rec, html)
            hechos += 1
            if hechos % 10 == 0 or rec.get("wall"):
                print(f"  {i + 1}/{len(cola)} {row.get('name', '')[:40]} · bio={'sí' if rec.get('bio') else 'NO'}"
                      + (" · MURO" if rec.get("wall") else ""), flush=True)
            if rec.get("wall"):
                print("muro detectado: parando (revisa la ventana y relanza)", flush=True)
                break
            with open(STATE, "w", encoding="utf-8") as f:
                json.dump(estado, f, ensure_ascii=False)
            pausa_humana(i)
        except Exception as exc:
            print(f"  error en {href}: {str(exc)[:100]}", flush=True)
            time.sleep(5)
    print(f"terminado: {hechos} bios capturadas de {len(cola)} en cola", flush=True)


if __name__ == "__main__":
    main()
