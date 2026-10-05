#!/usr/bin/env python3
"""CRV · Colector de links de plataformas de streaming (por artista y por álbum).

Lee el catálogo exportado de `public.*` (artistas.jsonl / albumes.jsonl, ver
abajo cómo generarlos) y busca el perfil de cada artista y los links de cada
disco en las plataformas con API oficial:

  · Spotify      — API oficial (SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET del .env)
  · Apple Music  — iTunes Search API (sin key)
  · Deezer       — API pública (sin key)
  · MusicBrainz  — url-rels del artista (relaciones «streaming»/«free streaming»)
  · Wikidata     — props P1902 Spotify · P2722 Deezer · P2850 iTunes · P2397 YouTube

Guardas anti-homónimo: nombre normalizado (NFD sin tildes) con casado
exacto/difuso (difflib); los discos se casan por título + año con el mismo
criterio (exact = título ≥0.98 y año compatible; fuzzy = ≥0.90). Cada link
sale con plataforma, URL, id externo, método y fuente; nada inventado: si no
hay casado, no hay fila.

Exportar la entrada (una vez; contra la BD viva):
  docker exec crv-postgres psql -U crv -d crv -tAc "SELECT json_build_object(...)::text FROM artists ORDER BY id" > artistas.jsonl
  … ídem albums.

Uso:
  python3 scripts/streaming-colector.py \\
    --artistas data/raw/streaming-2026-10-04/artistas.jsonl \\
    --albumes  data/raw/streaming-2026-10-04/albumes.jsonl \\
    --out reports/streaming-links-2026-10-04/piloto-100 --limit 100
  … --shard i/N para la campaña completa por lotes (reanudable: salta los
  links-<artistId>.json ya escritos; un archivo por artista = perfil + discos).
"""
import argparse
import base64
import difflib
import json
import os
import random
import sys
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "CRV-streaming-links/1.0 (+coleccionistasderockvenezolano.com)"}
SEED_PILOTO = 20261004

SLEEP = {"spotify": 0.18, "itunes": 3.1, "deezer": 0.22, "mb": 1.1, "wd": 0.35}


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if value:
        return value
    path = ROOT / ".env"
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, val = line.partition("=")
            if k.strip() == name:
                return val.strip().strip('"').strip("'")
    return ""


def norm(s: str) -> str:
    s = unicodedata.normalize("NFD", (s or "").lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return " ".join("".join(ch if ch.isalnum() else " " for ch in s).split())


def ratio(a: str, b: str) -> float:
    return difflib.SequenceMatcher(None, a or "", b or "").ratio()


def http_json(url: str, data=None, headers=None, timeout=30):
    h = dict(UA)
    if headers:
        h.update(headers)
    body = None
    if data is not None:
        body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, headers=h)
    for intento in range(3):
        try:
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code == 429 and intento < 2:
                time.sleep(6 if intento == 0 else 20)
                continue
            if e.code == 503 and intento < 2:
                time.sleep(4 if intento == 0 else 10)
                continue
            raise
    return None


def year_of(s):
    try:
        return int(str(s)[:4])
    except Exception:
        return None


# ---------------------------------------------------------------- plataformas

class Spotify:
    EN_PAUSA = "EN_PAUSA"

    def __init__(self):
        self.token = None
        self.creds = []
        for sufijo in ("", "_FALLBACK"):
            cid = env("SPOTIFY_CLIENT_ID" + sufijo)
            sec = env("SPOTIFY_CLIENT_SECRET" + sufijo)
            if cid and sec:
                self.creds.append((cid, sec))
        self.fallos = 0

    def _tok(self):
        if self.token:
            return self.token
        if not self.creds:
            raise SystemExit("faltan SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET")
        ultimo = None
        for cid, sec in self.creds:
            auth = base64.b64encode(f"{cid}:{sec}".encode()).decode()
            try:
                d = http_json("https://accounts.spotify.com/api/token",
                              data={"grant_type": "client_credentials"},
                              headers={"Authorization": "Basic " + auth})
            except urllib.error.HTTPError as e:
                ultimo = e
                if e.code == 429:
                    time.sleep(15)
                continue
            if d and "access_token" in d:
                self.token = d["access_token"]
                return self.token
        # Ninguna credencial dio token: pausa larga sin bloquear la corrida.
        self.token = self.EN_PAUSA
        raise RuntimeError(f"spotify en pausa (rate-limit: {ultimo})")

    def get(self, path):
        if self.token == self.EN_PAUSA:
            # Reintento cada ~12 llamadas (≈6 artistas) por si el castigo expira.
            self.fallos += 1
            if self.fallos % 12 != 0:
                raise RuntimeError("spotify en pausa (rate-limit)")
            self.token = None
        time.sleep(SLEEP["spotify"])
        return http_json("https://api.spotify.com/v1" + path,
                         headers={"Authorization": "Bearer " + self._tok()})

    def search_artist(self, name):
        d = self.get("/search?" + urllib.parse.urlencode({"q": name, "type": "artist", "limit": 5}))
        out = []
        for a in ((d or {}).get("artists", {}).get("items") or []):
            out.append({"name": a.get("name"), "url": (a.get("external_urls") or {}).get("spotify"),
                        "id": a.get("id"), "source": "spotify-search"})
        return out

    def artist_albums(self, artist_id):
        d = self.get(f"/artists/{artist_id}/albums?" + urllib.parse.urlencode(
            {"include_groups": "album,single,compilation", "limit": 50}))
        out = []
        for a in ((d or {}).get("items") or []):
            out.append({"title": a.get("name"), "year": year_of(a.get("release_date")),
                        "url": (a.get("external_urls") or {}).get("spotify"), "id": a.get("id"),
                        "source": "spotify-albums"})
        return out


