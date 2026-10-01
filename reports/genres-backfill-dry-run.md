# Backfill de géneros (dry-run)

Run 5973 · proyección de `albums.genre`: ENCENDIDA

## Cobertura antes / después

| Métrica | Antes | Después |
|---|---:|---:|
| Álbumes | 4654 | 4654 |
| Álbumes con principal confirmado | 1745 (37.5 %) | 1745 (37.5 %) |
| Álbumes con algún género confirmado | 1805 | 1805 |
| `albums.genre` no nulo | 1950 | 1950 |
| Pendientes (texto de fuente, sin principal) | 205 | 205 |
| Sin clasificar | 2704 | 2704 |
| Artistas | 2658 | 2658 |
| Artistas con principal confirmado | 211 | 211 |
| Artistas con algún género confirmado | 216 | 216 |

## Escrituras

Procesados: 228 artistas, 1994 álbumes. Filas: +0 / ~0 / −0; evidencia añadida a decisiones humanas: 0. Revisiones abiertas: 0, cerradas: 0.

## Asignaciones por estado y regla (después)

| Nivel | Estado | Decisión | Regla | Filas |
|---|---|---|---|---:|
| album | confirmed | human | human_decision | 8 |
| album | confirmed | rule | explicit_source_alias | 1071 |
| album | confirmed | rule | partial_source_agreement | 1 |
| album | confirmed | rule | source_list_order | 1451 |
| album | confirmed | rule | sources_agree | 12 |
| album | suggested | rule | external_suggestion | 127 |
| album | suggested | rule | sources_disagree | 8 |
| album | superseded | rule | family_superseded_by_child | 46 |
| artist | confirmed | rule | explicit_source_alias | 108 |
| artist | confirmed | rule | source_list_order | 223 |
| artist | superseded | rule | family_superseded_by_child | 22 |

## Casos en revisión (después)

| Nivel | Caso | Abiertos |
|---|---|---:|
| album | compound_value | 215 |
| album | external_ambiguous_identity | 5 |
| album | external_unmapped_term | 11 |
| album | primary_disagreement | 1 |
| album | source_disagreement | 3 |
| album | unknown_value | 32 |
| artist | compound_value | 39 |
| artist | external_ambiguous_identity | 28 |

## Proyección de `albums.genre`

Cambian 0 álbumes (0 pasan a NULL). Sin evidencia: 43.

| Álbum | Antes | Después | Base |
|---:|---|---|---|

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
| Postpunk Paranormal | 2 |
