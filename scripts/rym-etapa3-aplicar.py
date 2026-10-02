#!/usr/bin/env python3
"""Etapa 3 — convierte lo capturado de RYM en candidatos aplicables:

- Fotos de artista (photo real, no portada) → reports/rym-fotos-2026-10-01.jsonl
  (formato localize-images --candidates; descarga y asocia con run).
- Portadas de disco (og:image 1200px de la ficha) → reports/rym-covers-2026-10-01.jsonl
- Años (de la ficha) → reports/rym-years-2026-10-01.jsonl
  (formato apply-album-years).

Solo emite para fichas del catálogo que siguen vacías. Escribe además un
resumen con lo NO aplicable (discos RYM que no están en el catálogo).
"""
import json, os, re, subprocess, sys, unicodedata

REPO = "/home/brian/apps/Coleccionistas De Rock Venezolano"
RYM = f"{REPO}/data/raw/fuentes-web-2026-10-01/rym-etapa3"
PAGES = f"{RYM}/pages"


def compact(value):
    if not value:
        return ""
    s = unicodedata.normalize("NFKD", value.lower())
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]", "", s)


def norm_href(h):
    from urllib.parse import unquote
    if not h:
        return ""
    h = unquote(h)
    if h.startswith("https://rateyourmusic.com"):
        h = h[len("https://rateyourmusic.com"):]
    return h.split("?")[0].split("#")[0].rstrip("/")


def slugify(href):
    s = norm_href(href).replace("/artist/", "").replace("/", "_")
    s = re.sub(r"[^A-Za-z0-9_\-\.]", "", s)
    return s[:90] or "sin-slug"


def sql(q):
    r = subprocess.run(["docker", "exec", "crv-postgres", "psql", "-U", "crv", "-d", "crv",
                        "-At", "-F", "\t", "-c", q], capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(r.stderr)
    return [l.split("\t") for l in r.stdout.strip().split("\n") if l.strip()]


def main():
    cola = [json.loads(l) for l in open(f"{RYM}/cola.jsonl", encoding="utf-8") if l.strip()]
    by_href = {norm_href(r["rymHref"]): r for r in cola}
    ids = [str(r["artistId"]) for r in cola]

    # estado del catálogo para estos artistas
    alb = {}
    for a in sql(f"SELECT al.id, al.artist_id, al.title, coalesce(al.release_year::text,''), (al.cover_url IS NULL OR btrim(al.cover_url)='') FROM public.albums al WHERE al.artist_id IN ({','.join(ids)})"):
        alb.setdefault(int(a[1]), []).append({"id": int(a[0]), "title": a[2], "year": int(a[3]) if a[3] else None, "sin_portada": a[4] == "t"})
    fotos_cat = {int(a[0]) for a in sql(f"SELECT id FROM public.artists WHERE id IN ({','.join(ids)}) AND picture_url IS NOT NULL AND btrim(picture_url)<>''")}
    sin_formed = {int(a[0]) for a in sql(f"SELECT id FROM public.artists WHERE id IN ({','.join(ids)}) AND formed_year IS NULL")}

    fotos, covers, years, nuevos, formed = [], [], [], [], []
    artistas_ok = 0

    def year_de(info, html_head=""):
        for pat in (r"[Rr]eleased[^\d]{0,20}(\d{4})", r"(\d{4})"):
            m = re.search(pat, info or "")
            if m:
                return int(m.group(1))
        return None

    for href, row in by_href.items():
        f = os.path.join(PAGES, slugify(href) + ".json")
        if not os.path.exists(f):
            continue
        try:
            rec = json.load(open(f, encoding="utf-8"))["rec"]
        except Exception:
            continue
        artistas_ok += 1
        if rec.get("formed") and row["artistId"] in sin_formed:
            formed.append({"artistId": row["artistId"], "name": row["name"], "year": rec["formed"],
                           "source": "rym", "url": "https://rateyourmusic.com" + href,
                           "note": f"ficha de Rate Your Music: «{row['name']}» (formed {rec['formed']})"})
        if rec.get("photo") and not rec.get("photoEsCover"):
            if row["artistId"] not in fotos_cat:
                src = rec["photo"].get("src", "")
                if src.startswith("//"):
                    src = "https:" + src
                if src.startswith("http"):
                    fotos.append({"kind": "artist", "id": row["artistId"], "sourceUrl": src,
                                  "label": row["name"], "source": "rym", "snapshotUrl": "https://rateyourmusic.com" + href})
        # discos
        for r in (rec.get("rows") or []):
            rel = norm_href(r.get("h"))
            if not rel:
                continue
            capf = os.path.join(PAGES, "rel_" + slugify(rel.replace("/release/", "")) + ".json")
            if not os.path.exists(capf):
                continue
            try:
                rc = json.load(open(capf, encoding="utf-8"))["rec"]
            except Exception:
                continue
            titulo_rym = (rc.get("name") or r.get("t") or "").strip()
            year_rym = year_de(rc.get("info") or "")
            og = rc.get("og") or ""
            match = None
            for a in alb.get(row["artistId"], []):
                ck, rk = compact(a["title"]), compact(titulo_rym)
                if ck and rk and (ck == rk or (len(ck) >= 6 and (rk.startswith(ck) or ck.startswith(rk)))):
                    match = a
                    break
            if not match:
                nuevos.append({"artistId": row["artistId"], "artist": row["name"], "rymTitle": titulo_rym, "rymHref": rel, "year": year_rym})
                continue
            if match["sin_portada"] and og.startswith("http"):
                covers.append({"kind": "album", "id": match["id"], "sourceUrl": og, "label": match["title"],
                               "artist": row["name"], "source": "rym", "snapshotUrl": "https://rateyourmusic.com" + rel})
            if match["year"] is None and year_rym and 1950 <= year_rym <= 2026:
                years.append({"albumId": match["id"], "title": match["title"], "artist": row["name"], "year": year_rym,
                              "source": "rym", "extractor": "ficha-rym", "postTitle": titulo_rym,
                              "url": "https://rateyourmusic.com" + rel,
                              "note": f"ficha de Rate Your Music: «{titulo_rym}» ({year_rym})"})

    def escribir(name, rows):
        path = f"{REPO}/reports/{name}"
        with open(path, "w", encoding="utf-8") as f:
            for row in rows:
                f.write(json.dumps(row, ensure_ascii=False) + "\n")
        print(f"{name}: {len(rows)}")

    escribir("rym-fotos-2026-10-01.jsonl", fotos)
    escribir("rym-covers-2026-10-01.jsonl", covers)
    escribir("rym-years-2026-10-01.jsonl", years)
    escribir("rym-discos-fuera-2026-10-01.jsonl", nuevos)
    escribir("rym-formed-2026-10-01.jsonl", formed)
    print(f"artistas capturados usados: {artistas_ok} | candidatos: fotos {len(fotos)}, portadas {len(covers)}, años {len(years)}, discos fuera de catálogo {len(nuevos)}")


if __name__ == "__main__":
    main()
