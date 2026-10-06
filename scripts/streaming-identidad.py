#!/usr/bin/env python3
"""Identidad de los enlaces de la campaña de streaming — pasada por MusicBrainz (solo lectura del catálogo).

El colector casó MusicBrainz (redes sociales, Spotify, YouTube…) y Deezer solo por NOMBRE: la ficha
2469 «Skank» recibió las redes de la banda brasileña. Decisión de Brian (2026-10-05): en el catálogo
solo se muestran los enlaces confirmados; el resto entra a la base con verified=false.

Por artista de la campaña repite la MISMA elección de candidato que `streaming-colector.py`
(búsqueda artist:"nombre", mejor ratio ≥ 0,90) y consulta la ficha MB con url-rels y release-groups:

  * confirmado_pais   — el país/área de MB coincide con el origen de la ficha (Venezuela si no consta);
  * confirmado_disco  — algún release-group de MB coincide con un disco de la ficha en el catálogo;
  * contradice_pais   — MB dice otro país y no hay disco en común (homónimo casi seguro);
  * sin_datos         — MB no da país ni hay disco en común;
  * sin_match         — MB ya no devuelve candidato ≥ 0,90.

Además guarda los url-rels de MB (Deezer/Spotify/Apple) para cruzar con el perfil de Deezer.
Reanudable: añade a reports/streaming-links-2026-10-04/identidad-mb.jsonl y salta lo ya hecho.

Uso: python3 scripts/streaming-identidad.py [--limite N]
"""
import importlib.util
import json
import os
import re
import subprocess
import sys
import time
import unicodedata
import urllib.parse
from pathlib import Path

ROOT = Path("/home/brian/apps/Coleccionistas De Rock Venezolano")
CAMP = ROOT / "reports/streaming-links-2026-10-04/campana"
OUT = ROOT / "reports/streaming-links-2026-10-04/identidad-mb.jsonl"

spec = importlib.util.spec_from_file_location("colector", ROOT / "scripts/streaming-colector.py")
col = importlib.util.module_from_spec(spec)
spec.loader.exec_module(col)

PAISES = {"venezuela": "VE", "colombia": "CO", "españa": "ES", "espana": "ES", "spain": "ES", "méxico": "MX",
          "mexico": "MX", "argentina": "AR", "chile": "CL", "perú": "PE", "peru": "PE", "cuba": "CU",
          "estados unidos": "US", "united states": "US", "usa": "US", "puerto rico": "PR", "brasil": "BR",
          "brazil": "BR", "italia": "IT", "italy": "IT", "francia": "FR", "france": "FR", "alemania": "DE",
          "germany": "DE", "reino unido": "GB", "united kingdom": "GB", "canadá": "CA", "canada": "CA",
          "panamá": "PA", "panama": "PA", "república dominicana": "DO", "ecuador": "EC", "uruguay": "UY",
          "portugal": "PT", "trinidad y tobago": "TT"}


def sql(q):
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-At", "-F", "\t", "-c", q],
                       capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr)
    return [l.split("\t") for l in r.stdout.split("\n") if l.strip()]


def compact(s):
    s = unicodedata.normalize("NFKD", s or "").encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", s)


def mb_get(url):
    time.sleep(col.SLEEP["mb"])
    for intento in range(4):
        d = col.http_json(url)
        if d is not None:
            return d
        time.sleep(5 * (intento + 1))
    return None


def main():
    limite = int(sys.argv[sys.argv.index("--limite") + 1]) if "--limite" in sys.argv else None
    hechos = set()
    if OUT.exists():
        for l in OUT.read_text(encoding="utf-8").splitlines():
            if l.strip():
                hechos.add(json.loads(l)["artistId"])
    origen = {int(r[0]): PAISES.get((r[1] or "").strip().lower(), (r[1] or "").strip().upper()[:2] or "VE")
              for r in sql("SELECT id, coalesce(origin_country,'') FROM public.artists")}
    discos = {}
    for r in sql("SELECT artist_id, title FROM public.albums"):
        discos.setdefault(int(r[0]), set()).add(compact(r[1]))

    # primero los que tienen enlaces de MB (redes), luego los Deezer sin disco en común
    cola = []
    for f in sorted(CAMP.glob("links-*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        if d["artistId"] in hechos or not d["artist_links"]:
            continue
        mb = any(l["source"] == "musicbrainz-url-rels" for l in d["artist_links"])
        dz_sin_disco = any(l["platform"] == "deezer" for l in d["artist_links"]) and not any(
            l["platform"] == "deezer" for l in d["album_links"])
        if mb or dz_sin_disco:
            cola.append((0 if mb else 1, d["artistId"], d["name"]))
    cola.sort()
    if limite:
        cola = cola[:limite]
    print(f"cola {len(cola)} (ya hechos {len(hechos)})", flush=True)

    with OUT.open("a", encoding="utf-8") as out:
        for n, (_, aid, nombre) in enumerate(cola, 1):
            rec = {"artistId": aid, "name": nombre, "origen": origen.get(aid, "VE")}
            q = urllib.parse.quote(f'artist:"{nombre}"')
            d = mb_get(f"https://musicbrainz.org/ws/2/artist/?query={q}&fmt=json&limit=3")
            best = None
            for a in ((d or {}).get("artists") or []):
                r = col.ratio(col.norm(nombre), col.norm(a.get("name") or ""))
                if best is None or r > best[0]:
                    best = (r, a)
            if d is None:
                rec["veredicto"] = "error_api"
            elif not best or best[0] < 0.90:
                rec["veredicto"] = "sin_match"
            else:
                a = best[1]
                d2 = mb_get(f"https://musicbrainz.org/ws/2/artist/{a['id']}?inc=url-rels+release-groups&fmt=json") or {}
                area = (d2.get("area") or {})
                pais = d2.get("country") or ((area.get("iso-3166-1-codes") or [None])[0])
                rgs = [rg.get("title") or "" for rg in d2.get("release-groups") or []]
                comunes = [t for t in rgs if compact(t) and compact(t) in discos.get(aid, set())]
                rels = {}
                for rel in d2.get("relations") or []:
                    u = ((rel.get("url") or {}).get("resource") or "")
                    for dom, p in (("deezer.com", "deezer"), ("open.spotify.com", "spotify"), ("apple.com", "apple_music")):
                        if dom in u:
                            rels.setdefault(p, u)
                rec.update(mbid=a["id"], mb_name=a.get("name"), score=round(best[0], 3), pais=pais,
                           area=area.get("name"), begin_area=(d2.get("begin-area") or {}).get("name"),
                           disambiguation=d2.get("disambiguation") or "", discos_comunes=comunes[:5],
                           n_release_groups=len(rgs), rels=rels)
                if comunes:
                    rec["veredicto"] = "confirmado_disco"
                elif pais and pais == rec["origen"]:
                    rec["veredicto"] = "confirmado_pais"
                elif pais:
                    rec["veredicto"] = "contradice_pais"
                else:
                    rec["veredicto"] = "sin_datos"
            rec["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()
            if n % 50 == 0:
                print(f"{n}/{len(cola)} · último {nombre} → {rec['veredicto']}", flush=True)
    print("IDENTIDAD MB TERMINADA", flush=True)


if __name__ == "__main__":
    main()
