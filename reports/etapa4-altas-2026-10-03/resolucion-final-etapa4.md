# Resolución final de la etapa 4 — «resuelve lo que queda» (2026-10-04, madrugada)

Con el «resuelve lo que queda» de Brian se cerró todo lo pendiente de la etapa 4 que podía
resolverse sin la fase 2 de captura. **El dossier de los 1.591 «nuevos» quedó en 0 pendientes
(1.591/1.591 cubiertos o resueltos)** y los tres paquetes de revisión regeneraron vacíos.

## 1 · Las 18 filas parqueadas — resueltas

### 9 discos (careo `album_match`, run **11818** — 4 «misma» / 5 «diferente»)

| disco RYM | veredicto | por qué (evidencia) |
|---|---|---|
| Night and Daydream (Ananta) | misma → 117 | las 18 pistas capturadas coinciden con el doble del catálogo (incluye la suite Wheel of Time) |
| Juan Peyote (1997) ×2 filas | misma → 2811 | mismo artista/año que «J.P»; RYM no lista un «J.P» aparte |
| The Black Album (2000) | misma → 283 | la página de Metrozubdivision solo lista «The Black Album»; el catálogo lo tenía como «Black» |
| Tembla (2024) | nueva → 15719 | álbum distinto del single en vivo 2015 (Hamilton de Holanda & C4 Trío) |
| Colorado (2014) | nueva → 15716 | «Colorado» y «Coloreado» figuran como lanzamientos separados en RYM |
| Biofonía II: Voces de la Tierra (2025) | nueva → 15715 | álbum separado de «Biophony / Life Voices» (2023) en la página de Noya |
| Soldier of Hell Reborn (2016) | nueva → 15718 | reedición v2 + remixes, distinta del EP original 2011 |
| Gorilla Business (En vivo, Recoveco) | nueva → 15717 | single en vivo distinto del de estudio (RYM lista ambos) |

Las 4 «misma» quedaron con su alias en la ficha del catálogo (Night and Daydream → 117;
Juan Peyote → 2811; The Black Album → 283).

### 9 identidades (careo homónimos) — sin alias (conservador, registradas)

Elis/Celís, Farías/Arias, Rebelión/Rebellion, Mariano/Mario, Jota/Joan, Raquel/Rael,
Carlitos/Carlos, Adriana/Adrián, La Cruz/L. Cruz → **no se crea alias**: la evidencia
(créditos sincopa/metal-archives, eras y perfiles distintos) no confirma que sean la misma
persona/ficha. Registradas en `decisiones-2026-10-04.jsonl` (`sin_accion_confirmado`).

## 2 · Enriquecimiento de las fichas creadas por la Mesa (run **11821**)

Los 34 álbumes creados por decisiones «different» de la Mesa (29 del careo + 5 parqueadas)
habían nacido del claim de título: sus claims hermanos (año) no viajaron. Se afirmó el año
de los 34 con `settleEntityField` (fichas **15686–15719**, p. ej. Split 02, Salsa Brava,
Tembla…). Verificado: 34/34 con `release_year`.

## 3 · Lote 3 — resolución de los 611 del dossier (runs **11824–11834**: 601 creadas)

| bucket | n | resolución | criterio |
|---|---|---|---|
| `revisar_persona_solista` | 369 | artistas **solo_artist** | personas con nacimiento + discografía propia |
| `revisar_tipo` | 124 | artistas (band/solo/project/duo/group) | clasificación de primera pasada por nombre/géneros (tabla `TIPOS_124` en `solicitud-lote3.py`; tipo editable) |
| `revisar_persona` | 108 | personas | miembros de banda sin ancla en catálogo |
| `alta_persona_miembro` | 1 | artista band | «Gustavo Casas y los Que Buscan» (#5777; banda excluida en el lote 1 por la guarda de nombre) |

- Sonda previa: 390 directas · 211 con `allowSimilar` (scores 0,50–0,53: similitud de nombre
  floja, decisión humana de crear) · 1 ya existía → 0 errores.
- Aplicación: 601 creadas + 1 «ya existe» (#6110 «Leo Díaz», sin duplicar) → 0 errores.
- Verificado en la BD: artistas 4.001 → **4.495** (+494) · personas 33.584 → **33.692** (+108);
  muestras: Nelson Morales #5778 solo_artist, Bear Bones Lay Low #6154 solo_artist,
  Camerata Renacentista de Caracas #6243 group, Carlos Giffoni person #40094.

## 4 · Estado final del dossier y lo único que queda

- Dossier regenerado: **ya_persona 378 · ya_artista 756 · ya_ambos 96 · ya_persona_alias 11 ·
  ya_artista_alias 4** (1.245 cubiertos) **+ resueltos por paquete**: descartado 269 ·
  sin_accion_confirmado 68 · alias_confirmado 9 (**346**) = **1.591/1.591 · 0 pendientes**.
- Paquetes (`careo-discos`, `careo-homonimos`, `descartes`) regenerados: **0 filas cada uno**.
- **Lo único que queda de la etapa 4**: los discos de «nuevos» (fase 2 en captura,
  **996/~7.250** a 2026-10-04 01:39, ritmo ~4/min → ETA ~1 día). Al cerrar: re-ejecutar
  `dossier-discos.py` y generar el lote 2 **excluyendo filas `ty=="Appears On"`**
  (ver `hallazgos-lote1-appears-on.md`; el dossier-discos ya trae `tipo_rym`).

## 5 · Deshacer

Todo por runs reversibles (diario 0028): `npm run cli -- runs undo <runId> --note="…" --confirm`.
Runs de esta jornada: **11818** (9 parqueadas) · **11821** (años) · **11824–11834** (lote 3,
601 fichas). Anteriores: 11722–11752 (muestra+lote 1), 11766/11768-94 (careo/alias),
11777/11784 (reparaciones «Appears On»).
