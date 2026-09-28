#!/usr/bin/env python3
"""CRV · Tipo de disco (EP, demo, sencillo, en vivo, recopilatorio, álbum) desde
lo que ya dicen la hoja, el nombre del disco y sus fuentes (Brian, 2026-09-28:
«el nombre de cada disco y sus fuentes suelen decir si es EP, demo o álbum»).

Sin red: lee reports/album-type-targets-<fecha>.json (scripts/export-album-type-targets.mts)
y las páginas ya cosechadas en data/raw/<fuente>. Escribe un libro de evidencia,
una fila por señal, que scripts/apply-album-types.ts resuelve y aplica:

  * hoja   — la clasificación de YT Master; en «Solo Artist, X» manda X (docs/DATA_MODEL.md).
  * nombre — marcas en el título del catálogo o en el título crudo de una fuente: «(EP)», «Demo», «En Vivo»…
  * post   — la línea del post que nombra el disco («Cadenas del Tormento (Demo 2006)»), el título del
             post («Tempano - Nowhere (Single - 2016)») o su ficha («Tipo: Full-length»).
  * formato — «LP» o «EP» de Sincopa y Rock De Vzla.
  * discogs — el formato de las ediciones «Main» con el mismo título (y año a ±1) del artista ya identificado.

Cada señal dice un tipo concreto o «album» (larga duración sin más: LP, Full-length,
«Album» de Discogs), que el aplicador solo usa si nada más concreto lo contradice.

Uso: python3 scripts/harvest-album-types.py reports/album-type-targets-2026-09-28.json
"""
import collections
import datetime
import glob
import html
import json
import re
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "reports" / f"album-type-evidence-{datetime.date.today().isoformat()}.jsonl"
BLOGS = ["rock-de-vzla", "rockzuela", "hippito-y-sus-chatarritas", "rhv-blogspot", "coleccionistas-de-rock-venezolano",
         "descargas-metal-venezolano", "el-punk-en-venezuela"]

# Hoja (docs/DATA_MODEL.md, «Matriz Type of Album»). Música en video no es disco: no se toca.
SHEET = {"Studio Album": "studio_album", "EP": "ep", "Compilation Album": "compilation", "Live Album": "live_album",
         "Single": "single", "Demos": "demo", "Unplugged": "live_album"}
SHEET_MEDIA = {"Music Video", "Live Concert", "Documentary", "B-Sides"}


def norm(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "").encode("ascii", "ignore").decode().lower().replace("&", " and ")
    return re.sub(r"[^a-z0-9]+", " ", text).strip()


def bare(text: str) -> str:
    """El título sin paréntesis ni corchetes: lo que se compara entre fuentes."""
    return norm(re.sub(r"\s*[([][^)\]]*[)\]]", " ", text or ""))


def nurl(url: str) -> str:
    url = (url or "").strip().lower().split("#")[0].split("?")[0]
    url = re.sub(r"^https?://(www\.)?", "", url).rstrip("/")
    return url.replace(".blogspot.com.ve", ".blogspot.com").replace(".blogspot.mx", ".blogspot.com")


def markers(text: str, loose: bool) -> set[str]:
    """Tipos que nombra un texto. `loose`: el texto ya es una marca (paréntesis, ficha); si no, solo las
    palabras que no pueden ser parte de un título corriente («Live Evil», «Single Ladies»)."""
    s = norm(text)
    found: set[str] = set()
    if re.search(r"\bsplit\b", s):
        return {"split"}
    # «EP's 1987-2000» reúne varios EP; «EPS 02» (Hippito) es el número de catálogo de un EP.
    if re.search(r"\bep s\b", s):
        found.add("compilation")
    elif re.search(r"\b(ep|eps|mini (album|cd|lp))\b", s):
        found.add("ep")
    if re.search(r"\b(demo|demos|maqueta|maquetas|promo|promocional|rehearsal|ensayo)\b", s):
        found.add("demo")
    # «Ni En Concierto Ni En Estudio» (Aditus) niega la marca.
    if (re.search(r"(?<!\bni )\b(en vivo|en directo|en concierto|unplugged|live at|live in|live from)\b", s)
            or (loose and re.search(r"\b(live|directo)\b", s))):
        found.add("live_album")
    if re.search(r"\b2 (super |grandes )?exitos\b", s):
        return {"single"}
    if re.search(r"\b(compilado|compilacion|compilation|recopilatorio|recopilacion|exitos|greatest hits|lo mejor de|best of|antologia)\b", s):
        found.add("compilation")
    if re.search(r"\b(remixes|remix album|remix ep|remixed)\b", s):
        found.add("remix")
    if re.search(r"\b(banda sonora|soundtrack|ost)\b", s):
        found.add("soundtrack")
    if loose and re.search(r"\b(single|sencillo|maxi single)\b", s):
        found.add("single")
    if loose and re.search(r"\b(lp|full length|larga duracion|album)\b", s) and not found:
        found.add("album")
    return found


