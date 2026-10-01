# Backfill de géneros (confirm)

Run 353 · proyección de `albums.genre`: ENCENDIDA

## Cobertura antes / después

| Métrica | Antes | Después |
|---|---:|---:|
| Álbumes | 4694 | 4694 |
| Álbumes con principal confirmado | 1741 (37.1 %) | 1741 (37.1 %) |
| Álbumes con algún género confirmado | 1805 | 1805 |
| `albums.genre` no nulo | 1950 | 1950 |
| Pendientes (texto de fuente, sin principal) | 209 | 209 |
| Sin clasificar | 2744 | 2744 |
| Artistas | 1982 | 1982 |
| Artistas con principal confirmado | 211 | 211 |
| Artistas con algún género confirmado | 216 | 216 |

## Escrituras

Procesados: 228 artistas, 1950 álbumes. Filas: +0 / ~0 / −0; evidencia añadida a decisiones humanas: 0. Revisiones abiertas: 112, cerradas: 0.

## Asignaciones por estado y regla (después)

| Nivel | Estado | Decisión | Regla | Filas |
|---|---|---|---|---:|
| album | confirmed | rule | explicit_source_alias | 1071 |
| album | confirmed | rule | partial_source_agreement | 1 |
| album | confirmed | rule | source_list_order | 1455 |
| album | confirmed | rule | sources_agree | 12 |
| album | suggested | rule | sources_disagree | 8 |
| album | superseded | rule | family_superseded_by_child | 46 |
| artist | confirmed | rule | explicit_source_alias | 108 |
| artist | confirmed | rule | source_list_order | 223 |
| artist | superseded | rule | family_superseded_by_child | 22 |

## Casos en revisión (después)

| Nivel | Caso | Abiertos |
|---|---|---:|
| album | compound_value | 219 |
| album | primary_disagreement | 1 |
| album | source_disagreement | 3 |
| album | unknown_value | 32 |
| artist | compound_value | 39 |

## Proyección de `albums.genre`

Cambian 1457 álbumes (0 pasan a NULL). Sin evidencia: 0.

| Álbum | Antes | Después | Base |
|---:|---|---|---|
| 7 | Rock-Pop | Pop rock | primary |
| 15 | Pop-Rock | Pop rock | primary |
| 18 | Deathcore/Metalcore | Deathcore | primary |
| 20 | Deathcore/Metalcore | Deathcore | primary |
| 21 | Deathcore/Metalcore | Deathcore | primary |
| 23 | Rock Alternativo | Rock alternativo | primary |
| 24 | Rock Alternativo | Rock alternativo | primary |
| 27 | Heavy / Thrash Metal | Heavy metal | primary |
| 28 | Death Metal | Death metal | primary |
| 29 | Death Metal | Death metal | primary |
| 30 | Thrash Metal/Groove Metal | Thrash metal | primary |
| 31 | Black Metal | Black metal | primary |
| 32 | Heavy/ Power Metal Sinfónico | Heavy metal | primary |
| 33 | Heavy/Thrash Metal | Heavy metal | primary |
| 34 | Death Metal | Death metal | primary |
| 35 | Technical Death Metal | Death metal técnico | primary |
| 36 | Technical Death Metal | Death metal técnico | primary |
| 37 | Hard Rock/Heavy Metal | Hard rock | primary |
| 38 | Hard Rock/Heavy Metal | Hard rock | primary |
| 39 | Black Metal | Black metal | primary |
| 40 | Power Metal/Heavy Metal | Power metal | primary |
| 51 | Rock-Pop | Pop rock | primary |
| 54 | Alternative Rock | Rock alternativo | primary |
| 64 | Hardcore | Hardcore punk | primary |
| 74 | Metal Alternativo/Nü Metal | Metal alternativo | primary |
| 76 | Rock-Pop | Pop rock | primary |
| 80 | Melodic Death Metal | Death metal melódico | primary |
| 103 | Rock-Pop | Pop rock | primary |
| 106 | Jazz/Rock | Jazz | primary |
| 107 | Progressive Rock/Jazz | Rock progresivo | primary |
| 109 | Nu- Metal | Nu metal | primary |
| 110 | Nu- Metal | Nu metal | primary |
| 111 | Nu- Metal | Nu metal | primary |
| 114 | Rock-Pop | Pop rock | primary |
| 115 | Alternative Rock | Rock alternativo | primary |
| 116 | Rock Sinfonico/Progresivo/Jazz | Rock sinfónico | primary |
| 117 | Rock Sinfonico/Progresivo/Jazz | Rock sinfónico | primary |
| 118 | Pop-Rock | Pop rock | primary |
| 119 | Pop-Rock | Pop rock | primary |
| 122 | Alternative Rock/Punk Rock | Rock alternativo | primary |
| 123 | Alternative Rock/Punk Rock | Rock alternativo | primary |
| 127 | Ska-Punk | Ska punk | primary |
| 128 | Pop-Rock/Neo-Glam | Pop rock | primary |
| 130 | Rock-Pop | Pop rock | primary |
| 131 | Alternative Metal | Metal alternativo | primary |
| 132 | Alternative Metal | Metal alternativo | primary |
| 147 | Pop-Rock | Pop rock | primary |
| 148 | Pop-Rock | Pop rock | primary |
| 150 | Rock-Pop | Pop rock | primary |
| 151 | Ska-Core/Reggae | Ska punk | primary |
| 152 | Ska/Reggae/Latin-Rock | Ska | primary |
| 155 | Alternative Rock | Rock alternativo | primary |
| 165 | Rock / Ska | Rock | primary |
| 166 | Rock / Ska | Rock | primary |
| 167 | Rock / Ska | Rock | primary |
| 168 | Rock / Ska | Rock | primary |
| 169 | Rock / Ska | Rock | primary |
| 170 | Rock / Ska | Rock | primary |
| 171 | Rock / Ska | Rock | primary |
| 172 | Rock / Ska | Rock | primary |

## Tramos sin resolver más frecuentes

| Tramo | Entidades |
|---|---:|
| Death | 33 |
| Heavy | 27 |
| Thrash | 24 |
| Black | 18 |
| Hard | 17 |
| Fusion | 10 |
| Female Metal | 8 |
| Progresivo | 8 |
| Progressive | 7 |
| Roll | 7 |
| Thrash-Death Metal | 7 |
| Alternative | 6 |
| Guttural Brutal Death Metal | 6 |
| Instrumental | 6 |
| Noise Raw punk | 6 |
| Stoner | 6 |
| Ethnic-Rock | 5 |
| Rotten Blues | 5 |
| Ska-Reggae | 5 |
| World-Ethnic | 5 |
| Atmospheric | 4 |
| Country | 4 |
| Dark | 4 |
| Depressive Post-Black Metal | 4 |
| Groove | 4 |
| Heavy Rock | 4 |
| Latin Electronic Fusion | 4 |
| Punk-Metal | 4 |
| Dark Metal | 3 |
| Pop-Fusion | 3 |
| Pop-Instrumental | 3 |
| Rock-Ska | 3 |
| Technical Brutal Death Metal | 3 |
| Aggro | 2 |
| Ambient Black Metal | 2 |
| Black... | 2 |
| Blackened | 2 |
| Crossover | 2 |
| Dark Rock | 2 |
| Dark Wave Ilegal | 2 |
| Glam | 2 |
| Latin Funk | 2 |
| Latin Rock Fusion | 2 |
| Melodic Metal | 2 |
| Necronoise | 2 |
| Neo Crust | 2 |
| New Age | 2 |
| Peligroso Pop | 2 |
| Pop-Latin-Rock | 2 |
| Porn | 2 |
