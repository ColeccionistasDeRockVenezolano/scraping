#!/usr/bin/env python3
"""Recupera texto propio (y géneros que una fuente nombra) de lo ya scrapeado.

Para las fichas sin género principal que no entraron a los expedientes de Laya.
Solo lee: data/raw/* y el volcado de scripts/recover-dump-pending.mts. No toca
la base.

Salidas:
  reports/genre-local-texts-2026-09-27.jsonl — texto para los expedientes.
  reports/genre-laya-evidence-local-recovered-2026-09-26.jsonl — géneros que la
    fuente nombra, en el formato de scripts/apply-source-genres.ts.
  reports/recover-local-review-2026-09-27.jsonl — casos dudosos, fuera del libro.

Separación estricta: lo que el post dice del disco va al disco (etiquetas del
post, campo Género); lo que dice de la banda («X es una banda de punk rock») va
solo al artista. Nada se hereda.

Uso: python3 scripts/recover-local-texts.py PENDING.json DOSSIERS.jsonl SINCOPA_LINKED.jsonl
"""
from __future__ import annotations

import glob
import html
import json
import re
import sys
import unicodedata
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT_TEXT = ROOT / "reports" / "genre-local-texts-2026-09-27.jsonl"
OUT_LEDGER = ROOT / "reports" / "genre-laya-evidence-local-recovered-2026-09-26.jsonl"
OUT_REVIEW = ROOT / "reports" / "recover-local-review-2026-09-27.jsonl"
BLOGS = ["rock-de-vzla", "rockzuela", "hippito-y-sus-chatarritas", "rhv-blogspot", "coleccionistas-de-rock-venezolano",
         "descargas-metal-venezolano", "el-punk-en-venezuela", "rock-hecho-en-venezuela"]
MAX_TEXT = 3000
DESCRIPTOR = r"(?:banda|grupo|agrupaci[oó]n|proyecto|power\s+tr[ií]o|tr[ií]o|d[uú]o|conjunto|combo|orquesta|solista|cantante|cantautora?|m[uú]sico)"