def title_markers(title: str) -> set[str]:
    """Marcas de un título: lo que va entre paréntesis o corchetes, tras un guion final, o un título que es la marca misma."""
    found = markers(title, loose=False)
    for part in re.findall(r"[([]([^)\]]*)[)\]]", title or ""):
        found |= markers(part, loose=True)
    tail = re.search(r"\s[-–]\s*([^-–]+)$", title or "")
    if tail and len(norm(tail.group(1)).split()) <= 3:
        found |= markers(tail.group(1), loose=True)
    if re.fullmatch(r"(ep|lp|demo|single|promo)( ?\d+)?( \d{4})?", norm(title)):
        found |= markers(title, loose=True)
    return found - {"album"} if found - {"album"} else found


def post_text(raw: str) -> str:
    raw = re.sub(r"<script.*?</script>|<style.*?</style>", " ", raw, flags=re.S)
    return re.sub(r"[ \t\xa0]+", " ", html.unescape(re.sub(r"<(br|/p|/div|/h\d|/li)[^>]*>", "\n", raw, flags=re.I).replace("<", "\n<")))


def load_posts() -> dict[str, dict]:
    """URL del post → títulos y texto, de las páginas ya cosechadas (feeds de Blogger, HTML, API de WordPress)."""
    posts: dict[str, dict] = collections.defaultdict(lambda: {"titles": set(), "text": ""})
    for blog in BLOGS:
        for path in glob.glob(str(ROOT / "data" / "raw" / blog / "*")):
            if path.endswith(".headers.json"):
                continue
            raw = Path(path).read_bytes()
            if path.endswith(".json"):
                try:
                    data = json.loads(raw)
                except ValueError:
                    continue
                entries = data if isinstance(data, list) else (data.get("feed", {}).get("entry") or [])
                for entry in entries:
                    if not isinstance(entry, dict):
                        continue
                    if isinstance(entry.get("link"), str):  # WordPress
                        title, body, url = entry.get("title"), entry.get("content"), entry["link"]
                        title = title.get("rendered") if isinstance(title, dict) else title
                        body = body.get("rendered") if isinstance(body, dict) else body
                    else:  # Blogger
                        url = next((l["href"] for l in entry.get("link", []) if l.get("rel") == "alternate"), None)
                        title, body = entry.get("title", {}).get("$t"), entry.get("content", {}).get("$t")
                    if not url:
                        continue
                    post = posts[nurl(url)]
                    if title:
                        post["titles"].add(html.unescape(title).strip())
                    post["text"] = post["text"] or post_text(body or "")
            else:
                page = raw.decode("cp1252" if b"windows-1252" in raw[:600] else "utf-8", errors="ignore")
                url = re.search(r"<link[^>]+rel=['\"]canonical['\"][^>]+href=['\"]([^'\"]+)", page) \
                    or re.search(r"<meta[^>]+property=['\"]og:url['\"][^>]+content=['\"]([^'\"]+)", page)
                if not url:
                    continue
                post = posts[nurl(url.group(1))]
                body = re.search(r"<div class='post-body[^>]*>(.*?)<div class='post-footer", page, re.S)
                post["text"] = post["text"] or post_text(body.group(1) if body else page)
                for match in re.finditer(r"<h3 class='post-title[^>]*>(.*?)</h3>", page, re.S):
                    post["titles"].add(html.unescape(re.sub(r"<[^>]+>", "", match.group(1))).strip())
    return posts


def post_signals(title: str, post: dict) -> list[tuple[str, str]]:
    """(tipo, texto que lo dice) desde el post: su título, la línea que nombra el disco y su ficha."""
    out: list[tuple[str, str]] = []
    key = bare(title)
    for post_title in post["titles"]:
        if key and key in norm(post_title):
            out += [(kind, post_title) for kind in title_markers(post_title)]
    for line in post["text"].split("\n"):
        line = line.strip()
        if not line or len(line) > 160:
            continue
        ficha = re.match(r"(?i)\s*(tipo|type|formato del disco|tipo de (?:disco|lanzamiento))\s*:\s*(.+)$", line)
        if ficha:
            out += [(kind, line) for kind in markers(ficha.group(2), loose=True)]
        elif key and len(key) >= 3 and norm(line).startswith(key):
            rest = line[len(title):] if line.lower().startswith(title.lower()) else line
            for part in re.findall(r"[([]([^)\]]*)[)\]]", rest):
                out += [(kind, line) for kind in markers(part, loose=True)]
    return out


