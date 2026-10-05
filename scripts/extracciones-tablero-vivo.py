#!/usr/bin/env python3
"""CRV · Tablero vivo de las extracciones de ENLACES y BIOS.

ENLACES: campaña completa de links de redes sociales y plataformas de streaming
por artista y por álbum (scripts/streaming-colector.py, unidad
crv-streaming-campana) — cosechado en disco, agregado por plataforma y lo
aplicado a public.streaming_links.
BIOS: cola de RYM (rym-bios) — pendientes, capturadas y estado del capturador.

Escribe:
  · /tmp/crv-recon/crv-extracciones-tablero.html    (tablero completo, refresco 15 s)
  · /tmp/crv-recon/crv-extracciones-fragmento.html  (para embeber en el tablero de «nuevos»)
  · reports/streaming-links-2026-10-04/tablero.html (copia persistente)
Pensado para correr en bucle (unit crv-extracciones-tablero, cada 15 s). Nunca lanza.
"""
import json
import subprocess
import time
from html import escape as esc
from pathlib import Path

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
CAMP = Path(REPO) / "reports/streaming-links-2026-10-04/campana"
BIOS = Path(REPO) / "data/raw/fuentes-web-2026-10-01/rym-bios"
OUT_MAIN = "/tmp/crv-recon/crv-extracciones-tablero.html"
OUT_FRAG = "/tmp/crv-recon/crv-extracciones-fragmento.html"
OUT_COPIA = Path(REPO) / "reports/streaming-links-2026-10-04/tablero.html"
CACHE = Path("/tmp/crv-recon/extracciones-cache.json")
HIST = Path("/tmp/crv-recon/extracciones-hist.jsonl")
MARK_SPOTIFY = Path("/tmp/crv-recon/spotify-pase-ok.txt")
TOTAL_ART = 4483
REDES = {"twitter", "facebook", "instagram", "tiktok"}


def psql(sql):
    try:
        out = subprocess.run(
            ["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv", "-tA", "-F", "|", "-c", sql],
            capture_output=True, text=True, timeout=25).stdout
        return [ln.split("|") for ln in out.splitlines() if ln.strip()]
    except Exception:
        return []


def svc(nombre):
    try:
        return subprocess.run(["systemctl", "--user", "is-active", nombre],
                              capture_output=True, text=True, timeout=10).stdout.strip()
    except Exception:
        return "?"


