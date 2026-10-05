#!/usr/bin/env python3
"""Filtra los expedientes exportados a los artistas SIN biografía con fuentes.

Lee reports/bios-2026-10-05/dossiers/artist-*.jsonl (salida de
export-biography-dossiers.ts) y deja solo los caseId cuyo artistId no tiene
biografía AHORA en la base y cuyo expediente trae al menos una fuente. Reescribe
los mismos archivos (y el manifest se corrige aparte con contar).
"""
import glob
import json
import subprocess
import sys

DIR = sys.argv[1] if len(sys.argv) > 1 else "reports/bios-2026-10-05/dossiers"
SQL = "SELECT id FROM public.artists WHERE biography IS NULL OR btrim(biography) = ''"
out = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-tAc", SQL],
                     capture_output=True, text=True).stdout
sin_bio = {int(x) for x in out.split() if x.strip().isdigit()}
print("artistas sin bio:", len(sin_bio))

total_in = total_out = con_fuentes = sin_fuentes = 0
nuevos = {}
for f in sorted(glob.glob(f"{DIR}/artist-*.jsonl")):
    keep = []
    for line in open(f, encoding="utf-8"):
        if not line.strip():
            continue
        total_in += 1
        d = json.loads(line)
        eid = int(d["entityId"])
        if eid not in sin_bio:
            continue
        if not (d.get("sources") or []):
            sin_fuentes += 1
            continue
        keep.append(line.rstrip("\n"))
        con_fuentes += 1
        nuevos[eid] = len(d["sources"])
    open(f, "w", encoding="utf-8").write(("\n".join(keep) + "\n") if keep else "")
    total_out += len(keep)
print(f"expedientes: {total_in} → {total_out} (sin bio y con fuentes) · descartados sin fuentes: {sin_fuentes}")
print("primeros 10 con fuentes:", [(k, v) for k, v in list(nuevos.items())[:10]])
