#!/usr/bin/env python3
"""Etapa 4 «Altas» — solicitud del lote 3: resuelve los buckets de revisión del dossier.

Convierte las filas «revisar_persona_solista», «revisar_tipo», «revisar_persona» y
«alta_persona_miembro» del dossier-nuevos en casos para plan-altas.py:

  * revisar_persona_solista (personas con nacimiento + discografía) → artista solo_artist
  * revisar_tipo (acto musical sin señal) → artista con tipo de la clasificación de
    primera pasada TIPOS_124 (nombre + géneros/lanzamientos; editable a posteriori)
  * revisar_persona (miembro de banda sin ancla) → persona
  * alta_persona_miembro → artista band (el excluido por guarda en el lote 1)

SOLO LECTURA. Uso: python3 scripts/etapa4-altas-2026-10-03/solicitud-lote3.py
"""
import json

ROOT = "/home/brian/apps/Coleccionistas De Rock Venezolano"
OUTDIR = f"{ROOT}/reports/etapa4-altas-2026-10-03"

# Clasificación de primera pasada de los 124 «indeterminado» (revisión del asistente,
# 2026-10-04): nombres de persona → solo_artist; actos/alias de grupo → band; casos
# especiales → duo/project/group. El tipo es editable después (updateArtist vía web).
TIPOS_124 = {
    "NOHAYCIELOS": "solo_artist", "Lienzos": "band", "Osha Big Humo": "solo_artist",
    "rip_sakura": "solo_artist", "sunn": "solo_artist", "Anguera": "solo_artist",
    "Sofía Shizuko": "solo_artist", "lexestasolo": "solo_artist", "Bear Bones, Lay Low": "solo_artist",
    "El $abor": "solo_artist", "BABYBLEID": "solo_artist", "Flautas del chigüire": "band",
    "Cinema Doom": "band", "Charlie Carr": "solo_artist", "Alleh": "solo_artist",
    "Contra Marcha Punk HxC": "band", "Joux": "solo_artist", "Zarinovak": "solo_artist",
    "VeryCherrii": "solo_artist", "Luis Miguel Mussett": "solo_artist", "Species Infected": "band",
    "Hello Mr. Klaus": "band", "Young Denky": "solo_artist", "0xtkk": "solo_artist",
    "Darkohm": "band", "AG SixTeen": "solo_artist", "King Stephen": "solo_artist",
    "Sir Di Alex": "solo_artist", "The Madman Alex": "solo_artist", "Subliminal Terry": "solo_artist",
    "Maxplay": "solo_artist", "Vincent Nuit": "solo_artist", "Nina Romero": "solo_artist",
    "Cherlatte": "solo_artist", "Carlitos Calebra": "solo_artist", "AGU!": "solo_artist",
    "Lolita De Sola": "solo_artist", "Tayko": "solo_artist", "Nebula Karbenogg": "band",
    "Lyfer": "solo_artist", "Noixes": "solo_artist", "Rapisarda": "solo_artist",
    "Kelly Abarca": "solo_artist", "revenue": "solo_artist", "Sunset 1986": "band",
    "Daylens & George": "duo", "Blure": "band", "Washé": "solo_artist",
    "Lalter": "solo_artist", "VulKan": "band", "Helios Martinez Dominguez": "solo_artist",
    "Belfort": "band", "Ipostal": "band", "Joanna Karamazov": "solo_artist",
    "Doktor Rheal": "solo_artist", "Oscarcito": "solo_artist", "Putaliscious": "solo_artist",
    "Yua Bits": "solo_artist", "Voyager": "band", "jorge andrés": "solo_artist",
    "Andy Alent": "solo_artist", "RoyalLive": "band", "El Mago": "solo_artist",
    "memory twin": "band", "Pico Mifés": "band", "Elvis Trofia": "solo_artist",
    "Skisia2": "solo_artist", "Otrebor": "solo_artist", "Pedro el Colita": "solo_artist",
    "Junior Caldera": "solo_artist", "DJ Rosmel": "solo_artist", "Byakko": "solo_artist",
    "3m5": "solo_artist", "DJ SUELDOminimo": "solo_artist", "Las Lineas de Nazca": "band",
    "juanrutina": "solo_artist", "Oreste": "solo_artist", "Kid Problema": "solo_artist",
    "Sabita Seinshin": "solo_artist", "THEALBERTOZ": "solo_artist", "Vir Martialis": "solo_artist",
    "Antidolby": "band", "Boikido": "band", "Jemimemu": "solo_artist",
    "Yvng Tavo": "solo_artist", "La Serpiente Solar": "band", "Mariafer": "solo_artist",
    "The Back Room": "band", "postales de amaranta": "band", "Okubo": "solo_artist",
    "T Izzy": "solo_artist", "Joss": "solo_artist", "Kandido": "solo_artist",
    "Jeon": "solo_artist", "The Isle Project": "project", "Esmeralda": "solo_artist",
    "Amy Sorinio": "solo_artist", "Camerata Renacentista de Caracas": "group", "Cinema Gore": "band",
    "Velesa": "solo_artist", "L A T": "band", "HXIST": "band",
    "Three Corners": "band", "Sikozis": "band", "J.P.M.R": "band",
    "Matter": "band", "high drizzy": "solo_artist", "Witchkings of Angmar": "band",
    "Ancestral Warchants": "band", "Jessie24": "solo_artist", "Villa": "solo_artist",
    "Diego Barrios": "solo_artist", "Segunda mano": "band", "Carrizal": "band",
    "Leddy Manzano": "solo_artist", "Dibo D": "solo_artist", "Scäper": "solo_artist",
    "Gabio": "solo_artist", "Johnny Sunrise": "solo_artist", "pm": "solo_artist",
    "Anarcoguarachero": "band", "La Comunidad Internacional": "band", "Söuthkhänd": "band",
    "Marcelo Beroy": "solo_artist",
}
assert len(TIPOS_124) == 124, f"TIPOS_124 tiene {len(TIPOS_124)} entradas (esperadas 124)"

