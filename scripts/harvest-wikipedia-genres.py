#!/usr/bin/env python3
"""Géneros de Wikipedia (es y en) para fichas sin principal.

Regla de Brian: una fuente basta. Identidad: un artículo cuyo título es el
nombre exacto (o nombre + desambiguador musical: «(banda)», «(grupo musical)»,
«(band)», «(Venezuelan band)»…), que Wikipedia clasifica como venezolano (una
categoría con «de Venezuela»/«venezolan»/«Venezuelan») y sin otro artista del
catálogo con el mismo nombre.

Géneros del artista, en este orden de preferencia:
  1. el campo «género»/«genre» de la ficha (infobox), en su orden;
  2. si no hay ficha con género, las categorías de género venezolanas
     («Grupos de heavy metal de Venezuela», «Venezuelan punk rock groups»).
Discos: artículo «Título», «Título (álbum)», «Título (álbum de X)», «Título
(X album)» cuya ficha nombra a nuestro artista → género de su ficha, solo al
disco. La introducción del artículo se guarda como texto propio.

Consultas por lotes de 50 títulos (action=query) y una petición cada 2 s,
respetando Retry-After ante 429. Caché en data/raw/wikipedia.
Salida: reports/genre-laya-evidence-wikipedia-2026-09-26.jsonl y
reports/genre-new-texts-wikipedia-2026-09-27.jsonl.
Uso: python3 scripts/harvest-wikipedia-genres.py <pending.json>
"""
from __future__ import annotations

import hashlib
import json
import re
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / "data" / "raw" / "wikipedia"
OUT = ROOT / "reports" / "genre-laya-evidence-wikipedia-2026-09-26.jsonl"
TEXTS = ROOT / "reports" / "genre-new-texts-wikipedia-2026-09-27.jsonl"
UA = "CRV-catalogo/1.0 (catalogo de rock venezolano; uso no comercial) python-urllib"
DELAY = 2.0
FAILED = [0]
_last = [0.0]
ARTIST_SUFFIX = {
    "es": ["", " (banda)", " (grupo musical)", " (banda venezolana)", " (grupo venezolano)", " (cantante)", " (músico)", " (rapero)", " (cantautor)"],
    "en": ["", " (band)", " (Venezuelan band)", " (musician)", " (singer)", " (rapper)"],
}
VZ_CAT = re.compile(r"de Venezuela|venezolan|Venezuelan", re.I)
GENRE_CAT = {
    "es": re.compile(r"^Categoría:(?:Grupos|Músicos|Cantantes|Artistas|Guitarristas|Raperos) de (.+?) de Venezuela$"),
    "en": re.compile(r"^Category:Venezuelan (.+?) (?:musical groups|groups|musicians|singers|guitarists|rappers|bands)$"),
}


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", "", text)


def api(lang: str, params: dict) -> dict:
    params = {**params, "format": "json", "formatversion": "2"}
    body = urllib.parse.urlencode(params).encode()
    key = f"{lang}:{body.decode()}"
    path = CACHE / (hashlib.sha256(key.encode()).hexdigest() + ".json")
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    data: dict = {}
    for attempt in range(6):
        wait = DELAY - (time.time() - _last[0])
        if wait > 0:
            time.sleep(wait)
        try:
            req = urllib.request.Request(f"https://{lang}.wikipedia.org/w/api.php", data=body, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=60) as res:
                data = json.loads(res.read().decode("utf-8"))
            _last[0] = time.time()
            break
        except urllib.error.HTTPError as exc:
            _last[0] = time.time()
            time.sleep(int(exc.headers.get("Retry-After") or 30) + 5 * attempt)
        except Exception:
            _last[0] = time.time()
            time.sleep(15 * (attempt + 1))
    if not data:
        FAILED[0] += 1
        return {}
    path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    return data


def lookup(lang: str, titles: list[str], props: str) -> dict[str, dict]:
    """Título pedido → página (siguiendo redirecciones), por lotes de 50."""
    out: dict[str, dict] = {}
    for start in range(0, len(titles), 50):
        chunk = titles[start:start + 50]
        params = {"action": "query", "titles": "|".join(chunk), "redirects": "1", "prop": props}
        if "categories" in props:
            params["cllimit"] = "max"
        if "revisions" in props:
            params["rvprop"] = "content"
            params["rvslots"] = "main"
        data = api(lang, params)
        query = data.get("query") or {}
        mapping = {t: t for t in chunk}
        for step in ("normalized", "redirects"):
            for item in query.get(step, []):
                for asked, now in mapping.items():
                    if now == item["from"]:
                        mapping[asked] = item["to"]
        pages = {p["title"]: p for p in query.get("pages", []) if not p.get("missing") and not p.get("invalid")}
        for asked, final in mapping.items():
            if final in pages:
                out[asked] = pages[final]
    return out