def hhmm(seg):
    m = int(seg // 60)
    return f"{m // 60} h {m % 60} min" if m >= 60 else f"{m} min"


def agregado(n_camp):
    """Agregado por plataforma de todos los links-*.json (con caché de 10 min)."""
    try:
        c = json.loads(CACHE.read_text(encoding="utf-8"))
    except Exception:
        c = {}
    ahora = time.time()
    if c.get("n") is not None and c.get("ts") and (n_camp - c["n"]) < 250 and (ahora - c["ts"]) < 600:
        return c
    plat = {}
    redes = 0
    leidos = 0
    for fp in CAMP.glob("links-*.json"):
        leidos += 1
        try:
            d = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        tiene_red = False
        for l in d.get("artist_links", []):
            p = l.get("platform") or "?"
            if p in REDES:
                tiene_red = True
            x = plat.setdefault(p, {"art": 0, "alb": 0, "fuzzy": 0})
            x["art"] += 1
            if l.get("method") != "exact":
                x["fuzzy"] += 1
        for l in d.get("album_links", []):
            x = plat.setdefault(l.get("platform") or "?", {"art": 0, "alb": 0, "fuzzy": 0})
            x["alb"] += 1
            if l.get("method") != "exact":
                x["fuzzy"] += 1
        if tiene_red:
            redes += 1
    c = {"ts": int(ahora), "n": n_camp, "plat": plat, "redes": redes, "leidos": leidos}
    try:
        CACHE.write_text(json.dumps(c), encoding="utf-8")
    except Exception:
        pass
    return c


def ritmo(n):
    ahora = time.time()
    try:
        rows = [json.loads(l) for l in HIST.read_text(encoding="utf-8").splitlines() if l.strip()]
    except Exception:
        rows = []
    rows = [r for r in rows if ahora - r.get("t", 0) <= 5400][-400:]
    rows.append({"t": int(ahora), "n": n})
    try:
        HIST.write_text("\n".join(json.dumps(r) for r in rows) + "\n", encoding="utf-8")
    except Exception:
        pass
    ref = next((r for r in rows if ahora - r["t"] <= 2700), None)
    if ref and (ahora - ref["t"]) >= 180 and n > ref["n"]:
        return (n - ref["n"]) / ((ahora - ref["t"]) / 60.0)
    return None


def main():
    n_camp = sum(1 for _ in CAMP.glob("links-*.json")) if CAMP.exists() else 0
    rate = ritmo(n_camp)
    eta = None
    if rate and n_camp < TOTAL_ART:
        seg = (TOTAL_ART - n_camp) / rate * 60
        eta = hhmm(seg)

    agg = agregado(n_camp).get("plat") or {}

    bd_sl = psql("SELECT platform, count(*), count(*) FILTER (WHERE artist_id IS NOT NULL), "
                 "count(*) FILTER (WHERE album_id IS NOT NULL), count(*) FILTER (WHERE method <> 'exact'), "
                 "count(*) FILTER (WHERE verified) FROM public.streaming_links GROUP BY platform ORDER BY 2 DESC")
    bd_bio = psql("SELECT count(*) FILTER (WHERE biography IS NOT NULL AND btrim(biography) <> ''), count(*) FROM public.artists")
    con_bio = int(bd_bio[0][0]) if bd_bio and bd_bio[0][0] else 0
    tot_art = int(bd_bio[0][1]) if bd_bio and len(bd_bio[0]) > 1 and bd_bio[0][1] else TOTAL_ART

    bd_por_plat = {r[0]: r for r in bd_sl if r}
    tot_links = sum(int(r[1]) for r in bd_sl if len(r) > 1)
    tot_fuzzy = sum(int(r[4]) for r in bd_sl if len(r) > 4)
    tot_ver = sum(int(r[5]) for r in bd_sl if len(r) > 5)

    n_cola = 0
    try:
        n_cola = sum(1 for l in (BIOS / "cola-bios.jsonl").read_text(encoding="utf-8").splitlines() if l.strip())
    except Exception:
        pass
    bios_cap = 0
    try:
        bios_cap = sum(1 for _ in (BIOS / "pages").glob("*.json"))
    except Exception:
        pass
    svc_camp = svc("crv-streaming-campana")
    svc_watch = svc("crv-spotify-watch")
    svc_bios = svc("crv-rym-bios")
    svc_nuevas = svc("crv-scrapling-nuevos")
    svc_redes = svc("crv-redes-pase")

    if MARK_SPOTIFY.exists():
        sp_txt, sp_sub = "✅ pase hecho (piloto)", MARK_SPOTIFY.read_text(encoding="utf-8").strip()[:60]
    elif svc_watch == "active":
        sp_txt, sp_sub = "🟡 en espera del castigo", "sonda cada 20 min; al primer OK completa el piloto solo"
    else:
        sp_txt, sp_sub = "—", "vigilante no activo"

    if svc_bios == "active":
        bios_estado = "capturando"
    elif svc_nuevas == "active":
        bios_estado = "en espera — una sola sesión RYM (corre «nuevos»)"
    else:
        bios_estado = "lista para lanzar"
    if bios_cap:
        bios_estado = "capturando"

    pct_enl = int(n_camp * 100 / TOTAL_ART) if TOTAL_ART else 0
    pct_bio = int(con_bio * 100 / tot_art) if tot_art else 0

    filas_plat = []
    plats = sorted(set(agg) | set(bd_por_plat), key=lambda p: -((agg.get(p) or {}).get("art", 0) + (agg.get(p) or {}).get("alb", 0)))
    for p in plats:
        a = agg.get(p) or {}
        b = bd_por_plat.get(p) or ["", "0"]
        filas_plat.append(
            f'<tr><td>{esc(p)}</td><td class="n">{a.get("art", 0)}</td><td class="n">{a.get("alb", 0)}</td>'
            f'<td class="n">{int(b[1]) if len(b) > 1 and b[1] else 0}</td>'
            f'<td class="n">{a.get("fuzzy", 0)}</td></tr>')

    servicios = [("crv-streaming-campana", svc_camp), ("crv-spotify-watch", svc_watch),
                 ("crv-redes-pase", svc_redes), ("crv-rym-bios", svc_bios),
                 ("crv-scrapling-nuevos", svc_nuevas)]
    salud = " · ".join(
        f'<span class="{"ok" if v == "active" else "warn"}">{esc(n)}: {esc(v)}</span>' for n, v in servicios)

    css = """<style>
.ex-wrap{font:13px/1.45 system-ui,'Segoe UI',Roboto,sans-serif;margin:18px 0}
.ex-wrap h2{font-size:15px;margin:14px 0 4px;color:#e6e9ee}
.ex-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(215px,1fr));gap:10px;margin:8px 0}
.ex-card{background:#151a21;border:1px solid #232b36;border-radius:10px;padding:11px 13px}
.ex-card h3{margin:0 0 6px;font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:#8b98a9;font-weight:600}
.ex-big{font-size:21px;font-weight:700}
.ex-sub{color:#8b98a9;font-size:11.5px;margin-top:5px}
.ex-bar{height:6px;background:#232b36;border-radius:4px;overflow:hidden;margin-top:8px}
.ex-bar i{display:block;height:100%;background:linear-gradient(90deg,#2f81f7,#3fb950)}
.ex-wrap table{border-collapse:collapse;width:100%;margin-top:6px;background:#12161d}
.ex-wrap th,.ex-wrap td{border:1px solid #232833;padding:3px 8px;font-size:12px;text-align:left}
.ex-wrap th{background:#1a1e27;color:#aab6c4}
.ex-wrap td.n{text-align:right}
.ex-ok{color:#6fe39a}.ex-warn{color:#ffcf6f}.ex-dim{color:#8b98a9}
</style>"""

    frag = f"""<div class="ex-wrap">{css}
<h2>Enlaces · redes sociales y plataformas de streaming (por artista y por álbum)</h2>
<div class="ex-grid">
  <div class="ex-card"><h3>Campaña en curso</h3><div class="ex-big">{n_camp} / {TOTAL_ART}</div>
    <div class="ex-sub">pendientes {TOTAL_ART - n_camp} · ritmo ~{f"{rate:.1f}/min" if rate else "—"} · ETA {eta or "—"} ·
    <span class="ex-dim">{esc(svc_camp)}</span></div>
    <div class="ex-bar"><i style="width:{pct_enl}%"></i></div></div>
  <div class="ex-card"><h3>En la BD (streaming_links)</h3><div class="ex-big">{tot_links}</div>
    <div class="ex-sub">artistas cosechados {n_camp} · en la tabla con fuzzy {tot_fuzzy} · verificados {tot_ver}</div></div>
  <div class="ex-card"><h3>Redes sociales (perfil)</h3><div class="ex-big">{agregado(n_camp).get("redes", 0)} artistas</div>
    <div class="ex-sub">twitter/x · facebook · instagram · tiktok (vía MusicBrainz) · pase de previos: <span class="ex-dim">{esc(svc_redes)}</span></div></div>
  <div class="ex-card"><h3>Spotify</h3><div class="ex-big">{sp_txt}</div>
    <div class="ex-sub">{esc(sp_sub)}</div></div>
</div>
<table>
<tr><th>Plataforma</th><th>Perfiles</th><th>Álbumes</th><th>En BD</th><th>Fuzzy</th></tr>
{"".join(filas_plat) or "<tr><td colspan=5 class=ex-dim>sin datos todavía</td></tr>"}
</table>
<h2>Bios · pestaña de biografía de RYM</h2>
<div class="ex-grid">
  <div class="ex-card"><h3>Cola de bios</h3><div class="ex-big">{bios_cap} / {n_cola + bios_cap}</div>
    <div class="ex-sub">pendientes {n_cola} · {esc(bios_estado)} · solo artistas sin bio con slug RYM</div>
    <div class="ex-bar"><i style="width:{int(bios_cap * 100 / max(n_cola + bios_cap, 1))}%"></i></div></div>
  <div class="ex-card"><h3>Catálogo (artistas con bio)</h3><div class="ex-big">{con_bio} / {tot_art}</div>
    <div class="ex-sub">sin bio {tot_art - con_bio} · {pct_bio} %</div></div>
  <div class="ex-card"><h3>Capturador de bios</h3><div class="ex-big">{esc(bios_estado)}</div>
    <div class="ex-sub">se lanza al cerrar «nuevos» (una sola sesión RYM a la vez) · <span class="ex-dim">{esc(svc_bios)}</span></div></div>
</div>
<div class="ex-sub">Salud: {salud} · actualizado {time.strftime('%H:%M:%S')}</div>
</div>"""

    doc = ("<!doctype html><meta charset=\"utf-8\"><title>CRV · extracciones — enlaces y bios</title>"
           "<meta http-equiv=\"refresh\" content=\"15\">"
           "<style>body{background:#0e1116;color:#e6e9ee;margin:0;padding:6px 18px 30px}"
           "a{color:#6cb6ff}</style>" + frag + "</body>")

    for p, txt in ((OUT_MAIN, doc), (OUT_FRAG, frag), (str(OUT_COPIA), doc)):
        try:
            Path(p).parent.mkdir(parents=True, exist_ok=True)
            Path(p).write_text(txt, encoding="utf-8")
        except Exception as e:  # noqa: BLE001
            print(f"aviso {p}: {e}", flush=True)


if __name__ == "__main__":
    main()
