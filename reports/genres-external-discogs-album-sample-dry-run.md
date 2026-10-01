# Muestra de precisión · géneros de discogs (album)

- Modo: **dry-run** · alcance: `sample` · run 3833
- Fuente: Discogs · licencia Los datos del catálogo son CC0 en los volcados públicos; la API tiene condiciones propias de uso y de atribución. · estado `authorized` · importación habilitada
- Atribución: Datos de Discogs — https://www.discogs.com
- Fichas miradas: **60** · peticiones 0 · caché 227

## Identidad

| Resultado | Fichas |
|---|---:|
| identificadas | 18 |
| dudosas (a revisión) | 9 |
| sin candidato | 32 |

## Acuerdo con CRV

| Comparación | Fichas |
|---|---:|
| coincide con el principal confirmado | 13 |
| coincide en la familia | 4 |
| discrepa | 1 |
| sin nada confirmado que comparar | 0 |

**Precisión sobre lo comparable: 94.4 %** · umbral de CRV: 85.0 %
> La muestra alcanza el umbral: puede habilitarse la carga masiva (`crv genres external bulk-enable`).

## Aporte y ruido

- Sugerencias nuevas: **0** (0 descartadas porque la ficha ya tenía ese género)
- Fichas sin clasificar que reciben al menos una propuesta: **0**

| Ruido | Valores |
|---|---:|
| etiquetas demasiado generales | 11 |
| términos sin equivalencia | 5 |

## Detalle (primeras fichas)

| Ficha | Identidad | Valores externos | Resultado |
|---|---|---|---|
| album 1 · Tarde Pero Temprano | none (0) | — | sin cambios |
| album 7 · Cosas Sencillas | matched (1) | Fusion → unmapped<br>Jazz → proposed (jazz)<br>Latin → proposed (fusion-latina)<br>Pop → proposed (pop) | la fuente propone jazz, fusion-latina, pop frente al principal pop-rock |
| album 11 · Sangre | none (0) | — | sin cambios |
| album 15 · Volver Al Futuro | matched (1) | Pop Rock → already_known (pop-rock)<br>Rock → too_generic (rock)<br>Pop → proposed (pop) | la fuente nombra el principal confirmado (pop-rock) |
| album 18 · The Truth | none (0) | — | sin cambios |
| album 19 · Through The Smoke I've Seen The Truth | none (0) | — | sin cambios |
| album 20 · Hacia Adelante y Abajo | none (0) | — | sin cambios |
| album 21 · Reinventándonos | none (0) | — | sin cambios |
| album 22 · Crónicas Deletéreas I | none (0) | — | sin cambios |
| album 23 · Generador | ambiguous (0.75) | — | sin cambios |
| album 24 · Polvo Lunar | ambiguous (0.75) | — | sin cambios |
| album 25 · Rebirth | none (0) | — | sin cambios |
| album 26 · Chronology of a Downfall | none (0) | — | error: falló GET https://api.discogs.com/artists/151641/releases?per_page=100&sort=year&sort_order=asc: TimeoutError: The operation was aborted due to timeout |
| album 27 · Chapter I Epiphany | none (0) | — | sin cambios |
| album 28 · Human Scum | none (0) | — | sin cambios |
| album 29 · Old Skull | none (0) | — | sin cambios |
| album 30 · Sana Modern Mortis | none (0) | — | sin cambios |
| album 31 · Death Of The Last Sun | ambiguous (0.75) | — | sin cambios |
| album 32 · Vencer o Morir | none (0) | — | sin cambios |
| album 33 · Consigna de Guerra | none (0) | — | sin cambios |
| album 34 · Triumphantly Evil | matched (1) | Death Metal → already_known (death-metal)<br>Rock → too_generic (rock) | la fuente nombra el principal confirmado (death-metal) |
| album 35 · Creation | none (0) | — | sin cambios |
| album 36 · The Collapse Of Singularity | none (0) | — | sin cambios |
| album 37 · Listen To Me | ambiguous (0.6) | — | sin cambios |
| album 38 · Song Of Heroes | ambiguous (0.6) | — | sin cambios |
| album 39 · Despondency Chord Progressions | matched (1) | Black Metal → already_known (black-metal)<br>Rock → too_generic (rock) | la fuente nombra el principal confirmado (black-metal) |
| album 40 · Cantos De Victoria II (Jinetes De Rohan) | ambiguous (0.75) | — | sin cambios |
| album 51 · Spiteri | ambiguous (0.6) | — | sin cambios |
| album 54 · Estoy Afuera Sal | none (0) | — | sin cambios |
| album 57 · Las Paticas De La Abuela | matched (1) | Alternative Rock → proposed (rock-alternativo)<br>Rock → already_known (rock) | la fuente nombra el principal confirmado (rock) |
| album 62 · Acción Es Carácter | none (0) | — | sin cambios |
| album 64 · Mark My Words | none (0) | — | sin cambios |
| album 74 · Nada Es Eterno | ambiguous (0.6) | — | sin cambios |
| album 76 · Not So Commercial | none (0) | — | sin cambios |
| album 80 · Long Way To Oblivion | none (0) | — | sin cambios |
| album 95 · De Día Es Más Oscuro | none (0) | — | sin cambios |
| album 103 · Sólo Dependo De Ti | none (0) | — | sin cambios |
| album 106 · A Través De La Ventana | matched (1) | Fusion → unmapped<br>Prog Rock → proposed (rock-progresivo)<br>Jazz → already_known (jazz)<br>Rock → already_known (rock) | la fuente nombra el principal confirmado (jazz) |
| album 107 · Aditus/2 | matched (1) | Fusion → unmapped<br>Jazz-Funk → unmapped<br>Jazz-Rock → proposed (jazz-rock)<br>Jazz → already_known (jazz)<br>Rock → too_generic (rock)<br>Latin → proposed (fusion-latina)<br>Pop → proposed (pop) | la fuente coincide en la familia del principal confirmado |
| album 109 · Cultura 3 | matched (1) | Nu Metal → already_known (nu-metal)<br>Rock → too_generic (rock) | la fuente nombra el principal confirmado (nu-metal) |

… y 20 fichas más en el JSON.

## Errores

- ficha 26: falló GET https://api.discogs.com/artists/151641/releases?per_page=100&sort=year&sort_order=asc: TimeoutError: The operation was aborted due to timeout

_Dry-run: nada se escribió; repite con `--confirm`._

