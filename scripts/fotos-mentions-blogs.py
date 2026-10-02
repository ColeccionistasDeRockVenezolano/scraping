#!/usr/bin/env python3
"""Piloto fotos-blogs — fase 1 (offline, sin descargas):
Mide el techo de la vía "blogs": cuántos de los artistas sin foto aparecen
mencionados en el corpus de páginas ya cosechadas, y cuántas imágenes hay en
sus entradas/páginas. Salida: mentions.jsonl + resumen.
"""
import json, os, re, subprocess, sys, unicodedata
from collections import Counter, defaultdict

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
OUT = os.path.join(REPO, "data/raw/fotos-blogs-2026-10-01")
os.makedirs(OUT, exist_ok=True)

STOP = {"los", "las", "del", "de", "la", "el", "y", "en", "un", "una", "the",
        "of", "and", "a", "con", "por", "para", "sin"}


def norm(s):
    s = unicodedata.normalize("NFKD", (s or "").lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def sql(q):
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv",
                        "-At", "-F", "\t", "-c", q], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr)
    return [l.split("\t") for l in r.stdout.strip().split("\n") if l.strip()]


TAG = re.compile(r"<[^>]+>")
IMG = re.compile(r"<img[^>]+?src=[\"']([^\"']+)[\"']", re.I | re.S)
HREF_IMG = re.compile(r"href=[\"'](https?://[^\"']+\.(?:jpg|jpeg|png|gif|webp))[\"']", re.I)
BIG = re.compile(r"src=[\"']([^\"']*?/s\d{3,4}/[^\"']+)[\"']", re.I)


def strip_html(h):
    h = re.sub(r"<script.*?</script>", " ", h, flags=re.S | re.I)
    h = re.sub(r"<style.*?</style>", " ", h, flags=re.S | re.I)
    return re.sub(r"\s+", " ", TAG.sub(" ", h))


# ---------- artistas sin foto ----------
artists = sql("SELECT id, name FROM public.artists WHERE picture_url IS NULL OR btrim(picture_url)=''")
artists = [(int(a[0]), a[1]) for a in artists if a[1]]
print(f"artistas sin foto: {len(artists)}")

# indice invertido token -> artistas (tokens distintivos len>=4)
inv = defaultdict(set)
for aid, name in artists:
    toks = [t for t in norm(name).split() if len(t) >= 4 and t not in STOP]
    for t in set(toks):
        inv[t].add(aid)
name_by_id = {a: n for a, n in artists}
print(f"tokens indice: {len(inv)}")

# ---------- paginas del corpus ----------
pages = sql("""SELECT id, url, stored_path FROM ingest.raw_pages
               WHERE url ~* '(blogspot|wordpress|rockhechovenezuela|musica|punkenvenezuela|laguiadecaracas|paltoque)'
               ORDER BY id""")
print(f"paginas corpus: {len(pages)}")
read_ok = 0
entries_total = 0
imgs_total = 0

# mentions: artistId -> [{page, entry, imgs:[...]}]
mentions = defaultdict(list)
pair_imgs = Counter()
host_imgs = Counter()

for pid, url, st in pages:
    p = st if os.path.isabs(st) else os.path.join(REPO, "data", st)
    if not os.path.exists(p):
        continue
    try:
        raw = open(p, encoding="utf-8", errors="replace").read()
        read_ok += 1
    except Exception:
        continue

    ents = []
    if raw.lstrip().startswith("{"):
        try:
            d = json.loads(raw)
            for e in (d.get("feed", {}).get("entry") or []):
                t = (e.get("title", {}) or {}).get("$t", "") or ""
                c = (e.get("content", {}) or {}).get("$t", "") or ""
                alt = ""
                for ln in (e.get("link") or []):
                    if ln.get("rel") == "alternate" and ln.get("href"):
                        alt = ln["href"]; break
                ents.append({"title": t, "html": c, "url": alt or url})
        except Exception:
            ents = [{"title": "", "html": raw, "url": url}]
    else:
        ents = [{"title": "", "html": raw, "url": url}]

    for e in ents:
        entries_total += 1
        text = strip_html(e["html"])
        ntoks = set(norm(text).split())
        cand = set()
        for t in ntoks:
            s = inv.get(t)
            if s:
                cand |= s
        if not cand:
            continue
        ntext = norm(text)
        imgs = []
        for m in IMG.finditer(e["html"]):
            u = m.group(1)
            if u.startswith("//"):
                u = "https:" + u
            if not u.startswith("http"):
                continue
            if re.search(r"(gravatar|feedburner|w3\.org|schema\.org|/icon|logo\.|sprite)", u, re.I):
                continue
            imgs.append(u)
        for m in HREF_IMG.finditer(e["html"]):
            u = m.group(1)
            if u not in imgs:
                imgs.append(u)
        if not imgs:
            continue
        for aid in cand:
            nm = norm(name_by_id[aid])
            if len(nm) < 4:
                continue
            if re.search(r"(?<![a-z0-9])" + re.escape(nm) + r"(?![a-z0-9])", ntext):
                mentions[aid].append({"page": e["url"] or url, "title": e["title"], "imgs": imgs[:40], "pid": pid})
                pair_imgs[aid] += len(imgs)
                for u in imgs[:40]:
                    host_imgs[re.sub(r"^https?://", "", u).split("/")[0]] += 1

print(f"paginas leidas: {read_ok} | entradas: {entries_total}")
print(f"artistas mencionados: {len(mentions)} de {len(artists)} sin foto")
multi = sum(1 for v in mentions.values() if len(v) >= 1)
print(f"con >=1 entrada: {multi}")

with open(os.path.join(OUT, "mentions.jsonl"), "w", encoding="utf-8") as f:
    for aid, lst in mentions.items():
        for m in lst:
            f.write(json.dumps({"artistId": aid, "artist": name_by_id[aid], **m}, ensure_ascii=False) + "\n")

print("hosts de imagenes en entradas de artistas:")
for h, c in host_imgs.most_common(15):
    print("  ", h, c)

# techo por artista: cuantos tienen >=3 imagenes candidatas
techo = sum(1 for aid, v in mentions.items() if pair_imgs[aid] >= 3)
print(f"artistas con >=3 imgs candidatas en sus entradas: {techo}")