filas = [json.loads(l) for l in open(f"{OUTDIR}/dossier-nuevos.jsonl", encoding="utf-8")]
casos, sin_mapa = [], []

for r in filas:
    accion = r["accion_sugerida"]
    caso = None
    if accion == "revisar_persona_solista":
        caso = {"tipo": "artist", "artist_type": "solo_artist", "rym_href": r["rym_href"],
                "motivo": f"lote 3: persona con nacimiento y discografía propia ({r['ev_n_discos']} lanzamientos, {r['ev_n_gen']} géneros) → solo_artist"}
    elif accion == "revisar_tipo":
        tipo = TIPOS_124.get(r["rym_name"])
        if not tipo:
            sin_mapa.append(r["rym_name"])
            continue
        caso = {"tipo": "artist", "artist_type": tipo, "rym_href": r["rym_href"],
                "motivo": f"lote 3: clasificación de primera pasada ({tipo}) sobre {r['ev_n_discos']} lanzamientos"}
    elif accion == "revisar_persona":
        caso = {"tipo": "person", "rym_href": r["rym_href"],
                "motivo": f"lote 3: persona miembro de banda ({'; '.join(r['miembro_de'][:3])})"}
    elif accion == "alta_persona_miembro":
        caso = {"tipo": "artist", "artist_type": "band", "rym_href": r["rym_href"],
                "motivo": "lote 3: banda con nombre tipo persona (excluida por guarda en el lote 1)"}
    if caso:
        casos.append(caso)

solicitud = {
    "nota": "Lote 3 etapa 4 «Altas» — resolución de los buckets de revisión del dossier (soloistas, tipos, personas-miembro). Veredictos asistidos 2026-10-04; crear con OK de Brian.",
    "casos": casos,
}
with open(f"{OUTDIR}/solicitud-lote3.json", "w", encoding="utf-8") as fh:
    json.dump(solicitud, fh, ensure_ascii=False, indent=1)

from collections import Counter
print(f"casos: {len(casos)} ·", dict(Counter((c['tipo'], c.get('artist_type', '')) for c in casos)))
if sin_mapa:
    print("SIN MAPA en revisar_tipo:", sin_mapa)
print("escrito:", f"{OUTDIR}/solicitud-lote3.json")