def infobox_field(wikitext: str, names: tuple[str, ...]) -> str:
    for name in names:
        match = re.search(r"^\s*\|\s*" + name + r"\s*=\s*(.*?)(?=^\s*\||^\s*\}\})", wikitext, flags=re.M | re.S | re.I)
        if match and match.group(1).strip():
            return match.group(1)
    return ""


def genres_from(value: str) -> list[str]:
    value = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->", "", value, flags=re.S)
    value = re.sub(r"\{\{\s*(?:flatlist|hlist|plainlist|plain list|lista sin viñetas|nowrap|ubl|unbulleted list)\s*\|", "", value, flags=re.I)
    value = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", value)
    value = re.sub(r"\{\{[^{}]*\}\}", "", value).replace("}}", "")
    # «drum and bass», «rhythm and blues», «rock and roll» son un solo género.
    value = re.sub(r"\b(drum|rhythm|rock|hip|country)\s+and\s+(bass|blues|roll|b)\b", r"\1 & \2", value, flags=re.I)
    parts = re.split(r"<br\s*/?>|\n\s*\*|[,;·•\n|]|\s+y\s+|\s+and\s+", value)
    out: list[str] = []
    for piece in parts:
        piece = re.sub(r"[*'\[\]{}]", "", piece).strip(" .")
        if piece and len(piece) < 40 and piece.lower() not in [o.lower() for o in out]:
            out.append(piece)
    return out


def wikitext_of(page: dict) -> str:
    revisions = page.get("revisions") or []
    if not revisions:
        return ""
    slot = (revisions[0].get("slots") or {}).get("main") or {}
    return slot.get("content") or ""