# ---------- normalización ----------
def strip_marks(text: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFD", text) if unicodedata.category(ch) != "Mn")


def genre_norm(text: str) -> str:
    """Espejo de normalizeGenreText (src/genres/normalize.ts)."""
    text = strip_marks(text).lower()
    text = re.sub(r"[´`'’‘]", "", text)
    text = re.sub(r"[‐-―_-]", " ", text)
    text = re.sub(r"^[\s.,;:!?\"()\[\]{}]+|[\s.,;:!?\"()\[\]{}]+$", "", text)
    return re.sub(r"\s+", " ", text).strip()


def key(text: str) -> str:
    text = strip_marks(text or "").lower().replace("&", " and ")
    text = re.sub(r"^(the|los|las|la|el)\s+", "", text.strip())
    return re.sub(r"[^a-z0-9]+", "", text)


def canon(url: str) -> str:
    url = re.sub(r"^https?://", "", url or "")
    url = re.sub(r"^www\.", "", url)
    url = re.sub(r"[?#].*$", "", url).rstrip("/").lower()
    return url.replace(".blogspot.com.", ".blogspot.com").replace("m=1", "")


def plain(markup: str) -> str:
    markup = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", markup)
    markup = re.sub(r"(?i)<br\s*/?>|</p>|</div>|</li>|</h\d>", "\n", markup)
    text = html.unescape(re.sub(r"<[^>]+>", " ", markup))
    text = re.sub(r"[ \t ]+", " ", text)
    return re.sub(r"\n\s*\n+", "\n", text).strip()


TRACK_LINE = re.compile(r"^\s*(?:\d{1,2}|[AB]\d?)\s*[.)\-–]")
CREDIT_LINE = re.compile(r"^\s*(?:lado [ab]|side [ab]|cara [ab]|cr[eé]ditos|m[uú]sicos|producci[oó]n|grabado|mezcla|tracklist|temas)\b", re.I)
NOISE_LINE = re.compile(r"(?i)(desc[aá]rga(lo|r)|download|mediafire|mega\.nz|zippyshare|gracias a |link|enlace|password|contraseña|comentarios|compartir)")
INLINE_TRACKS = re.compile(r"(?:\b\d{1,2}\s*[.)\-–]\s*\S)")


def prose(text: str) -> str:
    keep = []
    for line in text.split("\n"):
        if TRACK_LINE.match(line) or CREDIT_LINE.match(line) or NOISE_LINE.search(line):
            continue
        # Tracklist en una sola línea: «01. X 02. Y 03. Z».
        if len(INLINE_TRACKS.findall(line)) >= 3:
            continue
        if len(line.strip()) < 3:
            continue
        keep.append(line.strip())
    return "\n".join(keep).strip()


# ---------- taxonomía ----------
def load_taxonomy(genres: list[dict]) -> dict[str, str]:
    aliases: dict[str, str] = {}
    for genre in genres:
        if not genre["active"]:
            continue
        for value in [genre["name"], genre["slug"].replace("-", " "), *genre["aliases"]]:
            aliases.setdefault(genre_norm(value), genre["slug"])
    return aliases


def resolves(aliases: dict[str, str], value: str) -> str | None:
    return aliases.get(genre_norm(value))


def leading_genre(aliases: dict[str, str], phrase: str) -> str | None:
    """El género más largo al inicio de la frase («punk rock que nació…» → punk rock)."""
    words = genre_norm(phrase).split()
    for size in range(min(4, len(words)), 0, -1):
        candidate = " ".join(words[:size])
        if candidate in aliases:
            return candidate
    return None


# ---------- fuentes locales ----------
def blog_posts() -> dict[str, dict]:
    posts: dict[str, dict] = {}

    def add(source: str, url: str, title: str, body_html: str, labels: list[str]) -> None:
        c = canon(url)
        if not c or c in posts:
            return
        posts[c] = {"source": source, "url": url, "title": plain(title), "text": plain(body_html), "labels": labels}

    for source in BLOGS:
        for file in glob.glob(str(RAW / source / "*.json")):
            if file.endswith(".headers.json"):
                continue
            try:
                data = json.load(open(file, encoding="utf-8"))
            except Exception:
                continue
            if isinstance(data, dict) and "feed" in data:
                for entry in data["feed"].get("entry", []) or []:
                    alt = next((l.get("href") for l in entry.get("link", []) if l.get("rel") == "alternate"), None)
                    body = (entry.get("content") or entry.get("summary") or {}).get("$t", "")
                    if alt:
                        add(source, alt, (entry.get("title") or {}).get("$t", ""), body,
                            [c.get("term", "") for c in entry.get("category", []) or []])
            elif isinstance(data, list):
                for item in data:
                    if isinstance(item, dict) and isinstance(item.get("link"), str) and isinstance(item.get("content"), dict):
                        tags = [re.sub(r"^(category|tag)-", "", c).replace("-", " ") for c in item.get("class_list") or []
                                if isinstance(c, str) and re.match(r"^(category|tag)-", c)]
                        add(source, item["link"], (item.get("title") or {}).get("rendered", ""),
                            item["content"].get("rendered", ""), tags)
    return posts


def html_posts(pages: list[dict], posts: dict[str, dict]) -> None:
    """Posts guardados como HTML (Blogger y WordPress.com) que no estaban en los feeds."""
    for page in pages:
        if page["slug"] not in BLOGS or "feeds/" in page["url"] or canon(page["url"]) in posts:
            continue
        try:
            raw = (ROOT / "data" / page["stored_path"]).read_text(encoding="utf-8", errors="replace")
        except FileNotFoundError:
            continue
        title = re.search(r'(?is)<meta property="og:title" content="([^"]*)"', raw)
        body = (re.search(r'(?is)<div[^>]+class="[^"]*post-body[^"]*"[^>]*>(.*?)<div[^>]+class="[^"]*post-footer', raw)
                or re.search(r'(?is)<div[^>]+class="[^"]*entry-content[^"]*"[^>]*>(.*?)</article>', raw))
        if not body:
            continue
        labels = [html.unescape(m) for m in re.findall(r'(?is)<a[^>]+rel="(?:tag|category tag)"[^>]*>([^<]+)</a>', raw)]
        posts[canon(page["url"])] = {"source": page["slug"], "url": page["url"], "title": html.unescape(title.group(1)) if title else "",
                                     "text": plain(body.group(1)), "labels": [l.strip() for l in labels]}


def lobotoradio_pages() -> list[dict]:
    out = []
    seen = set()
    for ledger in ["genre-laya-evidence-lobotoradio-artists-2026-09-26.jsonl", "genre-laya-evidence-lobotoradio-rejected-2026-09-26.jsonl"]:
        path = ROOT / "reports" / ledger
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            snap = row.get("snapshot") or (row.get("pages") or [{}])[0].get("snapshot")
            url = row.get("url") or (row.get("pages") or [{}])[0].get("url")
            if not snap or not url or url in seen:
                continue
            seen.add(url)
            try:
                raw = (ROOT / snap).read_text(encoding="utf-8", errors="replace")
            except FileNotFoundError:
                continue
            name = re.search(r'(?is)<div class="headline"><h1>(.*?)</h1>', raw)
            meta = {html.unescape(plain(k)).rstrip(":").strip(): plain(v)
                    for k, v in re.findall(r'(?is)<div class="meta-label">(.*?)</div>\s*<div class="meta-value[^"]*">(.*?)</div>', raw)}
            bio = re.search(r'(?is)<h2>Bio</h2></div>(.*?)<!--ADSENSE-->', raw)
            bio_text = plain(bio.group(1)) if bio else ""
            if "No hay reseña disponible" in bio_text:
                bio_text = ""
            out.append({"url": url, "name": plain(name.group(1)) if name else row.get("name", ""), "origin": meta.get("origen", ""),
                        "genres": meta.get("géneros", "") or meta.get("generos", ""), "bio": bio_text})
    return out


# ---------- principal ----------
def main() -> None:
    pending_path, dossiers_path, sincopa_path = sys.argv[1:4]
    dump = json.load(open(pending_path, encoding="utf-8"))
    in_dossier = {json.loads(l)["caseId"] for l in open(dossiers_path, encoding="utf-8") if l.strip()}
    aliases = load_taxonomy(dump["genres"])

    albums = dump["albums"]
    artists = dump["artists"]
    artist_by_id = {int(a["id"]): a for a in artists}
    # Homónimos: un nombre normalizado que nombra a más de un artista no sirve para casar.
    name_count = Counter()
    for a in artists:
        for n in {key(a["name"]), *(key(x) for x in a["aliases"])}:
            if n:
                name_count[n] += 1
    url_owner: dict[str, set[str]] = defaultdict(set)
    for a in albums:
        for u in a["urls"]:
            url_owner[canon(u)].add(f"album:{a['id']}")
    for a in artists:
        for u in a["urls"]:
            url_owner[canon(u)].add(f"artist:{a['id']}")

    target_albums = [a for a in albums if a["pending"] and f"album:{a['id']}" not in in_dossier]
    target_artists = [a for a in artists if a["pending"] and f"artist:{a['id']}" not in in_dossier]
    target_album_ids = {int(a["id"]) for a in target_albums}
    target_artist_ids = {int(a["id"]) for a in target_artists}

    posts = blog_posts()
    html_posts(dump["pages"], posts)

    texts: dict[str, list[dict]] = defaultdict(list)
    ledger: dict[str, dict] = {}
    review: list[dict] = []
    stats = Counter()

    def add_text(case: str, kind: str, entity: int, source: str, url: str, text: str, how: str) -> None:
        text = text.strip()
        if len(text) < 60:
            return
        if any(t["url"] == url and t["text"] == text for t in texts[case]):
            return
        texts[case].append({"caseId": case, "kind": kind, "entityId": entity, "source": source, "url": url,
                            "text": text[:MAX_TEXT], "how": how})

    def add_genre(case: str, kind: str, entity: int, source: str, url: str, title: str, raw: list[str], how: str) -> None:
        raw = [r for r in dict.fromkeys(raw) if r]
        if not raw or case in ledger:
            return
        ledger[case] = {"caseId": case, "kind": kind, "entityId": entity, "source": source, "url": url,
                        "title": title, "rawGenres": raw, "how": how}

    # Etiquetas de sitio («Rock Nacional» en todo Rockzuela) no clasifican el
    # post: se descartan las que cubren más del 20 % de los posts de su blog.
    label_freq: dict[str, Counter] = defaultdict(Counter)
    posts_per_source = Counter()
    for post in posts.values():
        posts_per_source[post["source"]] += 1
        for label in set(genre_norm(l) for l in post["labels"]):
            label_freq[post["source"]][label] += 1
    site_labels = {(src, label) for src, freq in label_freq.items() for label, n in freq.items()
                   if posts_per_source[src] >= 20 and n / posts_per_source[src] > 0.2}
    stats["etiquetas_de_sitio"] = sorted(f"{src}:{label}" for src, label in site_labels if resolves(aliases, label))

    def genre_labels(labels: list[str], source: str) -> list[str]:
        return [l for l in labels if resolves(aliases, l) and (source, genre_norm(l)) not in site_labels]

    FIELD_GENRE = re.compile(r"(?im)^\s*g[eé]neros?\s*[:;]\s*(.+?)\s*$")

    def is_album_post(post: dict) -> bool:
        return bool(re.search(r"\s[-–]\s", post["title"]) or re.search(r"(?im)^\s*[aá]lbum\s*[:;]", post["text"]))

    def band_phrases(text: str, names: list[str]) -> list[tuple[str, str]]:
        """Oraciones que describen al artista y el género que nombran («X es una banda de punk rock»)."""
        found = []
        keys = [key(n) for n in names if len(key(n)) >= 3]
        for sentence in re.split(r"(?<=[.!?])\s+|\n", text):
            if not any(k in key(sentence) for k in keys):
                continue
            m = re.search(rf"(?i)(?:\b(?:es|fue|era|son|eran|fueron)\s+(?:una?|el|la)\s+|,\s*(?:una?\s+|la\s+|el\s+)?|\b(?:la|el|esta|este)\s+)(?:(?:joven|nueva|legendaria|veterana|importante|reconocida|destacada)\s+)?{DESCRIPTOR}\s+"
                          r"(?:(?:venezolan[oa]s?|caraque[ñn][oa]s?|marabin[oa]s?|valencian[oa]s?|nacional|criolla?|underground|independiente)\s+)*"
                          r"(?:de|del)\s+(?:g[eé]nero\s+|estilo\s+)?([^.,;:()\n]{2,60})", sentence)
            if m:
                genre = leading_genre(aliases, m.group(1))
                if genre:
                    found.append((sentence.strip(), genre))
        return found

    def describing_sentences(text: str, names: list[str]) -> str:
        keys = [key(n) for n in names if len(key(n)) >= 3]
        keep = []
        for sentence in re.split(r"(?<=[.!?])\s+|\n", text):
            if any(k in key(sentence) for k in keys) and re.search(DESCRIPTOR, sentence, re.I) and len(sentence) > 40:
                keep.append(sentence.strip())
        return " ".join(dict.fromkeys(keep))

    # ---- 1. Discos: posts enlazados por source_url y posts sin enlazar casados por título ----
    album_posts: dict[int, list[dict]] = defaultdict(list)
    for a in albums:
        for u in a["urls"]:
            post = posts.get(canon(u))
            if post:
                album_posts[int(a["id"])].append({**post, "how": "enlazado"})
    # Índice por artista para casar títulos de posts sin enlace.
    albums_by_artist_key: dict[str, list[dict]] = defaultdict(list)
    for a in albums:
        albums_by_artist_key[key(a["artist"])].append(a)
    linked_urls = set(url_owner)
    for c, post in posts.items():
        if c in linked_urls:
            continue
        tkey = key(post["title"])
        if not tkey:
            continue
        hits = []
        for akey, group in albums_by_artist_key.items():
            if len(akey) < 3 or akey not in tkey or name_count[akey] > 1:
                continue
            for a in group:
                ttl = key(a["title"])
                if len(ttl) >= 4 and ttl in tkey.replace(akey, "", 1):
                    hits.append((len(akey) + len(ttl), a))
        if not hits:
            continue
        hits.sort(key=lambda h: -h[0])
        best = [h for h in hits if h[0] == hits[0][0]]
        if len({int(h[1]["id"]) for h in best}) > 1:
            stats["post_ambiguo"] += 1
            continue
        album_posts[int(best[0][1]["id"])].append({**post, "how": "titulo"})

    for a in target_albums:
        aid = int(a["id"])
        case = f"album:{aid}"
        for post in album_posts.get(aid, []):
            body = prose(post["text"])
            add_text(case, "album", aid, post["source"], post["url"], f"{post['title']}\n{body}", f"post_{post['how']}")
            field = FIELD_GENRE.search(post["text"])
            if field:
                add_genre(case, "album", aid, post["source"], post["url"], a["title"], [field.group(1)], f"campo_genero_post_{post['how']}")
            labels = genre_labels(post["labels"], post["source"])
            if labels:
                add_genre(case, "album", aid, post["source"], post["url"], a["title"], labels, f"etiquetas_post_{post['how']}")

    # ---- 2. Sincopa enlazado por source_url (scripts/recover-sincopa-linked.ts) ----
    for line in open(sincopa_path, encoding="utf-8"):
        if not line.strip():
            continue
        row = json.loads(line)
        if row["kind"] == "album":
            entity = int(row["entityId"])
            if entity not in target_album_ids:
                continue
            same_artist = key(row["pageArtist"]) == key(row["catalogArtist"]) or \
                (len(key(row["pageArtist"])) >= 3 and (key(row["pageArtist"]) in key(row["catalogArtist"]) or key(row["catalogArtist"]) in key(row["pageArtist"])))
            same_title = key(row["title"]) and (key(row["title"]) in key(row["pageTitle"]) or key(row["pageTitle"]) in key(row["title"]))
            # La página está enlazada a la ficha por source_url (el disco nació
            # de ella). Con el mismo artista, un título escrito distinto
            # («Vzla.» / «Venezuela», «Diez» / «10») es el mismo disco.
            if same_artist:
                add_genre(row["caseId"], "album", entity, "sincopa", row["url"], row["title"], row["rawGenres"],
                          "sincopa_enlazado" if same_title else "sincopa_enlazado_titulo_variante")
            else:
                # Disco asignado a un músico en vez de a la banda: el género es
                # del disco, pero la ficha necesita corrección antes.
                review.append({**row, "reason": "sincopa_enlazado_artista_distinto" + ("" if same_title else "_y_titulo")})
        else:
            entity = int(row["entityId"])
            if entity in target_artist_ids and key(row["pageArtist"]) == key(row["title"]):
                add_genre(row["caseId"], "artist", entity, "sincopa", row["url"], row["title"], row["rawGenres"], "sincopa_enlazado")
            elif entity in target_artist_ids:
                review.append({**row, "reason": "sincopa_enlazado_nombre_distinto"})

    # ---- 3. Artistas ----
    posts_of_artist: dict[int, list[dict]] = defaultdict(list)
    for a in albums:
        for post in album_posts.get(int(a["id"]), []):
            posts_of_artist[int(a["artist_id"])].append(post)
    lobo_by_key: dict[str, list[dict]] = defaultdict(list)
    for page in lobotoradio_pages():
        lobo_by_key[key(page["name"])].append(page)
    artist_posts_by_title: dict[str, list[dict]] = defaultdict(list)
    for post in posts.values():
        artist_posts_by_title[key(re.sub(r"(?i)^(biograf[ií]a( de)?|historia de|entrevista( a| con)?)\s+", "", post["title"]))].append(post)

    # Notas y artículos sin enlazar (RHV, El Punk en Venezuela, Rock Hecho en
    # Venezuela…) cuyo título nombra a UN solo artista del catálogo: el post es
    # sobre la banda, no sobre un disco.
    artist_keys = {}
    for other in artists:
        for n in {key(other["name"]), *(key(x) for x in other["aliases"])}:
            if len(n) >= 5 and name_count[n] <= 1:
                artist_keys[n] = int(other["id"])
    articles_of_artist: dict[int, list[dict]] = defaultdict(list)
    for c, post in posts.items():
        if c in linked_urls or is_album_post(post):
            continue
        tkey = key(post["title"])
        hits = {aid for n, aid in artist_keys.items() if n in tkey}
        if len(hits) == 1:
            articles_of_artist[hits.pop()].append(post)
        elif len(hits) > 1:
            stats["articulo_con_varios_artistas"] += 1

    for a in target_artists:
        aid = int(a["id"])
        case = f"artist:{aid}"
        names = [a["name"], *a["aliases"]]
        k = key(a["name"])
        unique = name_count[k] <= 1
        # 3a. Páginas enlazadas por source_url (blogs). Si el post es el de un
        # disco, solo cuentan las oraciones que describen a la banda: el resto
        # habla del disco y no se contagia al artista.
        for u in a["urls"]:
            post = posts.get(canon(u))
            if not post:
                continue
            if any(owner.startswith("album:") for owner in url_owner.get(canon(u), set())) or is_album_post(post):
                desc = describing_sentences(prose(post["text"]), names)
                if desc:
                    add_text(case, "artist", aid, post["source"], post["url"], desc, "oraciones_de_la_banda")
                for sentence, genre in band_phrases(prose(post["text"]), names):
                    add_genre(case, "artist", aid, post["source"], post["url"], a["name"], [genre], "frase_banda")
                    break
            else:
                add_text(case, "artist", aid, post["source"], post["url"], f"{post['title']}\n{prose(post['text'])}", "post_enlazado")
        # 3b. Lobotoradio: la ficha del artista (bio y géneros), nombre único y origen venezolano o vacío.
        for page in lobo_by_key.get(k, []) if unique and len(k) >= 3 else []:
            if page["origin"] and "venezuela" not in strip_marks(page["origin"]).lower():
                review.append({"caseId": case, "source": "lobotoradio", "url": page["url"], "reason": "origen_no_venezolano", "origin": page["origin"]})
                continue
            if page["bio"]:
                add_text(case, "artist", aid, "lobotoradio", page["url"], page["bio"], "ficha_lobotoradio")
            if page["genres"]:
                add_genre(case, "artist", aid, "lobotoradio", page["url"], a["name"], [g.strip() for g in re.split(r",", page["genres"]) if g.strip()], "ficha_lobotoradio")
        # 3c. Post dedicado al artista (título = nombre).
        if unique and len(k) >= 4:
            for post in artist_posts_by_title.get(k, []):
                if url_owner.get(canon(post["url"]), set()) - {case}:
                    continue
                add_text(case, "artist", aid, post["source"], post["url"], f"{post['title']}\n{prose(post['text'])}", "post_del_artista")
        for post in articles_of_artist.get(aid, []):
            body = prose(post["text"])
            add_text(case, "artist", aid, post["source"], post["url"], f"{post['title']}\n{body}", "articulo_sobre_la_banda")
            for sentence, genre in band_phrases(body, names):
                add_genre(case, "artist", aid, post["source"], post["url"], a["name"], [genre], "frase_banda")
                break
        # 3d. Lo que los posts de sus discos dicen de la banda (solo oraciones descriptivas).
        for post in posts_of_artist.get(aid, []):
            body = prose(post["text"])
            desc = describing_sentences(body, names)
            if desc:
                add_text(case, "artist", aid, post["source"], post["url"], desc, "oraciones_de_la_banda")
            for sentence, genre in band_phrases(body, names):
                add_genre(case, "artist", aid, post["source"], post["url"], a["name"], [genre], "frase_banda")
                break

    # ---- salida ----
    rows = [t for group in texts.values() for t in group]
    OUT_TEXT.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows), encoding="utf-8")
    OUT_LEDGER.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in ledger.values()), encoding="utf-8")
    OUT_REVIEW.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in review), encoding="utf-8")
    by = lambda items, field: dict(Counter(i[field] for i in items))
    summary = {
        "objetivo": {"discos": len(target_albums), "artistas": len(target_artists)},
        "posts_indexados": len(posts),
        "texto": {"discos": len({r["caseId"] for r in rows if r["kind"] == "album"}),
                  "artistas": len({r["caseId"] for r in rows if r["kind"] == "artist"}),
                  "por_fuente": by(rows, "source"), "por_via": by(rows, "how")},
        "genero_explicito": {"discos": sum(1 for r in ledger.values() if r["kind"] == "album"),
                             "artistas": sum(1 for r in ledger.values() if r["kind"] == "artist"),
                             "por_fuente": by(list(ledger.values()), "source"), "por_via": by(list(ledger.values()), "how")},
        "dudosos": by(review, "reason"), **stats,
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
