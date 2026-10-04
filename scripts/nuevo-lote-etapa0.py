#!/usr/bin/env python3
"""CRV · Nuevo lote 2026-10-02 — etapa 0 (solo lee la base).

Cruza el lote de investigación (~/Desktop/Nuevo lote) con el catálogo y deja en
reports/nuevo-lote-2026-10-02/:

  identidades.json   lote id → artista(s) del catálogo, personas candidatas,
                     correcciones acordadas (plan §2.9)
  generos.json       término del lote → género de la taxonomía viva
                     (exacto | propuesta | nuevo | no_genero)
  discos.json        disco del lote → existe | variante | falta
  resumen.md         conteos y listas para Brian

Plan: ~/Desktop/PLAN_NUEVO_LOTE_2026-10-02.md
"""
from __future__ import annotations

import collections
import difflib
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# uso: nuevo-lote-etapa0.py [lote.json] [carpeta-salida]   (por defecto, el lote 1)
LOTE = Path(sys.argv[1]) if len(sys.argv) > 1 else Path.home() / "Desktop/Nuevo lote/catalogo_artistas_venezolanos_generos_2026-10-02.json"
OUT = Path(sys.argv[2]) if len(sys.argv) > 2 else ROOT / "reports/nuevo-lote-2026-10-02"

# Identidades decididas a mano al cruzar (2026-10-02). None = nuevo.
IDENTIDAD_MANUAL: dict[str, list[int] | None] = {
    "arca": None,  # nuevo: Nuuro (1250) es otro proyecto de la misma persona (P2528), no Arca (Brian 2026-10-02); El Arca 1414 es otra banda
    "zardonic": [795],  # Triangular Ascension 835 se fusiona aquí (alias)
    "servando-y-florentino": [2014],
    "jose-luis-rodriguez-el-puma": [3756],  # 3712 se fusiona aquí
    "nacha-pop-rueda": [3832],  # el registro del lote es Los Cañoneros
}

# Correcciones acordadas (plan §2.9). Se aplican en la etapa 2.
CORRECCIONES = [
    {"op": "fusionar_artista", "de": 3712, "en": 3756, "nota": "José Luis Rodríguez «El Puma» duplicado; nombre artístico como alias"},
    {"op": "fusionar_artista", "de": 835, "en": 795, "nota": "Triangular Ascension es alias de Zardonic; Gorepriest también", "alias": ["Triangular Ascension", "Gorepriest"]},
    {"op": "fusionar_persona", "ids": [1022, 19777], "nota": "Alberto Stangarone (solo si comparten proyecto)"},
    {"op": "fusionar_persona", "ids": [18567, 19776], "nota": "Sunsplash como persona (solo si comparten proyecto)"},
    {"op": "fusionar_persona", "ids": [2398, 18955], "nota": "Pablo Gil (solo si comparten proyecto)"},
    {"op": "fusionar_persona", "ids": [19503, 19720], "nota": "Antonio Estévez (solo si comparten proyecto)"},
    {"op": "persona_a_artista", "persona": 25848, "nota": "Chino y Nacho es un dúo"},
    {"op": "persona_a_artista", "persona": 26549, "artista": 2014, "nota": "Servando & Florentino ya es el artista 2014"},
]