def intro(wikitext: str) -> str:
    text = re.sub(r"\{\{(?:[^{}]|\{\{[^{}]*\}\})*\}\}", "", wikitext)
    text = re.sub(r"<ref[^>]*/>|<ref[^>]*>.*?</ref>|<!--.*?-->|\[\[(?:Archivo|File|Imagen|Image|Categoría|Category):[^\]]*\]\]", "", text, flags=re.S)
    text = re.sub(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", r"\1", text)
    text = text.split("\n==")[0]
    text = re.sub(r"'{2,}", "", text)
    return re.sub(r"\s+", " ", text).strip()[:1800]


def main() -> None:
    pending = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    CACHE.mkdir(parents=True, exist_ok=True)
    pending_artists = {int(a["id"]) for a in pending["artists"]}
    albums_by_artist: dict[int, list[dict]] = {}
    for album in pending["albums"]:
        albums_by_artist.setdefault(int(album["artist_id"]), []).append(album)
    names = {int(a["id"]): a["name"] for a in pending["allArtists"]}
    homonyms: dict[str, int] = {}
    for name in names.values():
        homonyms[norm(name)] = homonyms.get(norm(name), 0) + 1
    targets = sorted(pending_artists | set(albums_by_artist))
    targets = [t for t in targets if names.get(t) and norm(names[t]) and homonyms[norm(names[t])] == 1
               and not re.match(r"^(various|varios|va\b)", names[t].lower())]

    rows: dict[str, dict] = {}
    texts: dict[str, dict] = {}
    stats = {"artistas_buscados": len(targets), "artistas_con_articulo_venezolano": 0, "artistas_con_genero": 0,
             "de_ficha": 0, "de_categorias": 0, "artistas_con_texto": 0, "descartados_varios_articulos": 0,
             "discos_probados": 0, "discos_con_genero": 0, "discos_con_texto": 0}
    matched: dict[int, str] = {}  # artistId → lang
    for lang in ("es", "en"):
        asked: dict[str, int] = {}
        for artist_id in targets:
            if artist_id in matched:
                continue
            for suffix in ARTIST_SUFFIX[lang]:
                asked[names[artist_id] + suffix] = artist_id
        pages = lookup(lang, list(asked), "categories")
        candidates: dict[int, list[dict]] = {}
        for title, page in pages.items():
            if any(VZ_CAT.search(c["title"]) for c in page.get("categories", [])):
                bucket = candidates.setdefault(asked[title], [])
                if page["title"] not in [p["title"] for p in bucket]:
                    bucket.append(page)
        stats["descartados_varios_articulos"] += sum(1 for pages_ in candidates.values() if len(pages_) > 1)
        single = {aid: pages_[0] for aid, pages_ in candidates.items() if len(pages_) == 1}
        full = lookup(lang, [p["title"] for p in single.values()], "revisions|categories")
        for artist_id, page in single.items():
            detail = full.get(page["title"])
            if not detail:
                continue
            matched[artist_id] = lang
            stats["artistas_con_articulo_venezolano"] += 1
            if artist_id not in pending_artists:
                continue
            url = f"https://{lang}.wikipedia.org/wiki/" + urllib.parse.quote(detail["title"].replace(" ", "_"))
            wikitext = wikitext_of(detail)
            genres = genres_from(infobox_field(wikitext, ("género", "genero", "géneros", "genre", "genres")))
            origin = "ficha"
            if not genres:
                genres = [m.group(1) for c in detail.get("categories", []) if (m := GENRE_CAT[lang].match(c["title"]))]
                origin = "categorías (orden alfabético)"
            if genres:
                stats["artistas_con_genero"] += 1
                stats["de_ficha" if origin == "ficha" else "de_categorias"] += 1
                rows[f"artist:{artist_id}"] = {"caseId": f"artist:{artist_id}", "kind": "artist", "entityId": artist_id,
                                               "source": f"wikipedia-{lang}", "url": url, "title": names[artist_id], "rawGenres": genres,
                                               "genreOrigin": origin,
                                               "identity": "título exacto + categoría venezolana en Wikipedia, sin homónimos"}
            text = intro(wikitext)
            if len(text) > 80:
                stats["artistas_con_texto"] += 1
                texts[f"artist:{artist_id}"] = {"caseId": f"artist:{artist_id}", "kind": "artist", "entityId": artist_id,
                                                "source": f"wikipedia-{lang}", "url": url, "text": text}

    # Discos de artistas casados: artículo propio cuya ficha nombra al artista.
    stats["discos_probados"] = sum(len(albums_by_artist.get(a, [])) for a in matched)
    for lang in ("es", "en"):
        asked_albums: dict[str, tuple[int, dict]] = {}
        for artist_id in matched:
            for album in albums_by_artist.get(artist_id, []):
                if f"album:{album['id']}" in rows:
                    continue
                title, name = album["title"], names[artist_id]
                variants = [title, f"{title} (álbum)", f"{title} (álbum de {name})", f"{title} (EP)"] if lang == "es" \
                    else [title, f"{title} (album)", f"{title} ({name} album)", f"{title} (EP)"]
                for variant in variants:
                    asked_albums[variant] = (artist_id, album)
        pages = lookup(lang, list(asked_albums), "revisions")
        for title, page in pages.items():
            artist_id, album = asked_albums[title]
            key = f"album:{album['id']}"
            if key in rows:
                continue
            wikitext = wikitext_of(page)
            box_artist = genres_from(infobox_field(wikitext, ("artista", "artist")))
            if not box_artist or norm(box_artist[0]) != norm(names[artist_id]):
                continue
            url = f"https://{lang}.wikipedia.org/wiki/" + urllib.parse.quote(page["title"].replace(" ", "_"))
            genres = genres_from(infobox_field(wikitext, ("género", "genero", "géneros", "genre", "genres")))
            if genres:
                stats["discos_con_genero"] += 1
                rows[key] = {"caseId": key, "kind": "album", "entityId": int(album["id"]), "source": f"wikipedia-{lang}",
                             "url": url, "title": f"{names[artist_id]} - {album['title']}", "rawGenres": genres, "genreOrigin": "ficha",
                             "identity": "artículo del disco cuya ficha nombra al artista casado"}
            text = intro(wikitext)
            if len(text) > 80 and key not in texts:
                stats["discos_con_texto"] += 1
                texts[key] = {"caseId": key, "kind": "album", "entityId": int(album["id"]), "source": f"wikipedia-{lang}", "url": url, "text": text}

    stats["peticiones_fallidas"] = FAILED[0]
    OUT.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows.values()), encoding="utf-8")
    TEXTS.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in texts.values()), encoding="utf-8")
    (ROOT / "reports" / "harvest-wikipedia-2026-09-27.json").write_text(json.dumps({"stats": stats}, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(stats), flush=True)


if __name__ == "__main__":
    main()
