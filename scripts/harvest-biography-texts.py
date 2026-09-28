#!/usr/bin/env python3
"""Textos biográficos y datos de ficha de TODAS las fuentes, para TODAS las fichas.

Pedido de Brian (2026-09-27): completar o mejorar la biografía de cada artista,
persona y organización y la reseña de cada disco con todo lo que publican las
fuentes (las del proyecto y las que se usaron para los géneros). Este script
solo recoge: guarda cada texto con su URL y cómo se decidió que la ficha de la
fuente es la nuestra. No escribe en la base; la síntesis y la aplicación van
aparte (scripts/export-biography-dossiers.ts, scripts/apply-biographies.ts).

Identidad (la misma vara que los cosechadores de géneros): el nombre casa exacto
(normalizado), no hay homónimo en el catálogo y hay una prueba independiente de
que es la ficha venezolana: país/origen Venezuela en la fuente, la fuente es
exclusivamente venezolana, o la página nombra una banda/disco con los que el
catálogo ya relaciona a la ficha. Un enlace desde la ficha ya casada de
Lobotoradio también es prueba (Lobotoradio enlaza su Wikipedia, Discogs, Last.fm,
Venciclopedia…).

Fuentes (una por proceso, cada una con su caché en data/raw/<fuente>):
  lobotoradio   fichas de bandas, artistas (personas), discos y empresas; Crawl-delay 10 s
  lastfm        API 2.0: artist.getInfo / album.getInfo en español y en inglés
  wikipedia     API de es/en: extracto completo en texto plano
  venciclopedia API MediaWiki; Crawl-delay 10 s
  discogs       API con token: perfil de artista y de sello, notas del lanzamiento
  musicbrainz   API ws/2: datos de ficha (fechas, área, miembros); 1 petición/s
  theaudiodb    API v1 (clave pública 123): biografía ES/EN
  rhv           directorio rockhechovenezuela.com (REST de WordPress, caché)
  vzlarockea    feed JSON de Blogger (caché)
  sincopa       páginas guardadas del sitio (ficha estructurada y prosa)
Deezer, Spotify y Bandcamp no dan biografías por las vías permitidas: la API de
Deezer no tiene campo de biografía, la de Spotify tampoco (y ya se descartó para
géneros) y Bandcamp solo se consulta por su API de búsqueda (las páginas piden
un desafío anti-bot que no se evade).

Salida: reports/bio-texts/<fuente>.jsonl, una fila por texto:
  {caseId, kind, entityId, source, url, lang, text, facts, links, identity}
Uso: python3 scripts/harvest-biography-texts.py <catalog.json> <fuente> [--limit N]
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from html import unescape
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT_DIR = ROOT / "reports" / "bio-texts"
UA = "CRV-catalogo/1.0 (catalogo de rock venezolano; uso no comercial)"
MAX_TEXT = 12000
VZ = re.compile(r"venezuel|caracas|maracaibo|barquisimeto|valencia,? (?:edo|estado|carabobo|venezuela)|maracay|m[eé]rida,? (?:edo|estado|venezuela)|puerto la cruz|barcelona,? (?:edo|estado|anzo[aá]tegui)", re.I)
STATS: dict[str, int] = {}
LAST: dict[str, float] = {}
NEXT: dict[str, float] = {}
LOCK = threading.Lock()
STATS_LOCK = threading.Lock()


def bump(key: str, n: int = 1) -> None:
    with STATS_LOCK:
        STATS[key] = STATS.get(key, 0) + n


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.startswith(name + "="):
                return line.split("=", 1)[1].strip().strip("'\"")
    return ""


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", unescape(text or "")).encode("ascii", "ignore").decode().lower().replace("&", " and ")
    text = re.sub(r"^(the|los|las|la|el)\s+", "", text.strip())
    return re.sub(r"[^a-z0-9]+", "", text)


def title_key(text: str) -> str:
    text = re.sub(r"\((?:\d{4}|ep|lp|single|demo|remaster[^)]*|reissue|reedici[oó]n[^)]*|en vivo|live)\)", "", text or "", flags=re.I)
    return norm(re.sub(r"\b(ep|lp)\b\s*$", "", text.strip(), flags=re.I))


def plain(html: str) -> str:
    text = re.sub(r"(?is)<(script|style)[^>]*>.*?</\1>", " ", html or "")
    text = re.sub(r"(?i)<br\s*/?>|</p>|</h\d>|</li>|</div>|</tr>", "\n", text)
    text = unescape(re.sub(r"<[^>]+>", " ", text))
    text = re.sub(r"[ \t\xa0]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n", text).strip()


def mentions(text: str, names: list[str]) -> list[str]:
    """Nombres del catálogo (≥4 letras normalizadas) que el texto nombra."""
    haystack = norm(text)
    return [name for name in names if len(norm(name)) >= 4 and norm(name) in haystack]


def fetch(source: str, key: str, url: str, delay: float, *, data: bytes | None = None,
          headers: dict | None = None, as_json: bool = True, retry_codes=(429, 500, 502, 503, 504)):
    """GET/POST con caché por fuente. None si falló; {} / "" si 404."""
    cache_dir = RAW / source
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / (hashlib.sha256(key.encode()).hexdigest() + (".json" if as_json else ".html"))
    if path.exists():
        body = path.read_text(encoding="utf-8")
        return json.loads(body) if as_json else body
    for attempt in range(5):
        with LOCK:
            now = time.time()
            slot = max(now, NEXT.get(source, 0.0))
            NEXT[source] = slot + delay
        if slot > now:
            time.sleep(slot - now)
        bump(f"{source}:peticiones")
        status, body = 200, ""
        try:
            req = urllib.request.Request(url, data=data, headers={"User-Agent": UA, **(headers or {})})
            with urllib.request.urlopen(req, timeout=40) as res:
                body = res.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as exc:
            status = exc.code
            try:
                body = exc.read().decode("utf-8", "replace")
            except Exception:
                body = ""
            if status in retry_codes:
                retry = exc.headers.get("Retry-After") if exc.headers else None
                LAST[source] = time.time()
                time.sleep(float(retry) if retry and retry.isdigit() else 15 * (attempt + 1))
                continue
        except Exception:
            LAST[source] = time.time()
            time.sleep(10 * (attempt + 1))
            continue
        finally:
            LAST[source] = time.time()
        if status == 404 or status == 400:
            path.write_text("{}" if as_json else "", encoding="utf-8")
            return {} if as_json else ""
        if status != 200:
            bump(f"{source}:fallidas")
            return None
        if as_json:
            try:
                parsed = json.loads(body)
            except json.JSONDecodeError:
                bump(f"{source}:fallidas")
                return None
            path.write_text(json.dumps(parsed, ensure_ascii=False), encoding="utf-8")
            return parsed
        path.write_text(body, encoding="utf-8")
        return body
    bump(f"{source}:fallidas")
    return None


class Catalog:
    def __init__(self, path: str):
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        self.artists = {int(a["id"]): a for a in data["artists"]}
        self.albums = {int(a["id"]): a for a in data["albums"]}
        self.persons = {int(p["id"]): p for p in data["persons"]}
        self.orgs = {int(o["id"]): o for o in data["organizations"]}
        self.source_urls = data["sourceUrls"]
        self.identities = data["identities"]
        self.raw_pages = data.get("rawPages") or []
        self.index: dict[str, dict[str, list[int]]] = {}
        for kind, table, field in (("artist", self.artists, "name"), ("person", self.persons, "name"),
                                   ("organization", self.orgs, "name")):
            by: dict[str, list[int]] = {}
            for entity_id, row in table.items():
                by.setdefault(norm(row[field]), []).append(entity_id)
            self.index[kind] = by
        self.albums_by_artist: dict[int, list[dict]] = {}
        for album in self.albums.values():
            self.albums_by_artist.setdefault(int(album["artist_id"]), []).append(album)
        self.various = {i for i, a in self.artists.items() if re.match(r"^(various|varios|va\b|v\.a\.)", a["name"].lower())}

    def unique(self, kind: str, name: str) -> int | None:
        ids = self.index[kind].get(norm(name), [])
        return ids[0] if len(ids) == 1 and norm(name) else None

    def artist_related(self, artist_id: int) -> list[str]:
        return [a["title"] for a in self.albums_by_artist.get(artist_id, [])]

    def album_by_title(self, artist_id: int, title: str) -> dict | None:
        hits = [a for a in self.albums_by_artist.get(artist_id, []) if title_key(a["title"]) == title_key(title)]
        return hits[0] if len(hits) == 1 else None


def row(kind: str, entity_id: int, source: str, url: str, text: str = "", *, lang: str = "es",
        facts: dict | None = None, links: dict | None = None, identity: str) -> dict:
    return {"caseId": f"{kind}:{entity_id}", "kind": kind, "entityId": entity_id, "source": source, "url": url,
            "lang": lang, "text": (text or "").strip()[:MAX_TEXT], "facts": facts or {}, "links": links or {}, "identity": identity}


# --- Lobotoradio -----------------------------------------------------------

LOBO = "https://www.lobotoradio.com"
LOBO_LETTERS = ["0-9"] + [chr(c) for c in range(ord("A"), ord("Z") + 1)]


def lobo_get(url: str) -> str:
    # Misma caché que el cosechador de géneros (sha256 de la URL, .html).
    path = RAW / "lobotoradio" / (hashlib.sha256(url.encode()).hexdigest() + ".html")
    if path.exists():
        return path.read_text(encoding="utf-8")
    body = fetch("lobotoradio-bio", url, url, 10.2, as_json=False)
    if body:
        path.write_text(body, encoding="utf-8")
    return body or ""


def lobo_index(kind: str) -> dict[str, str]:
    found: dict[str, str] = {}
    for letter in LOBO_LETTERS:
        page = 1
        while True:
            body = lobo_get(f"{LOBO}/{kind}/?letra={letter}" + (f"&paged={page}" if page > 1 else ""))
            for slug, name in re.findall(rf'href="{LOBO}/{kind}/([a-z0-9-]+)/?"[^>]*>\s*([^<]+?)\s*<', body):
                found.setdefault(slug, unescape(name).strip())
            if f"paged={page + 1}" not in body.replace("&#038;", "&"):
                break
            page += 1
    print(f"lobotoradio {kind}: {len(found)} fichas", flush=True)
    return found


def lobo_page(body: str) -> dict:
    h1 = re.search(r"<h1[^>]*>(.*?)</h1>", body, re.S)
    meta: dict[str, str] = {}
    for label, value in re.findall(r'<div class="meta-label">\s*([^<:]+):?\s*</div>\s*<div[^>]*class="meta-value[^"]*"[^>]*>(.*?)</div>\s*</div>', body, re.S):
        if label.strip().lower() != "enlaces":
            meta[label.strip().lower()] = re.sub(r"\s+", " ", plain(value)).strip()
    links = {}
    enl = re.search(r'id="enlaces"[^>]*>(.*?)</div>', body, re.S)
    for href, name in re.findall(r'<a href="([^"]+)"[^>]*>\s*([^<]+?)\s*</a>', enl.group(1) if enl else ""):
        links[name.strip()] = href
    content = ""
    m = re.search(r'<div id="content"[^>]*>(.*?)<!--COMMENTS-->', body, re.S)
    if m:
        block = re.sub(r'(?s)<div class="discos".*?</div>\s*</div>', " ", m.group(1))  # rejilla de portadas
        content = plain(block)
        content = re.sub(r"^(?:Bio|Reseña)\s*\n", "", content)
        content = re.sub(r"\n(?:Créditos|Discografía|Discos)\s*$", "", content).strip()
        if re.fullmatch(r"(?s)\s*No hay (?:reseña|bio\w*) disponible.*", content):
            content = ""
    discs = re.findall(r'<div class="discos-titulo">\s*<a href="([^"]+)">\s*([^<]+?)\s*</a>\s*</div>\s*(\d{4})?', body)
    return {"name": plain(h1.group(1)) if h1 else "", "meta": meta, "links": links, "text": content,
            "discs": [f"{unescape(t).strip()} ({y})" if y else unescape(t).strip() for _, t, y in discs],
            "discLinks": [(href, unescape(t).strip(), y) for href, t, y in discs]}


def harvest_lobotoradio(cat: Catalog, limit: int | None) -> list[dict]:
    out: list[dict] = []
    todo: list[tuple[str, str, str]] = []  # (kind_sitio, slug, nombre)
    for kind in ("bandas", "artistas", "discos", "empresas"):
        for slug, name in lobo_index(kind).items():
            todo.append((kind, slug, name))
    album_titles: dict[str, list[int]] = {}
    for album in cat.albums.values():
        album_titles.setdefault(title_key(album["title"]), []).append(int(album["id"]))
    wanted = []
    disc_jobs: list[tuple[int, int, str, str]] = []
    for kind, slug, name in todo:
        key = norm(name)
        hit = (kind in ("bandas", "artistas") and (cat.index["artist"].get(key) or (kind == "artistas" and cat.index["person"].get(key)))) \
            or (kind == "discos" and album_titles.get(title_key(name))) \
            or (kind == "empresas" and cat.index["organization"].get(key))
        if hit:
            wanted.append((kind, slug, name))
    # Primero lo que casa con artistas (y sus discos), después las personas:
    # así los expedientes de artistas y discos no esperan a las ~2.000 fichas
    # de personas (10 s por página).
    wanted.sort(key=lambda item: 0 if cat.index["artist"].get(norm(item[2])) or item[0] != "artistas" else 1)
    print(f"lobotoradio: {len(wanted)} fichas con nombre del catálogo", flush=True)
    if limit:
        wanted = wanted[:limit]
    discs_done = [False]

    def save_partial() -> None:
        if not limit:
            (OUT_DIR / "lobotoradio.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in out), encoding="utf-8")

    def run_discs() -> None:
        if discs_done[0]:
            return
        discs_done[0] = True
        lobo_discs(cat, disc_jobs, out)
        save_partial()

    for n, (kind, slug, name) in enumerate(wanted, 1):
        if kind == "artistas" and not cat.index["artist"].get(norm(name)):
            run_discs()
        url = f"{LOBO}/{kind}/{slug}"
        body = lobo_get(url)
        if not body:
            bump("lobotoradio:sin_pagina")
            continue
        page = lobo_page(body)
        shown = page["name"] or name
        facts = {k: v for k, v in page["meta"].items() if v and k not in ("géneros",)}
        if page["meta"].get("géneros"):
            facts["géneros (Lobotoradio)"] = page["meta"]["géneros"]
        if page["discs"]:
            facts["discos en Lobotoradio"] = page["discs"][:40]
        origin = " ".join(page["meta"].get(k, "") for k in ("origen", "nacimiento", "sede", "país"))
        if origin.strip() and not VZ.search(origin) and kind != "discos":
            bump("lobotoradio:origen_no_vz")
            # Extranjero con vínculo: solo si la página nombra algo del catálogo (abajo).
        whole = page["text"] + " " + " ".join(page["meta"].values()) + " " + " ".join(page["discs"])
        matched = False
        if kind in ("bandas", "artistas"):
            artist_id = cat.unique("artist", shown)
            if artist_id is not None and artist_id not in cat.various:
                proof = mentions(whole, cat.artist_related(artist_id)) if origin.strip() and not VZ.search(origin) else ["sitio de música venezolana"]
                if proof:
                    out.append(row("artist", artist_id, "lobotoradio", url, page["text"], facts=facts, links=page["links"],
                                   identity=f"nombre exacto en Lobotoradio (música de Venezuela), sin homónimos; prueba: {proof[0]}"))
                    matched = True
            if kind == "artistas":
                person_id = cat.unique("person", shown)
                if person_id is not None:
                    proof = mentions(whole, cat.persons[person_id].get("related") or [])
                    if proof:
                        out.append(row("person", person_id, "lobotoradio", url, page["text"], facts=facts, links=page["links"],
                                       identity=f"nombre exacto en Lobotoradio y la ficha nombra «{proof[0]}», con quien el catálogo la relaciona"))
                        matched = True
                    else:
                        bump("lobotoradio:persona_sin_vinculo")
        elif kind == "discos":
            artist_line = page["meta"].get("artista") or page["meta"].get("banda") or page["meta"].get("artistas") or ""
            ids = [i for i in album_titles.get(title_key(shown), [])
                   if norm(cat.artists[int(cat.albums[i]["artist_id"])]["name"]) in norm(artist_line + " " + page["text"][:400])]
            if len(ids) == 1:
                out.append(row("album", ids[0], "lobotoradio", url, page["text"], facts=facts, links=page["links"],
                               identity="título exacto en Lobotoradio y la ficha nombra al artista del disco"))
                matched = True
        elif kind == "empresas":
            org_id = cat.unique("organization", shown)
            if org_id is not None:
                out.append(row("organization", org_id, "lobotoradio", url, page["text"], facts=facts, links=page["links"],
                               identity="nombre exacto en Lobotoradio (empresas de la música venezolana), sin homónimos"))
                matched = True
        bump("lobotoradio:casadas" if matched else "lobotoradio:descartadas")
        if matched and kind in ("bandas", "artistas"):
            artist_id = cat.unique("artist", shown)
            if artist_id is not None:
                for href, title, year in page["discLinks"]:
                    album = cat.album_by_title(artist_id, title)
                    if album:
                        disc_jobs.append((artist_id, int(album["id"]), href, title))
        if n % 50 == 0:
            print(f"lobotoradio {n}/{len(wanted)} {json.dumps(STATS)}", flush=True)
            save_partial()
    run_discs()
    return out


def lobo_discs(cat: Catalog, disc_jobs: list[tuple[int, int, str, str]], out: list[dict]) -> None:
    """Discos: el sitio no tiene índice; se llega desde la ficha ya casada del artista."""
    seen_albums: set[int] = set()
    print(f"lobotoradio: {len(disc_jobs)} discos enlazados desde fichas casadas", flush=True)
    for artist_id, album_id, href, title in disc_jobs:
        if album_id in seen_albums:
            continue
        seen_albums.add(album_id)
        body = lobo_get(href)
        if not body:
            continue
        page = lobo_page(body)
        facts = {k: v for k, v in page["meta"].items() if v}
        credits = re.search(r"<h2>\s*Créditos\s*</h2>(.*?)(?:<!--COMMENTS-->|<h2>)", body, re.S)
        if credits and "No hay créditos" not in credits.group(1):
            facts["créditos (Lobotoradio)"] = re.sub(r"\s+", " ", plain(credits.group(1)))[:1500]
        text = re.sub(r"\n?Créditos\n.*$", "", page["text"], flags=re.S).strip()
        if text or facts:
            out.append(row("album", album_id, "lobotoradio", href, text, facts=facts, links=page["links"],
                           identity=f"disco «{title}» enlazado desde la ficha casada de su artista en Lobotoradio"))
            bump("lobotoradio:album")


# --- Last.fm ----------------------------------------------------------------

LASTFM_MULTI = re.compile(
    r"(there (are|is) (more than one|multiple|several|many|at least \w+|\d+|two|three|four|five)( different| distinct)? (artists?|bands?|acts?|musicians?)\b)"
    r"|hay (varios|m[aá]s de un)|^.{0,200}?(^|[\s:;.])(\(?1[).]|1\s*-)\s.{3,600}?[\s;.](\(?2[).]|2\s*-)\s|_{5,}", re.I | re.S)
LASTFM_VZ_TAG = re.compile(r"venezuel|venezolan|caracas|maracaibo", re.I)


def lastfm_prose(block: dict | None) -> str:
    text = (block or {}).get("content") or (block or {}).get("summary") or ""
    text = re.sub(r"<a [^>]*>Read more on Last\.fm</a>\.?|<a [^>]*>Leer más en Last\.fm</a>\.?", " ", text)
    text = re.sub(r"(User-contributed text|El texto está disponible bajo la licencia).*$", " ", text, flags=re.S)
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", text))).strip()


def harvest_lastfm(cat: Catalog, limit: int | None) -> list[dict]:
    key = env("LASTFM_API_KEY")
    if not key:
        raise SystemExit("falta LASTFM_API_KEY")

    def call(method: str, **params: str) -> dict:
        query = {"method": method, **params, "autocorrect": "0", "format": "json"}
        cache_key = json.dumps(query, sort_keys=True)
        url = "https://ws.audioscrobbler.com/2.0/?" + urllib.parse.urlencode({**query, "api_key": key})
        return fetch("lastfm-bio", cache_key, url, 0.3, retry_codes=(429, 500, 502, 503, 504)) or {}

    out: list[dict] = []
    targets = [i for i in cat.artists if i not in cat.various]
    if limit:
        targets = targets[:limit]
    def one(artist_id: int) -> list[dict]:
        out: list[dict] = []
        name = cat.artists[artist_id]["name"]
        if cat.unique("artist", name) is None:
            bump("lastfm:homonimo_catalogo")
            return out
        en = call("artist.getInfo", artist=name).get("artist") or {}
        if not en or norm(en.get("name", "")) != norm(name):
            bump("lastfm:sin_pagina")
            return out
        bio_en = lastfm_prose(en.get("bio"))
        es = call("artist.getInfo", artist=name, lang="es").get("artist") or {}
        bio_es = lastfm_prose(es.get("bio"))
        if LASTFM_MULTI.search(bio_en) or LASTFM_MULTI.search(bio_es):
            bump("lastfm:agrupa_homonimos")
            return out
        tags = [t.get("name", "") for t in ((call("artist.getTopTags", artist=name).get("toptags") or {}).get("tag") or []) if isinstance(t, dict)]
        heads = [re.split(r"(?<=[.!?])\s+", b)[:2] for b in (bio_en, bio_es) if b]
        vz_bio = any(VZ.search(s) for h in heads for s in h)
        related = mentions(bio_en + " " + bio_es, cat.artist_related(artist_id))
        if not (any(LASTFM_VZ_TAG.search(t) for t in tags) or vz_bio or related):
            bump("lastfm:sin_marca_vz")
            return out
        proof = "etiqueta venezolana" if any(LASTFM_VZ_TAG.search(t) for t in tags) else "biografía nombra Venezuela al abrir" if vz_bio else f"biografía nombra su disco «{related[0]}»"
        url = en.get("url") or ""
        identity = f"nombre exacto en Last.fm (API), sin homónimos; prueba: {proof}"
        stats = en.get("stats") or {}
        facts = {"oyentes Last.fm": stats.get("listeners")} if stats.get("listeners") else {}
        bump("lastfm:casados")
        if bio_es and bio_es != bio_en:
            out.append(row("artist", artist_id, "lastfm", url, bio_es, lang="es", facts=facts, identity=identity))
        if bio_en:
            out.append(row("artist", artist_id, "lastfm", url, bio_en, lang="en", facts=facts, identity=identity))
        elif not bio_es:
            out.append(row("artist", artist_id, "lastfm", url, "", facts=facts, identity=identity))
        for album in cat.albums_by_artist.get(artist_id, []):
            title = re.sub(r"\s*\((?:\d{4}|ep|lp|single|demo)\)\s*$", "", album["title"], flags=re.I)
            rec = call("album.getInfo", artist=name, album=title).get("album") or {}
            if not rec or title_key(rec.get("name", "")) != title_key(album["title"]):
                continue
            rec_es = call("album.getInfo", artist=name, album=title, lang="es").get("album") or {}
            wiki_en, wiki_es = lastfm_prose(rec.get("wiki")), lastfm_prose(rec_es.get("wiki"))
            aid = int(album["id"])
            ident = "artista casado en Last.fm + título exacto del disco (API)"
            if wiki_es and wiki_es != wiki_en and len(wiki_es) > 60:
                out.append(row("album", aid, "lastfm", rec.get("url") or "", wiki_es, lang="es", identity=ident))
            if len(wiki_en) > 60:
                out.append(row("album", aid, "lastfm", rec.get("url") or "", wiki_en, lang="en", identity=ident))
                bump("lastfm:resenas")
        return out

    out: list[dict] = []
    with ThreadPoolExecutor(max_workers=6) as pool:
        for n, rows in enumerate(pool.map(one, targets), 1):
            out.extend(rows)
            if n % 100 == 0:
                print(f"lastfm {n}/{len(targets)} {json.dumps(STATS)}", flush=True)
    return out


# --- Wikipedia --------------------------------------------------------------

MUSIC_DISAMBIG = {
    "es": ["banda", "grupo musical", "grupo", "cantante", "músico", "musico", "banda venezolana", "cantautor", "guitarrista", "álbum", "disco", "discográfica", "sello discográfico"],
    "en": ["band", "musician", "singer", "Venezuelan band", "Venezuelan musician", "Venezuelan singer", "album", "record label", "guitarist"],
}


def contact_ua() -> str:
    """Wikimedia exige contacto en el User-Agent; se usa el contacto configurado del proyecto."""
    contact = env("GENRES_EXTERNAL_CONTACT")
    return f"{UA.rstrip(')')}; +{contact})" if contact else UA


def wiki_api(lang: str, params: dict) -> dict:
    params = {**params, "format": "json", "formatversion": "2"}
    body = urllib.parse.urlencode(params)
    return fetch(f"wikipedia-bio-{lang}", body, f"https://{lang}.wikipedia.org/w/api.php?" + body, 1.0,
                 headers={"User-Agent": contact_ua()}) or {}


def wiki_resolve(lang: str, chunk: list[str], props: dict) -> tuple[dict[str, str], dict[str, dict]]:
    data = wiki_api(lang, {"action": "query", "titles": "|".join(chunk), "redirects": "1", **props})
    query = data.get("query") or {}
    mapping = {t: t for t in chunk}
    for item in (query.get("normalized") or []) + (query.get("redirects") or []):
        for asked, target in list(mapping.items()):
            if target == item.get("from"):
                mapping[asked] = item.get("to")
    pages = {p.get("title"): p for p in query.get("pages") or [] if not p.get("missing") and not p.get("invalid")}
    return mapping, pages


def wiki_pages(lang: str, titles: list[str]) -> dict[str, dict]:
    """título pedido → página (categorías y extracto), siguiendo redirecciones.
    Primero se ve qué títulos existen (50 por petición, sin desambiguaciones);
    el texto solo se pide para esos (20 por petición, el tope de extracts)."""
    exists: dict[str, str] = {}
    for start in range(0, len(titles), 50):
        chunk = titles[start:start + 50]
        mapping, pages = wiki_resolve(lang, chunk, {"prop": "pageprops", "ppprop": "disambiguation"})
        for asked, target in mapping.items():
            page = pages.get(target)
            if page and "disambiguation" not in (page.get("pageprops") or {}):
                exists[asked] = page["title"]
        if start % 5000 == 0:
            print(f"wikipedia {lang}: {start}/{len(titles)} títulos, {len(exists)} existen", flush=True)
    targets = sorted(set(exists.values()))
    detail: dict[str, dict] = {}
    for start in range(0, len(targets), 20):
        chunk = targets[start:start + 20]
        _, pages = wiki_resolve(lang, chunk, {"prop": "categories|extracts", "cllimit": "max", "explaintext": "1", "exlimit": "20"})
        detail.update(pages)
    return {asked: detail[title] for asked, title in exists.items() if title in detail}


def wiki_clean(extract: str) -> str:
    cut = re.split(r"\n=+ ?(Referencias|Enlaces externos|Véase también|Notas|Bibliografía|References|External links|See also|Notes|Further reading|Discografía|Discography)\b", extract or "")[0]
    return re.sub(r"\n{3,}", "\n\n", cut).strip()


def harvest_wikipedia(cat: Catalog, limit: int | None, lobo_links: dict[str, dict]) -> list[dict]:
    out: list[dict] = []
    jobs: list[tuple[str, int, str, list[str]]] = []  # kind, id, name, related
    for i, a in cat.artists.items():
        if i not in cat.various:
            jobs.append(("artist", i, a["name"], cat.artist_related(i)))
    for i, p in cat.persons.items():
        jobs.append(("person", i, p["name"], p.get("related") or []))
    for i, o in cat.orgs.items():
        jobs.append(("organization", i, o["name"], o.get("related") or []))
    if limit:
        jobs = jobs[:limit]
    for lang in ("es", "en"):
        # Enlaces de Lobotoradio: la página exacta que la ficha casada enlaza.
        linked: dict[str, str] = {}
        for case_id, links in lobo_links.items():
            for label, href in links.items():
                if f"{lang}.wikipedia.org/wiki/" in href:
                    linked[case_id] = urllib.parse.unquote(href.split("/wiki/", 1)[1]).replace("_", " ").split("#")[0]
        titles: dict[str, list[tuple[str, int, list[str], bool]]] = {}
        for kind, entity_id, name, related in jobs:
            case_id = f"{kind}:{entity_id}"
            if case_id in linked:
                titles.setdefault(linked[case_id], []).append((kind, entity_id, related, True))
                continue
            if cat.unique(kind, name) is None or len(norm(name)) < 3:
                continue
            disambig = MUSIC_DISAMBIG[lang] if kind != "person" else [d for d in MUSIC_DISAMBIG[lang] if d in ("músico", "cantante", "guitarrista", "cantautor", "musician", "singer", "guitarist")]
            for title in [name] + [f"{name} ({d})" for d in disambig]:
                titles.setdefault(title, []).append((kind, entity_id, related, False))
        pages = wiki_pages(lang, list(titles))
        seen: set[tuple[str, int]] = set()
        for asked, page in pages.items():
            for kind, entity_id, related, via_lobo in titles[asked]:
                if (kind, entity_id) in seen:
                    continue
                cats = " ".join(c.get("title", "") for c in page.get("categories") or [])
                text = wiki_clean(page.get("extract") or "")
                if len(text) < 80:
                    continue
                head = text[:600]
                musical = re.search(r"m[uú]sic|banda|grupo|cantante|rock|metal|punk|pop|disco|álbum|sello|discogr|band|singer|album|record label|guitar", head, re.I)
                vz = VZ.search(cats) or VZ.search(head)
                proof = "enlazada desde su ficha de Lobotoradio" if via_lobo else None
                if not proof:
                    rel = mentions(text, related)
                    if musical and vz:
                        proof = "artículo musical clasificado como venezolano"
                    elif musical and rel:
                        proof = f"el artículo nombra «{rel[0]}», relacionado en el catálogo"
                if not proof:
                    bump("wikipedia:sin_prueba")
                    continue
                seen.add((kind, entity_id))
                url = f"https://{lang}.wikipedia.org/wiki/" + urllib.parse.quote(page["title"].replace(" ", "_"))
                out.append(row(kind, entity_id, f"wikipedia-{lang}", url, text, lang=lang,
                               identity=f"título «{page['title']}» casa con la ficha; prueba: {proof}"))
                bump(f"wikipedia-{lang}:{kind}")
        print(f"wikipedia {lang}: {json.dumps(STATS)}", flush=True)
    # Discos: artículo del disco que nombra a nuestro artista.
    for lang in ("es", "en"):
        wanted: dict[str, list[int]] = {}
        for album in cat.albums.values():
            artist = cat.artists[int(album["artist_id"])]["name"]
            suffix = ["álbum", f"álbum de {artist}"] if lang == "es" else ["album", f"{artist} album"]
            for title in [f"{album['title']} ({s})" for s in suffix]:
                wanted.setdefault(title, []).append(int(album["id"]))
        for asked, page in wiki_pages(lang, list(wanted)).items():
            text = wiki_clean(page.get("extract") or "")
            for album_id in wanted[asked]:
                artist = cat.artists[int(cat.albums[album_id]["artist_id"])]["name"]
                if len(text) > 80 and norm(artist) in norm(text[:800]):
                    url = f"https://{lang}.wikipedia.org/wiki/" + urllib.parse.quote(page["title"].replace(" ", "_"))
                    out.append(row("album", album_id, f"wikipedia-{lang}", url, text, lang=lang,
                                   identity="artículo del disco con título exacto que nombra al artista"))
                    bump(f"wikipedia-{lang}:album")
    return out


# --- Venciclopedia ------------------------------------------------------------

def harvest_venciclopedia(cat: Catalog, limit: int | None, lobo_links: dict[str, dict]) -> list[dict]:
    api = "https://www.venciclopedia.org/api.php"
    jobs: dict[str, list[tuple[str, int, list[str], bool]]] = {}
    linked = {}
    for case_id, links in lobo_links.items():
        for href in links.values():
            if "venciclopedia.org" in href:
                m = re.search(r"title=([^&]+)|/wiki/([^?#]+)|venciclopedia\.org/([^?#/]+)$", href)
                if m:
                    linked[case_id] = urllib.parse.unquote(next(g for g in m.groups() if g)).replace("_", " ")
    for kind, table in (("artist", cat.artists), ("person", cat.persons), ("organization", cat.orgs)):
        for entity_id, entity in table.items():
            case_id = f"{kind}:{entity_id}"
            related = cat.artist_related(entity_id) if kind == "artist" else entity.get("related") or []
            if case_id in linked:
                jobs.setdefault(linked[case_id], []).append((kind, entity_id, related, True))
            elif cat.unique(kind, entity["name"]) is not None and len(norm(entity["name"])) >= 3 and entity_id not in (cat.various if kind == "artist" else ()):
                jobs.setdefault(entity["name"], []).append((kind, entity_id, related, False))
    titles = list(jobs)
    if limit:
        titles = titles[:limit]
    out: list[dict] = []
    for start in range(0, len(titles), 50):
        chunk = titles[start:start + 50]
        params = {"action": "query", "titles": "|".join(chunk), "redirects": "1", "prop": "revisions|info",
                  "rvprop": "content", "rvslots": "main", "inprop": "url", "format": "json", "formatversion": "2"}
        body = urllib.parse.urlencode(params)
        data = fetch("venciclopedia-bio", body, api + "?" + body, 10.2) or {}
        query = data.get("query") or {}
        mapping = {t: t for t in chunk}
        for item in (query.get("normalized") or []) + (query.get("redirects") or []):
            for asked, target in list(mapping.items()):
                if target == item.get("from"):
                    mapping[asked] = item.get("to")
        pages = {p.get("title"): p for p in query.get("pages") or [] if not p.get("missing")}
        for asked, target in mapping.items():
            page = pages.get(target)
            if not page:
                continue
            wikitext = (((page.get("revisions") or [{}])[0].get("slots") or {}).get("main") or {}).get("content", "")
            if re.search(r"\{\{\s*desambig", wikitext, re.I):
                continue
            text = wikitext_plain(wikitext)
            if len(text) < 120:
                continue
            for kind, entity_id, related, via_lobo in jobs[asked]:
                musical = re.search(r"\b(banda|agrupaci[oó]n musical|grupo (?:musical|de rock|de pop|de metal)|cantante|m[uú]sico|cantautor|compositor|guitarrista|baterista|bajista|tecladista|vocalista|productor musical|sello discogr|disquera|casa discogr|estudio de grabaci)", text[:800], re.I)
                rel = mentions(text, related)
                proof = "enlazada desde su ficha de Lobotoradio" if via_lobo else (f"nombra «{rel[0]}»" if rel and musical else ("artículo musical de la enciclopedia venezolana" if musical and kind != "person" else None))
                if not proof:
                    bump("venciclopedia:sin_prueba")
                    continue
                out.append(row(kind, entity_id, "venciclopedia", page.get("fullurl") or "", text,
                               identity=f"título exacto en La Venciclopedia; prueba: {proof}"))
                bump(f"venciclopedia:{kind}")
        print(f"venciclopedia {start + len(chunk)}/{len(titles)} {json.dumps(STATS)}", flush=True)
    return out


def wikitext_plain(text: str) -> str:
    text = re.sub(r"(?s)<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->", "", text)
    for _ in range(4):
        text = re.sub(r"\{\{[^{}]*\}\}", "", text)
    text = re.sub(r"\[\[(?:Archivo|File|Imagen|Image|Categoría|Category):[^\]]*\]\]", "", text, flags=re.I)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", text)
    text = re.sub(r"\[https?://\S+ ([^\]]+)\]|\[https?://\S+\]", r"\1", text)
    text = re.sub(r"'{2,}", "", text)
    text = re.split(r"\n=+ ?(Referencias|Enlaces externos|Véase también|Notas|Bibliografía|Fuentes)\b", text)[0]
    text = plain(text)
    return re.sub(r"^\s*[{|!].*$", "", text, flags=re.M).strip()


# --- Discogs ----------------------------------------------------------------

def discogs_clean(profile: str) -> str:
    text = re.sub(r"\[(?:a|l|r|m)=?([^\]]*)\]", r"\1", profile or "")
    text = re.sub(r"\[url=[^\]]*\]([^\[]*)\[/url\]", r"\1", text)
    text = re.sub(r"\[/?[biu]\]", "", text)
    return text.strip()


def harvest_discogs(cat: Catalog, limit: int | None, lobo_links: dict[str, dict]) -> list[dict]:
    token = env("DISCOGS_TOKEN")
    if not token:
        raise SystemExit("falta DISCOGS_TOKEN")
    headers = {"Authorization": f"Discogs token={token}"}

    def get(path: str) -> dict:
        return fetch("discogs-bio", path, "https://api.discogs.com" + path, 1.1, headers=headers) or {}

    known: dict[str, str] = {}
    for ident in cat.identities:
        if ident["source"] == "discogs":
            known[f"{ident['kind']}:{ident['id']}"] = str(ident["external_id"])
    for case_id, links in lobo_links.items():
        for href in links.values():
            m = re.search(r"discogs\.com/(?:[a-z]{2}/)?(artist|label|release|master)/(\d+)", href)
            if m and case_id not in known:
                known[case_id] = m.group(2) if m.group(1) in ("artist", "label") else f"{m.group(1)}:{m.group(2)}"
    out: list[dict] = []
    jobs = [("artist", i, a["name"]) for i, a in cat.artists.items() if i not in cat.various] \
        + [("organization", i, o["name"]) for i, o in cat.orgs.items()] \
        + [("person", int(c.split(":")[1]), "") for c in known if c.startswith("person:")] \
        + [("album", int(c.split(":")[1]), "") for c in known if c.startswith("album:")]
    if limit:
        jobs = jobs[:limit]
    def one(job: tuple[str, int, str]) -> list[dict]:
        kind, entity_id, name = job
        out: list[dict] = []
        case_id = f"{kind}:{entity_id}"
        ext = known.get(case_id)
        proof = "identidad ya confirmada (géneros) o enlazada desde Lobotoradio" if ext else None
        if kind == "album":
            if not ext:
                return out
            kind_path = "masters" if ext.startswith("master:") else "releases"
            data = get(f"/{kind_path}/{ext.split(':')[-1]}")
            notes = discogs_clean(data.get("notes") or "")
            facts = {k: v for k, v in {
                "país (Discogs)": data.get("country"), "publicado (Discogs)": data.get("released"),
                "sellos (Discogs)": ", ".join(f"{l.get('name')} {l.get('catno') or ''}".strip() for l in data.get("labels") or []),
                "formato (Discogs)": ", ".join(" ".join([f.get("name", "")] + (f.get("descriptions") or [])) for f in data.get("formats") or []),
                "créditos (Discogs)": "; ".join(f"{e.get('name')} ({e.get('role')})" for e in (data.get("extraartists") or [])[:40]),
            }.items() if v}
            if notes or facts:
                out.append(row("album", entity_id, "discogs", data.get("uri") or f"https://www.discogs.com/{kind_path[:-1]}/{ext.split(':')[-1]}",
                               notes, lang="en", facts=facts, identity=proof))
                bump("discogs:album")
            return out
        if not ext:
            if cat.unique(kind, name) is None or len(norm(name)) < 3:
                return out
            search = get("/database/search?" + urllib.parse.urlencode({"q": name, "type": "label" if kind == "organization" else "artist", "per_page": 10}))
            hits = [r for r in search.get("results") or [] if norm(re.sub(r"\s*\(\d+\)$", "", r.get("title", ""))) == norm(name)]
            if not hits:
                bump("discogs:sin_candidato")
                return out
            candidates = []
            for hit in hits[:3]:
                detail = get(f"/{'labels' if kind == 'organization' else 'artists'}/{hit['id']}")
                profile = discogs_clean(detail.get("profile") or "")
                related = cat.artist_related(entity_id) if kind == "artist" else cat.orgs[entity_id].get("related") or []
                rel = mentions(profile, related)
                if VZ.search(profile) or VZ.search(detail.get("contact_info") or "") or rel:
                    candidates.append((hit["id"], detail, "perfil nombra Venezuela" if VZ.search(profile + (detail.get("contact_info") or "")) else f"perfil nombra «{rel[0]}»"))
            if len(candidates) != 1:
                bump("discogs:sin_prueba" if not candidates else "discogs:ambiguo")
                return out
            ext, detail, proof = str(candidates[0][0]), candidates[0][1], candidates[0][2]
        else:
            if ":" in ext:
                return out
            detail = get(f"/{'labels' if kind == 'organization' else 'artists'}/{ext}")
        profile = discogs_clean(detail.get("profile") or "")
        facts = {}
        if detail.get("realname"):
            facts["nombre real (Discogs)"] = detail["realname"]
        if detail.get("members"):
            facts["miembros (Discogs)"] = ", ".join(m.get("name", "") for m in detail["members"])[:600]
        if detail.get("groups"):
            facts["grupos (Discogs)"] = ", ".join(g.get("name", "") for g in detail["groups"])[:600]
        if detail.get("namevariations"):
            facts["variantes de nombre (Discogs)"] = ", ".join(detail["namevariations"][:10])
        if detail.get("parent_label"):
            facts["sello matriz (Discogs)"] = detail["parent_label"].get("name")
        if detail.get("contact_info"):
            facts["contacto (Discogs)"] = detail["contact_info"][:300]
        if profile or facts:
            out.append(row(kind, entity_id, "discogs", detail.get("uri") or f"https://www.discogs.com/{'label' if kind == 'organization' else 'artist'}/{ext}",
                           profile, lang="en", facts=facts,
                           identity=proof if known.get(case_id) else f"nombre exacto en Discogs, sin homónimos; prueba: {proof}"))
            bump(f"discogs:{kind}")
        return out

    out: list[dict] = []
    with ThreadPoolExecutor(max_workers=3) as pool:
        for n, rows in enumerate(pool.map(one, jobs), 1):
            out.extend(rows)
            if n % 100 == 0:
                print(f"discogs {n}/{len(jobs)} {json.dumps(STATS)}", flush=True)
    return out


# --- MusicBrainz ------------------------------------------------------------

def harvest_musicbrainz(cat: Catalog, limit: int | None) -> list[dict]:
    def get(path: str, params: dict) -> dict:
        url = "https://musicbrainz.org/ws/2/" + path + "?" + urllib.parse.urlencode({**params, "fmt": "json"})
        return fetch("musicbrainz-bio", url, url, 1.1, headers={"Accept": "application/json", "User-Agent": contact_ua()}) or {}

    def one(artist_id: int) -> list[dict]:
        name = cat.artists[artist_id]["name"]
        if cat.unique("artist", name) is None:
            return []
        found = get("artist", {"query": f'artist:"{name}" AND country:VE', "limit": 5})
        hits = [a for a in found.get("artists") or [] if norm(a.get("name", "")) == norm(name)]
        if len(hits) != 1:
            return []
        mbid = hits[0]["id"]
        detail = get(f"artist/{mbid}", {"inc": "artist-rels+url-rels+annotation+aliases"})
        span = detail.get("life-span") or {}
        members = [f"{r.get('artist', {}).get('name')} ({', '.join(r.get('attributes') or []) or 'miembro'}"
                   f"{', ' + r['begin'][:4] if r.get('begin') else ''}{'–' + r['end'][:4] if r.get('end') else ''})"
                   for r in detail.get("relations") or [] if r.get("type") == "member of band" and r.get("direction") == "backward"]
        facts = {k: v for k, v in {
            "tipo (MusicBrainz)": detail.get("type"),
            "área (MusicBrainz)": (detail.get("area") or {}).get("name"),
            "zona de inicio (MusicBrainz)": (detail.get("begin-area") or {}).get("name"),
            "inicio (MusicBrainz)": span.get("begin"), "fin (MusicBrainz)": span.get("end"),
            "desambiguación (MusicBrainz)": detail.get("disambiguation"),
            "miembros (MusicBrainz)": "; ".join(members[:30]),
        }.items() if v}
        annotation = (detail.get("annotation") or "").strip()
        if not (facts or annotation):
            return []
        bump("musicbrainz:artist")
        return [row("artist", artist_id, "musicbrainz", f"https://musicbrainz.org/artist/{mbid}", annotation, lang="en",
                    facts=facts, identity="nombre exacto + país Venezuela en MusicBrainz, candidato único")]

    targets = [i for i in cat.artists if i not in cat.various]
    if limit:
        targets = targets[:limit]
    out: list[dict] = []
    # La búsqueda tarda ~15 s en el servidor de MusicBrainz: 16 hilos esperan en
    # paralelo, pero el limitador de fetch() sigue soltando 1 petición por segundo.
    with ThreadPoolExecutor(max_workers=16) as pool:
        for n, rows in enumerate(pool.map(one, targets), 1):
            out.extend(rows)
            if n % 200 == 0:
                print(f"musicbrainz {n}/{len(targets)} {json.dumps(STATS)}", flush=True)
    return out


# --- TheAudioDB ---------------------------------------------------------------

def harvest_theaudiodb(cat: Catalog, limit: int | None) -> list[dict]:
    out: list[dict] = []
    targets = [i for i in cat.artists if i not in cat.various]
    if limit:
        targets = targets[:limit]
    for n, artist_id in enumerate(targets, 1):
        name = cat.artists[artist_id]["name"]
        if cat.unique("artist", name) is None:
            continue
        url = "https://www.theaudiodb.com/api/v1/json/123/search.php?" + urllib.parse.urlencode({"s": name})
        data = fetch("theaudiodb-bio", url, url, 2.2) or {}
        hits = [a for a in data.get("artists") or [] if norm(a.get("strArtist", "")) == norm(name)]
        hits = [a for a in hits if VZ.search((a.get("strCountry") or "") + " " + (a.get("strBiographyEN") or "")[:400])]
        if len(hits) != 1:
            continue
        a = hits[0]
        facts = {k: v for k, v in {"formado (TheAudioDB)": a.get("intFormedYear"), "nacimiento (TheAudioDB)": a.get("intBornYear"),
                                   "separado (TheAudioDB)": a.get("strDisbanded"), "país (TheAudioDB)": a.get("strCountry")}.items() if v}
        link = f"https://www.theaudiodb.com/artist/{a.get('idArtist')}"
        ident = "nombre exacto + país/biografía venezolana en TheAudioDB, candidato único"
        if (a.get("strBiographyES") or "").strip():
            out.append(row("artist", artist_id, "theaudiodb", link, a["strBiographyES"], lang="es", facts=facts, identity=ident))
        if (a.get("strBiographyEN") or "").strip():
            out.append(row("artist", artist_id, "theaudiodb", link, a["strBiographyEN"], lang="en", facts=facts, identity=ident))
        bump("theaudiodb:artist")
        if n % 200 == 0:
            print(f"theaudiodb {n}/{len(targets)} {json.dumps(STATS)}", flush=True)
    return out


# --- RHV directorio (caché del cosechador de géneros) -------------------------

def harvest_rhv(cat: Catalog, limit: int | None) -> list[dict]:
    letters = ["00"] + [chr(c) for c in range(ord("a"), ord("z") + 1)]
    entries = []
    for letter in letters:
        for kind in ("posts", "pages"):
            page = 1
            while True:
                url = f"https://rockhechovenezuela.com/{letter}/wp-json/wp/v2/{kind}?per_page=100&page={page}&_fields=link,title,content"
                path = RAW / "rock-hecho-en-venezuela-directorio" / (hashlib.sha256(url.encode()).hexdigest() + ".json")
                batch = json.loads(path.read_text(encoding="utf-8")) if path.exists() else fetch("rock-hecho-en-venezuela-directorio-bio", url, url, 1.0)
                if not isinstance(batch, list) or not batch:
                    break
                for item in batch:
                    entries.append({"url": item["link"], "title": plain(item["title"]["rendered"]), "text": plain(item["content"]["rendered"])})
                if len(batch) < 100:
                    break
                page += 1
    counts: dict[str, int] = {}
    for e in entries:
        counts[norm(e["title"])] = counts.get(norm(e["title"]), 0) + 1
    out = []
    for e in entries:
        artist_id = cat.unique("artist", e["title"])
        if artist_id is None or counts[norm(e["title"])] > 1 or len(e["text"]) < 120:
            continue
        text = re.sub(r"^Directorio\s*«[^»]*»\s*_+\s*", "", e["text"])
        out.append(row("artist", artist_id, "rhv-directorio", e["url"], text,
                       identity="nombre exacto en el directorio de rock venezolano RHV, sin homónimos"))
        bump("rhv:artist")
    return out[:limit] if limit else out


# --- Vzla Rockea (feed de Blogger, caché) -------------------------------------

def harvest_vzlarockea(cat: Catalog, limit: int | None) -> list[dict]:
    out = []
    start = 1
    while True:
        url = f"https://www.vzlarockea.com/feeds/posts/default?alt=json&max-results=150&start-index={start}"
        data = fetch("vzlarockea-bio", url, url, 1.0) or {}
        entries = (data.get("feed") or {}).get("entry") or []
        for entry in entries:
            title = (entry.get("title") or {}).get("$t", "")
            link = next((l["href"] for l in entry.get("link") or [] if l.get("rel") == "alternate"), "")
            text = plain((entry.get("content") or {}).get("$t", ""))
            m = re.match(r"^(.*?)\s+(?:-|–)\s+(.+)$", title)
            disco = re.match(r"^(.*?)\s+(?:Discograf[ií]a|Discography)\b", title, re.I)
            if disco:
                artist_id = cat.unique("artist", disco.group(1))
                if artist_id is not None and len(text) > 80:
                    out.append(row("artist", artist_id, "vzlarockea", link, text, identity="post de discografía del blog venezolano Vzla Rockea con el nombre exacto"))
                    bump("vzlarockea:artist")
            elif m:
                artist_id = cat.unique("artist", m.group(1))
                album = cat.album_by_title(artist_id, re.sub(r"\s*\(\d{4}\)\s*$", "", m.group(2))) if artist_id is not None else None
                if album and len(text) > 80:
                    out.append(row("album", int(album["id"]), "vzlarockea", link, text, identity="post «Artista - Disco» del blog venezolano Vzla Rockea con título exacto"))
                    bump("vzlarockea:album")
        if len(entries) < 150:
            break
        start += 150
    return out[:limit] if limit else out


# --- Sincopa (páginas guardadas) ----------------------------------------------

def harvest_sincopa(cat: Catalog, limit: int | None) -> list[dict]:
    by_url: dict[str, list[tuple[str, int]]] = {}
    for item in cat.source_urls:
        if item["source"] == "sincopa":
            by_url.setdefault(re.sub(r"^https?://(www\.)?", "", item["url"]).rstrip("/").lower(), []).append((item["kind"], int(item["id"])))
    files: dict[str, Path] = {}
    for page in cat.raw_pages:
        files[page["url"]] = ROOT / "data" / page["stored_path"] if not str(page["stored_path"]).startswith("/") else Path(page["stored_path"])
    for item in cat.source_urls:
        if item["source"] == "sincopa" and item["url"] not in files:
            extra = RAW / "sincopa-extra" / (hashlib.sha256(item["url"].encode()).hexdigest() + ".html")
            if extra.exists():
                files[item["url"]] = extra
    out = []
    if True:
        for url, path in files.items():
            if not path.exists():
                bump("sincopa:sin_archivo")
                continue
            raw = path.read_bytes().decode("latin-1")
            targets = by_url.get(re.sub(r"^https?://(www\.)?", "", url).rstrip("/").lower(), [])
            if not targets:
                continue
            text = plain(raw)
            text = re.sub(r"(?s)copyright ©.*$", "", text)
            text = re.sub(r"\s*\n\s*", "\n", text)
            prose = [p for p in re.split(r"\n", text) if len(p) > 200 and "." in p]
            for kind, entity_id in targets:
                if kind not in ("artist", "album"):
                    continue
                out.append(row(kind, entity_id, "sincopa", "https://" + re.sub(r"^https?://", "", url), text[:6000],
                               lang="en" if re.search(r"\b(the|and|with|was)\b", " ".join(prose)[:500]) else "es",
                               identity="URL de Sincopa ya aceptada como origen de la ficha"))
                bump(f"sincopa:{kind}")
    return out[:limit] if limit else out


def lobo_links_from_ledger() -> dict[str, dict]:
    path = OUT_DIR / "lobotoradio.jsonl"
    links: dict[str, dict] = {}
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                r = json.loads(line)
                links.setdefault(r["caseId"], {}).update(r.get("links") or {})
    return links


def main() -> None:
    if len(sys.argv) < 3:
        raise SystemExit(__doc__)
    cat = Catalog(sys.argv[1])
    source = sys.argv[2]
    limit = int(sys.argv[sys.argv.index("--limit") + 1]) if "--limit" in sys.argv else None
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    runners = {
        "lobotoradio": lambda: harvest_lobotoradio(cat, limit),
        "lastfm": lambda: harvest_lastfm(cat, limit),
        "wikipedia": lambda: harvest_wikipedia(cat, limit, lobo_links_from_ledger()),
        "venciclopedia": lambda: harvest_venciclopedia(cat, limit, lobo_links_from_ledger()),
        "discogs": lambda: harvest_discogs(cat, limit, lobo_links_from_ledger()),
        "musicbrainz": lambda: harvest_musicbrainz(cat, limit),
        "theaudiodb": lambda: harvest_theaudiodb(cat, limit),
        "rhv": lambda: harvest_rhv(cat, limit),
        "vzlarockea": lambda: harvest_vzlarockea(cat, limit),
        "sincopa": lambda: harvest_sincopa(cat, limit),
    }
    if source not in runners:
        raise SystemExit(f"fuente desconocida: {source}; opciones: {', '.join(runners)}")
    started = time.time()
    rows = runners[source]()
    suffix = "-sample" if limit else ""
    (OUT_DIR / f"{source}{suffix}.jsonl").write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    kinds: dict[str, int] = {}
    for r in rows:
        kinds[r["kind"]] = kinds.get(r["kind"], 0) + 1
    summary = {"source": source, "rows": len(rows), "entities": len({r["caseId"] for r in rows}), "byKind": kinds,
               "withText": sum(1 for r in rows if len(r["text"]) >= 80), "stats": STATS, "minutes": round((time.time() - started) / 60, 1)}
    (OUT_DIR / f"{source}{suffix}.summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