# Equivalencias propuestas para términos del lote sin alias en la taxonomía.
# Solo cuando el significado coincide; lo demás es «nuevo» (decide Brian) o
# «no_genero» (rol, técnica o descripción, no estilo).
PROPUESTA: dict[str, str] = {
    "latin pop": "pop-latino", "romantic pop": "pop-latino", "tropical pop": "musica-tropical",
    "romantic ballad": "balada", "romantic song": "balada", "baladas": "balada",
    "latin jazz": "jazz-latino", "venezuelan jazz": "jazz-latino", "modern jazz": "jazz",
    "contemporary jazz": "jazz", "chamber jazz": "jazz", "jazz pop": "jazz", "electronic jazz": "nu-jazz",
    "merengue venezolano": "merengue", "salsa dura": "salsa", "salsa brava": "salsa",
    "son cubano": "son", "guajira": "son", "tropical": "musica-tropical", "tropical fusion": "musica-tropical",
    "tropical dance orchestra": "musica-tropical", "tropical dance": "musica-tropical",
    "clasica": "musica-clasica", "contemporary classical": "musica-clasica", "modern classical": "neoclasica",
    "contemporary composition": "musica-clasica", "symphonic repertory": "musica-clasica",
    "orchestral": "musica-clasica", "chamber": "musica-de-camara", "chamber music": "musica-de-camara",
    "choral": "musica-coral", "baroque": "musica-antigua",
    "electroacoustic": "electroacustica", "acousmatic": "electroacustica", "computer music": "electroacustica",
    "live electronics": "electroacustica",
    "r&b": "r-and-b", "latin r&b": "r-and-b", "alternative r&b": "r-and-b", "neo soul": "soul",
    "rap": "hip-hop", "latin rap": "hip-hop", "venezuelan hip hop": "hip-hop", "underground hip hop": "hip-hop",
    "underground rap": "hip-hop", "alternative hip hop": "rap-experimental", "conscious rap": "hip-hop",
    "political rap": "hip-hop", "hip hop fusion": "hip-hop", "caribbean hip hop": "hip-hop",
    "rastafari reggae": "roots-reggae", "dark wave": "darkwave", "electronic dance music": "dance",
    "edm pop": "dance", "latin dance": "dance", "acid house": "house", "tribal house": "house",
    "house fusion": "house", "hard techno": "techno", "melodic techno": "techno",
    "progressive ambient": "ambient", "jungle": "drum-and-bass", "industrial drum and bass": "drum-and-bass",
    "metalstep": "dubstep", "garage": "garage-rock", "krautrock": "rock-experimental",
    "dance punk": "post-punk", "dance rock": "rock-alternativo", "alternative pop": "pop",
    "singer songwriter": "cantautor", "contemporary singer songwriter": "cantautor",
    "folk pop": "folk", "venezuelan traditions": "musica-tradicional", "traditional popular music": "musica-tradicional",
    "popular venezuelan forms": "musica-tradicional", "venezuelan folk fusion": "joropo-fusion",
    "gaita fusion": "gaita", "cumbia electronica": "latin-electronic-fusion",
    "afro caribbean electronic": "latin-electronic-fusion", "tropical bass": "latin-electronic-fusion",
    "experimental electronic": "electronica", "instrumental electronic": "electronica",
    "cinematic electronic": "electronica", "progressive electronic": "electronica",
    "synthesizer music": "electronica", "berlin school": "electronica", "lo fi": "electronica",
    "experimental club": "electronica", "breakcore": "drum-and-bass",
    "electronic": "electronica", "punk": "punk-rock", "r&b influenced pop": "pop",
}
NO_GENERO = {
    "fusion",  # suelta es ambigua (jazz o latina): no se asigna (generos-fuente-basta)
    "opera conducting", "orchestral conducting", "songwriting", "television music", "television song",
    "telenovela theme music", "audio reactive art", "ethnosonics", "classical vocal", "lyric tenor",
    "male soprano", "operatic soprano", "popular song", "art song", "atonal/serial", "classical guitar",
    "romantic piano", "documentary score",
}


def n_name(value: str) -> str:
    s = unicodedata.normalize("NFD", value.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"&|\by\b|\band\b", " ", s)
    s = re.sub(r"[^a-z0-9]+", " ", s).strip()
    return re.sub(r"^(los|las|la|el|the) ", "", s)


def n_title(value: str) -> str:
    s = unicodedata.normalize("NFD", value.lower())
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = re.sub(r"\(.*?\)|\[.*?\]", " ", s)
    return re.sub(r"[^a-z0-9]+", " ", s).strip()


def n_genre(value: str) -> str:
    """Igual que normalizeGenreText (src/genres/normalize.ts)."""
    s = unicodedata.normalize("NFD", value)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn").lower()
    s = re.sub(r"[´`'’‘]", "", s)
    s = re.sub(r"[‐-―_-]", " ", s)
    s = re.sub(r'^[\s.,;:!?"()\[\]{}]+|[\s.,;:!?"()\[\]{}]+$', "", s)
    return re.sub(r"\s+", " ", s).strip()


def q(sql: str) -> list[list[str]]:
    out = subprocess.run(
        ["docker", "exec", "-i", "crv-postgres", "psql", "-X", "-U", "crv", "-d", "crv", "-At", "-F", "\t", "-c", sql],
        check=True, capture_output=True, text=True,
    ).stdout
    return [line.split("\t") for line in out.splitlines() if line]


