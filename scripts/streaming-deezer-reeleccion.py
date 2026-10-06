#!/usr/bin/env python3
"""Re-elección del perfil de Deezer por discos en común (solo lectura del catálogo).

El colector eligió el perfil de Deezer solo por el nombre: con «Billo's Caracas Boys» se quedó
con un perfil vacío (0 discos, 17 fans) y no con el real (260 discos), así que no casó ni un
disco. Aquí, para cada artista de la campaña con perfil de Deezer y sin ningún disco casado en
Deezer, se prueban TODOS los candidatos de la búsqueda con nombre parecido (≥ 0,90) y se elige
el que más discos comparte con la ficha en el catálogo vivo (empate → más fans). Con 0 discos
en común no se elige ninguno: el perfil sigue sin confirmar.

Salida (reanudable): reports/streaming-links-2026-10-04/deezer-reeleccion.jsonl
  {artistId, name, antes, perfil{url,id,name_plat,nb_fan,nb_album}, comunes, album_links[...]}

Uso: python3 scripts/streaming-deezer-reeleccion.py [--limite N]
"""
import importlib.util
import json
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path

ROOT = Path("/home/brian/apps/Coleccionistas De Rock Venezolano")
CAMP = ROOT / "reports/streaming-links-2026-10-04/campana"
OUT = ROOT / "reports/streaming-links-2026-10-04/deezer-reeleccion.jsonl"

spec = importlib.util.spec_from_file_location("colector", ROOT / "scripts/streaming-colector.py")
col = importlib.util.module_from_spec(spec)
spec.loader.exec_module(col)


def sql(q):
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-At", "-F", "\t", "-c", q],
                       capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr)
    return [l.split("\t") for l in r.stdout.split("\n") if l.strip()]


def main():
    limite = int(sys.argv[sys.argv.index("--limite") + 1]) if "--limite" in sys.argv else None
    hechos = set()
    if OUT.exists():
        hechos = {json.loads(l)["artistId"] for l in OUT.read_text(encoding="utf-8").splitlines() if l.strip()}
    discos = {}
    for r in sql("SELECT id, artist_id, title, release_year FROM public.albums"):
        discos.setdefault(int(r[1]), []).append({"id": int(r[0]), "title": r[2], "year": int(r[3]) if r[3] else None})

    cola = []
    for f in sorted(CAMP.glob("links-*.json")):
        d = json.loads(f.read_text(encoding="utf-8"))
        dz = [l for l in d["artist_links"] if l["platform"] == "deezer"]
        if (d["artistId"] in hechos or not dz or not discos.get(d["artistId"])
                or any(l["platform"] == "deezer" for l in d["album_links"])):
            continue
        cola.append((d["artistId"], d["name"], dz[0]["url"]))
    if limite:
        cola = cola[:limite]
    print(f"cola {len(cola)} (ya hechos {len(hechos)})", flush=True)

    with OUT.open("a", encoding="utf-8") as out:
        for n, (aid, nombre, antes) in enumerate(cola, 1):
            time.sleep(col.SLEEP["deezer"])
            s = col.http_json("https://api.deezer.com/search/artist?" + urllib.parse.urlencode({"q": nombre, "limit": 10}))
            mejor = None
            for c in ((s or {}).get("data") or []):
                r = col.ratio(col.norm(nombre), col.norm(c.get("name") or ""))
                if r < 0.90 or not c.get("nb_album"):
                    continue
                albs = col.deezer_artist_albums(c["id"])
                links = []
                for al in discos[aid]:
                    m, met, sc = col.pick_album(al, albs)
                    if m and met:
                        links.append({"albumId": al["id"], "platform": "deezer", "url": m["url"], "id": m["id"],
                                      "method": met, "source": "deezer-albums", "score": sc,
                                      "title_plat": m.get("title"), "year_plat": m.get("year")})
                clave = (len(links), c.get("nb_fan") or 0)
                if links and (mejor is None or clave > mejor[0]):
                    mejor = (clave, c, links, r)
            rec = {"artistId": aid, "name": nombre, "antes": antes, "comunes": 0, "album_links": []}
            if mejor:
                _, c, links, r = mejor
                rec.update(perfil={"url": c.get("link"), "id": c.get("id"), "name_plat": c.get("name"),
                                   "nb_fan": c.get("nb_fan"), "nb_album": c.get("nb_album"),
                                   "score": round(r, 3), "method": "exact" if r >= 0.98 else "fuzzy"},
                           comunes=len(links), album_links=links, cambia=c.get("link") != antes)
            rec["at"] = time.strftime("%Y-%m-%d %H:%M:%S")
            out.write(json.dumps(rec, ensure_ascii=False) + "\n")
            out.flush()
            if n % 50 == 0:
                print(f"{n}/{len(cola)} · {nombre} → {rec['comunes']} en común", flush=True)
    print("REELECCION DEEZER TERMINADA", flush=True)


if __name__ == "__main__":
    main()
