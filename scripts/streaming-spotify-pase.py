#!/usr/bin/env python3
"""CRV · Pase quirúrgico de Spotify sobre los links-*.json con «spotify» pendiente.

Cuando las credenciales de Spotify están castigadas (429), el rescate completo
(--reintentar-plataforma spotify del colector) re-hace TODAS las plataformas.
Este pase, en cambio, solo llama a Spotify, reutilizando las funciones del
colector. Hace merge sin perder los links de otras fuentes (MusicBrainz y
Wikidata no se tocan; solo se reemplazan los `spotify-search`/`spotify-albums`).

Si la primera llamada da 429 el pase PARA (el castigo sigue; no se spammea).
Uso:
  python3 scripts/streaming-spotify-pase.py \
    --dir reports/streaming-links-2026-10-04/piloto-100 \
    --artistas data/raw/streaming-2026-10-04/artistas.jsonl \
    --albumes data/raw/streaming-2026-10-04/albumes.jsonl
"""
import argparse
import json
from importlib.machinery import SourceFileLoader
from pathlib import Path

m = SourceFileLoader("colector", str(Path(__file__).with_name("streaming-colector.py"))).load_module()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--artistas", required=True)
    ap.add_argument("--albumes", required=True)
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    ap_alb = {}
    for ln in Path(args.albumes).read_text(encoding="utf-8").splitlines():
        if ln.strip():
            a = json.loads(ln)
            ap_alb.setdefault(a["artistId"], []).append(a)
    nombres = {}
    for ln in Path(args.artistas).read_text(encoding="utf-8").splitlines():
        if ln.strip():
            a = json.loads(ln)
            nombres[a["id"]] = a["name"]

    pend = []
    for fp in sorted(Path(args.dir).glob("links-*.json")):
        d = json.loads(fp.read_text(encoding="utf-8"))
        if any("spotify" in e for e in d.get("fuentes_error", [])):
            pend.append(fp)
    if args.limit:
        pend = pend[: args.limit]
    print(f"pendientes de spotify: {len(pend)}", flush=True)
    if not pend:
        return

    sp = m.Spotify()
    hechos = 0
    for fp in pend:
        rec = json.loads(fp.read_text(encoding="utf-8"))
        art = {"id": rec["artistId"], "name": nombres.get(rec["artistId"], rec["name"])}
        try:
            cands = sp.search_artist(art["name"])
        except Exception as e:  # noqa: BLE001
            print(f"PARADA en {fp.name}: {str(e)[:90]}", flush=True)
            print(f"hechos {hechos} (el castigo sigue: reintentar más tarde)", flush=True)
            return
        c, method, score = m.pick_candidate(art["name"], cands)
        nuevos_a, nuevos_d = [], []
        if c and method:
            nuevos_a.append({"platform": "spotify", "url": c["url"], "id": c["id"], "method": method,
                             "source": c["source"], "score": score, "name_plat": c.get("name")})
            if method == "exact":
                try:
                    sp_albums = sp.artist_albums(c["id"])
                    for al in ap_alb.get(art["id"], []):
                        mm, met, sc = m.pick_album(al, sp_albums)
                        if mm and met:
                            nuevos_d.append({"albumId": al["id"], "platform": "spotify", "url": mm["url"],
                                             "id": mm["id"], "method": met, "source": mm["source"],
                                             "score": sc, "title_plat": mm.get("title"), "year_plat": mm.get("year")})
                except Exception as e:  # noqa: BLE001
                    rec.setdefault("fuentes_error", []).append(f"spotify-albums: {str(e)[:60]}")
        rec["artist_links"] = [x for x in rec["artist_links"]
                               if not (x["platform"] == "spotify" and str(x.get("source", "")).startswith("spotify"))] + nuevos_a
        rec["album_links"] = [x for x in rec["album_links"]
                              if not (x["platform"] == "spotify" and str(x.get("source", "")).startswith("spotify"))] + nuevos_d
        rec["fuentes_error"] = [e for e in rec.get("fuentes_error", []) if "spotify" not in e]
        if "spotify" not in rec.get("fuentes_ok", []):
            rec.setdefault("fuentes_ok", []).append("spotify")
        rec["albumes_con_link"] = len({x["albumId"] for x in rec["album_links"]})
        fp.write_text(json.dumps(rec, ensure_ascii=False, indent=1), encoding="utf-8")
        hechos += 1
        if hechos % 10 == 0:
            print(f"  {hechos}/{len(pend)} con spotify hecho", flush=True)
    print(f"listo: {hechos} archivos actualizados (de {len(pend)} pendientes)", flush=True)


if __name__ == "__main__":
    main()