def main() -> None:
    lote = json.loads(LOTE.read_text())
    artistas_lote = lote["artists"]
    OUT.mkdir(parents=True, exist_ok=True)

    arts = {int(r[0]): r for r in q(
        "select a.id,a.name,a.artist_type,coalesce(length(a.biography),0),(a.picture_url is not null)::int,"
        "coalesce(a.origin_city,''),coalesce(a.formed_year::text,'') from artists a")}
    by_name: dict[str, set[int]] = collections.defaultdict(set)
    for aid, r in arts.items():
        by_name[n_name(r[1])].add(aid)
    for aid, alias in q("select artist_id, alias from ingest.artist_aliases"):
        by_name[n_name(alias)].add(int(aid))

    pers = q("select p.id,p.name,coalesce(p.real_name,''),coalesce(p.birth_date::text,''),coalesce(p.death_date::text,''),"
             "coalesce(p.is_deceased::text,''),coalesce(p.is_venezuelan::text,''),coalesce(length(p.biography),0),"
             "(select count(*) from track_credits c where c.person_id=p.id)+(select count(*) from album_credits c where c.person_id=p.id) "
             "from persons p")
    pers_by_name: dict[str, list[dict]] = collections.defaultdict(list)
    for r in pers:
        d = {"id": int(r[0]), "nombre": r[1], "nombre_real": r[2] or None, "nacimiento": r[3] or None,
             "muerte": r[4] or None, "fallecido": r[5] or None, "venezolano": r[6] or None,
             "bio": int(r[7]), "creditos": int(r[8])}
        pers_by_name[n_name(r[1])].append(d)
        if r[2]:
            pers_by_name[n_name(r[2])].append(d)

    titulares: dict[int, list[dict]] = collections.defaultdict(list)
    for aid, pid, role in q("select artist_id, person_id, role from artist_members"):
        titulares[int(aid)].append({"persona": int(pid), "rol": role})

    albums: dict[int, list[dict]] = collections.defaultdict(list)
    for r in q("select a.id,a.artist_id,a.title,coalesce(a.release_year::text,''),a.album_type,"
               "(select count(*) from tracks t where t.album_id=a.id),(a.cover_url is not null)::int from albums a"):
        albums[int(r[1])].append({"id": int(r[0]), "titulo": r[2], "anio": int(r[3]) if r[3] else None,
                                  "tipo": r[4], "pistas": int(r[5]), "portada": bool(int(r[6]))})

    # --- identidades
    identidades = []
    for a in artistas_lote:
        nombres = [a["artist_name"], *(a.get("aliases") or [])]
        if a["id"] in IDENTIDAD_MANUAL:
            ids = IDENTIDAD_MANUAL[a["id"]] or []
            metodo = "manual"
        else:
            ids = sorted({i for nm in nombres for i in by_name.get(n_name(nm), set())})
            metodo = "nombre/alias" if ids else "nuevo"
        cand_p = {}
        for nm in [*nombres, *([a["real_name"]] if a.get("real_name") else [])]:
            for p in pers_by_name.get(n_name(nm), []):
                cand_p[p["id"]] = p
        identidades.append({
            "lote_id": a["id"], "nombre": a["artist_name"], "tipo_lote": a["entity_type"],
            "estado": "existe" if ids else "nuevo", "metodo": metodo,
            "artistas": [{"id": i, "nombre": arts[i][1], "tipo": arts[i][2], "bio": int(arts[i][3]),
                          "foto": bool(int(arts[i][4])), "ciudad": arts[i][5] or None, "anio": arts[i][6] or None,
                          "discos": len(albums[i]), "miembros": titulares.get(i, [])} for i in ids],
            "personas_candidatas": sorted(cand_p.values(), key=lambda p: -p["creditos"]),
            "nombre_real": a.get("real_name"), "nacimiento": a.get("birth"), "muerte": a.get("death"),
            "miembros_lote": a.get("members") or [], "obras": len(a.get("selected_works") or []),
            "nacionalidad": a.get("nationality_or_origin"),
        })

    # --- géneros
    taxo = {r[1]: {"id": int(r[0]), "slug": r[1], "nombre": r[2], "nivel": r[3], "familia": r[4] or None}
            for r in q("select g.id,g.slug,g.name,g.level,coalesce(p.slug,'') from ingest.genres g "
                       "left join ingest.genres p on p.id=g.parent_genre_id where g.active")}
    alias = {}
    for al, kind, slug in q("select a.alias_normalized,a.kind,coalesce(g.slug,'') from ingest.genre_aliases a "
                            "left join ingest.genres g on g.id=a.genre_id"):
        alias[al] = (kind, slug or None)
    for slug, g in taxo.items():
        alias.setdefault(n_genre(g["nombre"]), ("genre", slug))
        alias.setdefault(n_genre(slug), ("genre", slug))

    uso = collections.Counter()
    for a in artistas_lote:
        for t in a["subgenres"] + a["genres"]:
            uso[t] += 1
    generos = []
    for termino, veces in sorted(uso.items(), key=lambda kv: (-kv[1], kv[0].lower())):
        k = n_genre(termino)
        if k in alias and alias[k][0] == "genre" and alias[k][1] in taxo:
            generos.append({"termino": termino, "usos": veces, "estado": "exacto", "slug": alias[k][1]})
        elif k in alias and alias[k][0] == "not_a_genre":
            generos.append({"termino": termino, "usos": veces, "estado": "no_genero", "slug": None})
        elif k in PROPUESTA and PROPUESTA[k] in taxo:
            generos.append({"termino": termino, "usos": veces, "estado": "propuesta", "slug": PROPUESTA[k]})
        elif k in NO_GENERO:
            generos.append({"termino": termino, "usos": veces, "estado": "no_genero", "slug": None})
        else:
            generos.append({"termino": termino, "usos": veces, "estado": "nuevo", "slug": None})
    faltan_slugs = sorted({v for v in PROPUESTA.values() if v not in taxo})
    if faltan_slugs:
        print("AVISO: propuestas a slugs inexistentes:", faltan_slugs, file=sys.stderr)

    # --- discos
    ident_by_lote = {i["lote_id"]: i for i in identidades}
    discos = []
    for a in artistas_lote:
        ids = [x["id"] for x in ident_by_lote[a["id"]]["artistas"]]
        propios = [al for i in ids for al in albums[i]]
        titulos = {n_title(al["titulo"]): al for al in propios}
        for r in a["discography"]:
            t = n_title(r["title"])
            estado, match = "falta", None
            if t in titulos:
                estado, match = "existe", titulos[t]
            elif propios:
                best = difflib.get_close_matches(t, list(titulos), 1, 0.8)
                cont = [k for k in titulos if len(t) >= 4 and len(k) >= 4 and (t in k or k in t)]
                for k in [*best, *cont]:
                    cand = titulos[k]
                    # Solo es la misma edición si el año cuadra (±1) o falta en un lado.
                    if r.get("year") is None or cand["anio"] is None or abs(cand["anio"] - r["year"]) <= 1:
                        estado, match = "variante", cand
                        break
            discos.append({
                "lote_id": a["id"], "artista": a["artist_name"], "titulo": r["title"], "anio": r.get("year"),
                "tipo": r.get("type"), "pistas_lote": len(r.get("tracks") or []), "estado_lote": r.get("tracklist_status"),
                "estado": estado if ids else "artista_nuevo",
                "catalogo": match,
            })

    (OUT / "identidades.json").write_text(json.dumps(identidades, ensure_ascii=False, indent=1))
    (OUT / "generos.json").write_text(json.dumps(generos, ensure_ascii=False, indent=1))
    (OUT / "discos.json").write_text(json.dumps(discos, ensure_ascii=False, indent=1))
    (OUT / "correcciones.json").write_text(json.dumps(CORRECCIONES, ensure_ascii=False, indent=1))

    # --- resumen
    ce = collections.Counter(i["estado"] for i in identidades)
    cg = collections.Counter(g["estado"] for g in generos)
    cd = collections.Counter(d["estado"] for d in discos)
    L = ["# Nuevo lote 2026-10-02 — etapa 0", "",
         f"Artistas: {ce['existe']} existen, {ce['nuevo']} nuevos.",
         f"Términos de género: {dict(cg)}.",
         f"Discos del lote: {dict(cd)}.", "",
         "## Artistas nuevos y personas que ya existen con ese nombre", ""]
    for i in identidades:
        if i["estado"] == "nuevo":
            ps = "; ".join(f"P{p['id']} {p['nombre']} ({p['creditos']} créditos)" for p in i["personas_candidatas"]) or "—"
            L.append(f"- **{i['nombre']}** ({i['tipo_lote']}): {ps}")
    L += ["", "## Términos de género sin equivalente (decide Brian)", ""]
    for g in generos:
        if g["estado"] == "nuevo":
            L.append(f"- {g['termino']} ({g['usos']})")
    L += ["", "## Equivalencias propuestas (revisar)", ""]
    for g in generos:
        if g["estado"] == "propuesta":
            L.append(f"- {g['termino']} → `{g['slug']}` ({g['usos']})")
    L += ["", "## Descartados por no ser estilo", ""]
    L.append(", ".join(g["termino"] for g in generos if g["estado"] == "no_genero"))
    L += ["", "## Discos con título variante (revisar antes de la etapa 3)", ""]
    for d in discos:
        if d["estado"] == "variante":
            L.append(f"- {d['artista']}: «{d['titulo']}» ({d['anio']}) ≈ «{d['catalogo']['titulo']}» "
                     f"({d['catalogo']['anio']}, id {d['catalogo']['id']})")
    (OUT / "resumen.md").write_text("\n".join(L) + "\n")
    print(f"identidades {dict(ce)} · géneros {dict(cg)} · discos {dict(cd)} → {OUT}")


if __name__ == "__main__":
    main()