def itunes_search_artist(name):
    time.sleep(SLEEP["itunes"])
    d = http_json("https://itunes.apple.com/search?" + urllib.parse.urlencode(
        {"term": name, "entity": "musicArtist", "limit": 5}))
    out = []
    for a in ((d or {}).get("results") or []):
        out.append({"name": a.get("artistName"), "url": a.get("artistViewUrl"),
                    "id": a.get("artistId"), "source": "itunes-search"})
    return out


def itunes_artist_albums(artist_id):
    time.sleep(SLEEP["itunes"])
    d = http_json("https://itunes.apple.com/lookup?" + urllib.parse.urlencode(
        {"id": artist_id, "entity": "album", "limit": 200}))
    out = []
    for a in ((d or {}).get("results") or []):
        if a.get("wrapperType") != "collection":
            continue
        out.append({"title": a.get("collectionName"), "year": year_of(a.get("releaseDate")),
                    "url": a.get("collectionViewUrl"), "id": a.get("collectionId"),
                    "source": "itunes-albums"})
    return out


def deezer_search_artist(name):
    time.sleep(SLEEP["deezer"])
    d = http_json("https://api.deezer.com/search/artist?" + urllib.parse.urlencode({"q": name, "limit": 5}))
    out = []
    for a in ((d or {}).get("data") or []):
        out.append({"name": a.get("name"), "url": a.get("link"), "id": a.get("id"), "source": "deezer-search"})
    return out


def deezer_artist_albums(artist_id):
    time.sleep(SLEEP["deezer"])
    d = http_json(f"https://api.deezer.com/artist/{artist_id}/albums?" + urllib.parse.urlencode({"limit": 100}))
    out = []
    for a in ((d or {}).get("data") or []):
        out.append({"title": a.get("title"), "year": year_of(a.get("release_date")),
                    "url": a.get("link"), "id": a.get("id"), "source": "deezer-albums"})
    return out


def mb_artist(name):
    """url-rels de MusicBrainz del mejor candidato (score + nombre)."""
    time.sleep(SLEEP["mb"])
    q = urllib.parse.quote(f'artist:"{name}"')
    d = http_json(f"https://musicbrainz.org/ws/2/artist/?query={q}&fmt=json&limit=3")
    best = None
    for a in ((d or {}).get("artists") or []):
        r = ratio(norm(name), norm(a.get("name") or ""))
        if best is None or r > best[0]:
            best = (r, a)
    if not best or best[0] < 0.90:
        return None, []
    a = best[1]
    time.sleep(SLEEP["mb"])
    d2 = http_json(f"https://musicbrainz.org/ws/2/artist/{a['id']}?inc=url-rels&fmt=json")
    links = []
    for rel in (d2 or {}).get("relations", []):
        u = ((rel.get("url") or {}).get("resource") or "")
        low = u.lower()
        plat = None
        for dom, p in (("open.spotify.com/artist", "spotify"), ("music.apple.com", "apple_music"),
                       ("itunes.apple.com", "apple_music"), ("deezer.com/artist", "deezer"),
                       ("tidal.com", "tidal"), ("soundcloud.com", "soundcloud"),
                       ("bandcamp.com", "bandcamp"), ("youtube.com", "youtube"),
                       ("amazon.", "amazon_music")):
            if dom in low:
                plat = p
                break
        if plat:
            links.append({"platform": plat, "url": u, "id": None,
                          "method": "exact" if best[0] >= 0.98 else "fuzzy",
                          "source": "musicbrainz-url-rels", "score": round(best[0], 3)})
    return a.get("name"), links


WD_PROPS = {"P1902": "spotify", "P2722": "deezer", "P2850": "apple_music", "P2397": "youtube"}


