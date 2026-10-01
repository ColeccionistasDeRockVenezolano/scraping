# Backfill de géneros (confirm)

Run 10862 · proyección de `albums.genre`: ENCENDIDA

## Cobertura antes / después

| Métrica | Antes | Después |
|---|---:|---:|
| Álbumes | 4953 | 4953 |
| Álbumes con principal confirmado | 4093 (82.6 %) | 4093 (82.6 %) |
| Álbumes con algún género confirmado | 4098 | 4098 |
| `albums.genre` no nulo | 4093 | 4093 |
| Pendientes (texto de fuente, sin principal) | 0 | 0 |
| Sin clasificar | 860 | 860 |
| Artistas | 2803 | 2803 |
| Artistas con principal confirmado | 2237 | 2387 |
| Artistas con algún género confirmado | 2237 | 2409 |

## Escrituras

Procesados: 776 artistas, 0 álbumes. Filas: +504 / ~75 / −0; evidencia añadida a decisiones humanas: 261. Revisiones abiertas: 260, cerradas: 0.

## Asignaciones por estado y regla (después)

| Nivel | Estado | Decisión | Regla | Filas |
|---|---|---|---|---:|
| album | confirmed | human | human_decision | 2841 |
| album | confirmed | rule | explicit_source_alias | 1155 |
| album | confirmed | rule | partial_source_agreement | 3 |
| album | confirmed | rule | source_list_order | 1661 |
| album | confirmed | rule | sources_agree | 11 |
| album | suggested | rule | external_suggestion | 2 |
| album | suggested | rule | sources_disagree | 7 |
| album | superseded | human | human_decision | 41 |
| album | superseded | rule | explicit_source_alias | 2 |
| album | superseded | rule | external_suggestion | 117 |
| album | superseded | rule | family_superseded_by_child | 56 |
| artist | confirmed | human | human_decision | 2902 |
| artist | confirmed | rule | explicit_source_alias | 245 |
| artist | confirmed | rule | partial_source_agreement | 26 |
| artist | confirmed | rule | source_list_order | 515 |
| artist | confirmed | rule | sources_agree | 42 |
| artist | suggested | rule | sources_disagree | 26 |
| artist | superseded | human | human_decision | 13 |
| artist | superseded | rule | family_superseded_by_child | 26 |

## Casos en revisión (después)

| Nivel | Caso | Abiertos |
|---|---|---:|
| artist | compound_value | 33 |
| artist | human_contradiction | 195 |
| artist | primary_disagreement | 12 |
| artist | source_disagreement | 7 |
| artist | unknown_value | 13 |

## Proyección de `albums.genre`

Cambian 0 álbumes (0 pasan a NULL). Sin evidencia: 0.

| Álbum | Antes | Después | Base |
|---:|---|---|---|

## Tramos sin resolver más frecuentes

| Tramo | Entidades |
|---|---:|
| Slam | 4 |
| Death Metal (later) | 3 |
| Melodic Power Metal | 3 |
| Progressive Heavy Metal | 3 |
| Atmospheric | 2 |
| Atmospheric Death | 2 |
| Black Metal (early) | 2 |
| Death Metal (early) | 2 |
| Experimental Black Metal | 2 |
| Hard Rock (early) | 2 |
| Hardcore (early) | 2 |
| Ambient with Industrial influences | 1 |
| Avant-garde Black | 1 |
| Black Metal (later) | 1 |
| Black Metal with Industrial influences | 1 |
| Depressive | 1 |
| Doom | 1 |
| Doom Metal (later) | 1 |
| Drone | 1 |
| Epic Black Metal | 1 |
| Epic Heavy | 1 |
| Experimental Death | 1 |
| Experimental Grindcore | 1 |
| Gothic Metal (early) | 1 |
| Gothic Metal (later) | 1 |
| Grindcore (early) | 1 |
| Grindcore (later) | 1 |
| Heavy Metal (early) | 1 |
| Heavy Metal (later) | 1 |
| Heavy Metal with Latin influences (later) | 1 |
| Horror Punk | 1 |
| Melodic Death Metal with Rock and Jazz influences | 1 |
| Melodic Heavy Metal | 1 |
| Melodic Progressive | 1 |
| Melodic Thrash Metal | 1 |
| Neoclassical | 1 |
| Power Metal (later) | 1 |
| Power Metal with Folk elements | 1 |
| RAC | 1 |
| Raw | 1 |
| Rock (later) | 1 |
| Shred | 1 |
| Thrash Metal (early) | 1 |
| Thrash Metal (later) | 1 |
