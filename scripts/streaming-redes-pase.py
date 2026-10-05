#!/usr/bin/env python3
"""CRV · Pase de redes sociales sobre los links-*.json ya cosechados.

Los archivos capturados ANTES de que el colector incluyera las redes sociales
del perfil (twitter/x, facebook, instagram, tiktok vía url-rels de MusicBrainz)
no las tienen. Este pase los recorre, consulta SOLO MusicBrainz y añade los
links de red que falten (merge: no toca nada más; no duplica).

Uso:
  python3 scripts/streaming-redes-pase.py --dir reports/streaming-links-2026-10-04/campana
  (--limit N opcional; --sleep S para espaciar llamadas, por defecto 1.7 s)
"""
import argparse
import json
import time
from importlib.machinery import SourceFileLoader
from pathlib import Path

m = SourceFileLoader("colector", str(Path(__file__).with_name("streaming-colector.py"))).load_module()

REDES = {"twitter", "facebook", "instagram", "tiktok"}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", required=True)
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--sleep", type=float, default=1.7)
    args = ap.parse_args()

    pend = []
    for fp in sorted(Path(args.dir).glob("links-*.json")):
        try:
            d = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        if not any(x.get("platform") in REDES for x in d.get("artist_links", [])):
            pend.append(fp)
    if args.limit:
        pend = pend[: args.limit]
    print(f"sin redes sociales: {len(pend)} archivos", flush=True)

    hechos = con_redes = fallos = 0
    err_seguidos = 0
    for fp in pend:
        d = json.loads(fp.read_text(encoding="utf-8"))
        nombre = d.get("name") or ""
        try:
            mb_name, mb_links = m.mb_artist(nombre)
        except Exception as e:  # noqa: BLE001
            fallos += 1
            err_seguidos += 1
            print(f"  fallo {fp.name}: {str(e)[:70]}", flush=True)
            if err_seguidos >= 4:
                print("  4 fallos seguidos: espero 90 s", flush=True)
                time.sleep(90)
                err_seguidos = 0
            continue
        err_seguidos = 0
        nuevas = [l for l in mb_links if l.get("platform") in REDES]
        if not nuevas:
            hechos += 1
            continue
        existentes = {x.get("platform") for x in d.get("artist_links", [])}
        agregar = [l for l in nuevas if l["platform"] not in existentes]
        hechos += 1
        if agregar:
            d["artist_links"].extend(agregar)
            fp.write_text(json.dumps(d, ensure_ascii=False, indent=1), encoding="utf-8")
            con_redes += 1
        if hechos % 20 == 0:
            print(f"  {hechos}/{len(pend)} · con algúna red nueva: {con_redes}", flush=True)
        time.sleep(args.sleep)
    print(f"listo: {hechos} revisados · {con_redes} con redes nuevas · {fallos} fallos", flush=True)


if __name__ == "__main__":
    main()