def wd_artist(name):
    time.sleep(SLEEP["wd"])
    d = http_json("https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "wbsearchentities", "search": name, "language": "es", "limit": 3, "format": "json"}))
    hits = (d or {}).get("search") or []
    if not hits:
        return []
    best = None
    for h in hits:
        r = ratio(norm(name), norm(h.get("label") or ""))
        if best is None or r > best[0]:
            best = (r, h)
    if not best or best[0] < 0.90:
        return []
    qid = best[1]["id"]
    d2 = http_json("https://www.wikidata.org/w/api.php?" + urllib.parse.urlencode(
        {"action": "wbgetentities", "ids": qid, "props": "claims", "format": "json"}))
    claims = (((d2 or {}).get("entities") or {}).get(qid) or {}).get("claims") or {}
    out = []
    for p, plat in WD_PROPS.items():
        for c in claims.get(p, []):
            v = (c.get("mainsnak", {}).get("datavalue") or {}).get("value")
            if not isinstance(v, str):
                continue
            if plat == "spotify":
                url = f"https://open.spotify.com/artist/{v}"
            elif plat == "deezer":
                url = f"https://www.deezer.com/artist/{v}"
            elif plat == "apple_music":
                url = f"https://music.apple.com/artist/{v}"
            else:
                url = f"https://www.youtube.com/channel/{v}"
            out.append({"platform": plat, "url": url, "id": v,
                        "method": "exact" if best[0] >= 0.98 else "fuzzy",
                        "source": f"wikidata-{qid}", "score": round(best[0], 3)})
    return out


# -------------------------------------------------------------------- casados

def pick_candidate(target_name, cands, key="name"):
    best = None
    for c in cands:
        r = ratio(norm(target_name), norm(c.get(key) or ""))
        if best is None or r > best[0]:
            best = (r, c)
    if not best:
        return None, None, 0.0
    r, c = best
    method = "exact" if r >= 0.98 else ("fuzzy" if r >= 0.90 else None)
    return c, method, round(r, 3)


def pick_album(album, cands):
    best = None
    ay = album.get("year")
    for c in cands:
        r = ratio(norm(album["title"]), norm(c.get("title") or ""))
        cy = c.get("year")
        dy = abs(ay - cy) if (ay and cy) else None
        key = (round(r, 3), -(dy if dy is not None else 0))
        if best is None or key > best[0]:
            best = (key, c, r, dy)
    if not best:
        return None, None, 0.0
    _, c, r, dy = best
    if r >= 0.98 and (dy is None or dy == 0):
        method = "exact"
    elif r >= 0.90:
        method = "fuzzy"
    else:
        method = None
    return c, method, round(r, 3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--artistas", required=True)
    ap.add_argument("--albumes", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--shard", default="")
    ap.add_argument("--sin-spotify", action="store_true", help="no llamar a Spotify (pruebas)")
    ap.add_argument("--reintentar-plataforma", default="",
                    help="re-procesa los links-*.json cuyo error mencione esta plataforma (p. ej. spotify)")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    def hay_que_rehacer(fp):
        """True si el archivo no existe, o si toca reintentar la plataforma pedida."""
        if not fp.exists():
            return True
        if not args.reintentar_plataforma:
            return False
        try:
            d = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            return True
        return any(args.reintentar_plataforma in e for e in d.get("fuentes_error", []))

    artistas = [json.loads(l) for l in Path(args.artistas).read_text(encoding="utf-8").splitlines() if l.strip()]
    albumes = [json.loads(l) for l in Path(args.albumes).read_text(encoding="utf-8").splitlines() if l.strip()]
    por_artista = {}
    for a in albumes:
        por_artista.setdefault(a["artistId"], []).append(a)

    random.Random(SEED_PILOTO).shuffle(artistas)
    if args.shard:
        i, n = (int(x) for x in args.shard.split("/"))
        artistas = [a for idx, a in enumerate(artistas) if idx % n == i]
    if args.limit:
        artistas = artistas[: args.limit]

    sp = Spotify() if not args.sin_spotify else None
    hechos = 0
    for idx, art in enumerate(artistas, 1):
        aid = art["id"]
        fp = out / f"links-{aid}.json"
        if not hay_que_rehacer(fp):
            continue
        rec = {"artistId": aid, "name": art["name"], "artist_links": [], "album_links": [],
               "mb_name": None, "fuentes_ok": [], "fuentes_error": []}

        def add_artist(link):
            if link.get("url") and not any(x["platform"] == link["platform"] for x in rec["artist_links"]):
                rec["artist_links"].append(link)

        # Spotify
        sp_id = None
        if sp is not None:
            try:
                cands = sp.search_artist(art["name"])
                c, method, score = pick_candidate(art["name"], cands)
                if c and method:
                    add_artist({"platform": "spotify", "url": c["url"], "id": c["id"], "method": method,
                                "source": c["source"], "score": score, "name_plat": c.get("name")})
                    if method == "exact":
                        sp_id = c["id"]
                rec["fuentes_ok"].append("spotify")
            except Exception as e:
                rec["fuentes_error"].append(f"spotify: {str(e)[:80]}")
        else:
            # Deja marca para el rescate (--reintentar-plataforma spotify).
            rec["fuentes_error"].append("spotify: omitido (--sin-spotify)")
        # iTunes
        try:
            cands = itunes_search_artist(art["name"])
            c, method, score = pick_candidate(art["name"], cands)
            if c and method:
                add_artist({"platform": "apple_music", "url": c["url"], "id": c["id"], "method": method,
                            "source": c["source"], "score": score, "name_plat": c.get("name")})
            # álbumes iTunes
            if c and method:
                try:
                    it_albums = itunes_artist_albums(c["id"])
                    for al in por_artista.get(aid, []):
                        m, met, sc = pick_album(al, it_albums)
                        if m and met:
                            rec["album_links"].append({"albumId": al["id"], "platform": "apple_music",
                                                       "url": m["url"], "id": m["id"], "method": met,
                                                       "source": m["source"], "score": sc,
                                                       "title_plat": m.get("title"), "year_plat": m.get("year")})
                except Exception as e:
                    rec["fuentes_error"].append(f"itunes-albums: {str(e)[:60]}")
            rec["fuentes_ok"].append("itunes")
        except Exception as e:
            rec["fuentes_error"].append(f"itunes: {str(e)[:80]}")
        # Deezer
        try:
            cands = deezer_search_artist(art["name"])
            c, method, score = pick_candidate(art["name"], cands)
            if c and method:
                add_artist({"platform": "deezer", "url": c["url"], "id": c["id"], "method": method,
                            "source": c["source"], "score": score, "name_plat": c.get("name")})
                try:
                    dz_albums = deezer_artist_albums(c["id"])
                    for al in por_artista.get(aid, []):
                        m, met, sc = pick_album(al, dz_albums)
                        if m and met:
                            rec["album_links"].append({"albumId": al["id"], "platform": "deezer",
                                                       "url": m["url"], "id": m["id"], "method": met,
                                                       "source": m["source"], "score": sc,
                                                       "title_plat": m.get("title"), "year_plat": m.get("year")})
                except Exception as e:
                    rec["fuentes_error"].append(f"deezer-albums: {str(e)[:60]}")
            rec["fuentes_ok"].append("deezer")
        except Exception as e:
            rec["fuentes_error"].append(f"deezer: {str(e)[:80]}")
        # Spotify álbumes (si hubo perfil exacto)
        if sp is not None and sp_id:
            try:
                sp_albums = sp.artist_albums(sp_id)
                for al in por_artista.get(aid, []):
                    m, met, sc = pick_album(al, sp_albums)
                    if m and met:
                        rec["album_links"].append({"albumId": al["id"], "platform": "spotify",
                                                   "url": m["url"], "id": m["id"], "method": met,
                                                   "source": m["source"], "score": sc,
                                                   "title_plat": m.get("title"), "year_plat": m.get("year")})
            except Exception as e:
                rec["fuentes_error"].append(f"spotify-albums: {str(e)[:60]}")
        # MusicBrainz
        try:
            mb_name, mb_links = mb_artist(art["name"])
            rec["mb_name"] = mb_name
            for l in mb_links:
                l.setdefault("name_plat", mb_name)
                add_artist(l)
            rec["fuentes_ok"].append("musicbrainz")
        except Exception as e:
            rec["fuentes_error"].append(f"mb: {str(e)[:80]}")
        # Wikidata
        try:
            for l in wd_artist(art["name"]):
                add_artist(l)
            rec["fuentes_ok"].append("wikidata")
        except Exception as e:
            rec["fuentes_error"].append(f"wd: {str(e)[:80]}")

        rec["albumes_catalogo"] = len(por_artista.get(aid, []))
        rec["albumes_con_link"] = len({(x["albumId"]) for x in rec["album_links"]})
        fp.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        hechos += 1
        if hechos % 5 == 0 or idx == len(artistas):
            print(f"  {idx}/{len(artistas)} [{aid}] {art['name'][:36]} · perfil {len(rec['artist_links'])} · discos {rec['albumes_con_link']}/{rec['albumes_catalogo']}", flush=True)
    print(f"listo: {hechos} artistas procesados en {out}", flush=True)


if __name__ == "__main__":
    main()