DISCOGS = [("Comp", "compilation"), ("EP", "ep"), ("Mini-Album", "ep"), ("Single", "single"), ("Maxi-Single", "single"), ("Album", "album"), ("LP", "album")]


def discogs_type(fmt: str) -> str | None:
    tokens = {t.strip() for t in (fmt or "").split(",")}
    for token, kind in DISCOGS:
        if token in tokens:
            return kind
    return None


def main() -> None:
    targets = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    posts = load_posts()
    releases: dict[int, list[dict]] = collections.defaultdict(list)
    for row in targets["discogs"]:
        releases[row["artist_id"]].append(row)
    rows: list[dict] = []
    stats = collections.Counter()

    def emit(album: dict, source: str, via: str, kind: str, raw: str, url: str | None = None) -> None:
        # Un sencillo o un EP con el nombre del disco largo suele ser su tema principal, no el disco.
        if via != "hoja" and ((kind == "single" and album["ntracks"] > 3) or (kind == "ep" and album["ntracks"] > 8)):
            stats[f"descartada_por_pistas:{kind}"] += 1
            return
        # «¡Grandes Éxitos!» puede ser ironía en el primer disco de una banda: el nombre solo
        # prueba un recopilatorio si el artista tiene material que recopilar.
        if kind == "compilation" and via in ("nombre", "post") and album["siblings"] < 3:
            stats["descartada_sin_discografia:compilation"] += 1
            return
        rows.append({"albumId": album["id"], "artist": album["artist"], "title": album["title"], "source": source,
                     "via": via, "type": kind, "raw": raw, "url": url})
        stats[f"{via}:{kind}"] += 1

    for album in targets["albums"]:
        classes = set(album["classes"])
        if classes & SHEET_MEDIA:
            continue
        for label in album["classes"]:
            if label in SHEET:
                emit(album, "yt-master", "hoja", SHEET[label], ", ".join(album["classes"]))
        if re.fullmatch(r"(?i)(various artists|varios artistas|v\.?a\.?|varios)", album["artist"].strip()):
            emit(album, "catalogo", "artista", "compilation", album["artist"])
        for kind in title_markers(album["title"]):
            emit(album, "catalogo", "nombre", kind, album["title"])
        for claim in album["claims"]:
            if claim["f"] == "title" and claim["v"] and claim["v"] != album["title"]:
                for kind in title_markers(claim["v"]):
                    emit(album, claim["s"], "nombre", kind, claim["v"])
            elif claim["f"] == "format" and claim["v"]:
                parts = {p.strip().lower() for p in re.split(r"[/,]", claim["v"])}
                kind = "ep" if "ep" in parts else "demo" if "demo" in parts else "album" if "lp" in parts else None
                if kind:
                    emit(album, claim["s"], "formato", kind, claim["v"])
            elif claim["f"] == "source_url":
                post = posts.get(nurl(claim["v"]))
                if post:
                    for kind, raw in post_signals(album["title"], post):
                        emit(album, claim["s"], "post", kind, raw, claim["v"])
        key = bare(album["title"])
        for release in releases.get(album["artist_id"], []):
            if not key or bare(release["title"]) != key:
                continue
            year = int(release["year"]) if str(release.get("year") or "").isdigit() and int(release["year"]) > 0 else None
            if album["yr"] and year and abs(album["yr"] - year) > 1:
                continue
            kind = discogs_type(release["format"])
            if kind:
                emit(album, "discogs", "discogs", kind, release["format"], f"https://www.discogs.com/release/{release['id']}")

    # Una misma señal repetida (varios posts, varias ediciones) cuenta una vez.
    seen: set[tuple] = set()
    unique = []
    for row in rows:
        key = (row["albumId"], row["source"], row["via"], row["type"])
        if key not in seen:
            seen.add(key)
            unique.append(row)
    OUT.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in unique), encoding="utf-8")
    print(json.dumps({"discos": len(targets["albums"]), "con_senal": len({r["albumId"] for r in unique}), "filas": len(unique),
                      "por_via": dict(sorted(stats.items(), key=lambda kv: -kv[1]))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
