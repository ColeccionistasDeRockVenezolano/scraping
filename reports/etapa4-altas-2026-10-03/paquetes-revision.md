# Paquetes de revisión — etapa 4 (para tu confirmación)

Construidos el 2026-10-04 con `scripts/etapa4-altas-2026-10-03/paquetes-revision.py` (solo lectura;
re-ejecutable). Refinados (v2): cada fila lleva **`propuesta`** (veredicto con nota propia) además del
`sugerido` automático; la columna `decision` queda libre para que corrijas lo que quieras.

**Estado: CONFIRMADO y APLICADO (2026-10-04, «OK todo» de Brian).** Se aplicó la columna `propuesta`
de las 385 filas: 40 discos (11 «misma» / 29 «otra»; runs 11766 + 11778) · 9 alias (runs 11786–11794)
· 269 descartes y 59 «sin acción» anotados en `decisiones-2026-10-04.jsonl` (overlay del dossier).
Las **18 filas en `revisar` quedaron parqueadas** (9 de discos + 9 identidades) — sin bloquear.
(Detalle: `lote1-aplicado-resumen.md` y `hallazgos-lote1-appears-on.md`.)

## Paquete 1 · `careo-discos.tsv|.jsonl` — los 49 discos en cola (album_match)

| propuesta | n | qué son |
|---|---|---|
| `misma` | 11 | variantes/typos/subtítulos de la misma obra (7 auto + 4 refinadas: Bruno EP, Dead by Vitriol, Novo color vivo, Psyops Part Two=II) |
| `otra` | 29 | obras distintas del álbum del catálogo (4 auto + 25 refinadas: secuencias/apéndices, singles vs álbumes, compilaciones distintas…) |
| `revisar` | 9 | las 8 dudas reales que van a tu ojo (Juan Peyote aparece 2 veces en cola) |

### Las 8 dudas (para tu ojo)

| disco RYM | vs catálogo | pregunta |
|---|---|---|
| Colorado (2014, EP) — Dolli | «Coloreado» (2016) | ¿typo de título o EP distinto? |
| Soldier of Hell Reborn (2016) | «Soldier of Hell» (2011) | ¿reedición ampliada o secuela? |
| Night and Daydream (1978) — Ananta | «Wheels Of Time / Night And Daydream» (1978) | ¿es una mitad del doble del catálogo? |
| Gorilla Business (En vivo, Recoveco Rec.) (2024) | «Gorilla Business» (2024) | ¿sesión en vivo distinta del single? |
| The Black Album (2000) — Metrozubdivision | «Black» (1999) | ¿mismo? |
| Biofonía II: Voces de la Tierra (2025) — M. Noya | «Biophony / Life Voices» (2023) | ¿secuela distinta o reedición? |
| Tembla (2024) — C4 Trío | «Tiembla / Allá Cayó» (2015) | ¿typo o álbum distinto? |
| Juan Peyote (1997) ×2 filas | «J.P» (1997) | ¿«J.P» es este disco homónimo? |

**Cierre**: veredicto a la Mesa (`same`/`different`) + `applyReviewDecisions` con alcance a estos
reviews (run reversible). `same` adjunta el claim al álbum existente; `different` crea el álbum nuevo.
Sin aplicar, los 49 siguen *open*.

## Paquete 2 · `careo-homonimos.tsv|.jsonl` — 77 pares «¿es la misma ficha?»

| propuesta | n | lectura |
|---|---|---|
| `alias` | 9 | variante ortográfica evidente / disco en común (abajo) |
| `revisar` | 9 | identidad no decidible por forma del nombre → tu ojo |
| `sin_accion` | 59 | distintas con alta confianza (sim <0,93) — se anotan, nada que hacer |

### Los 9 alias propuestos

| RYM (alias) | ficha del catálogo | por qué |
|---|---|---|
| Rafael Mussett | [32223] Rafael Musset | typo (T doble) |
| Carlos Huertas | [27138] Carlos Huerta | plural/singular |
| Fredy Reyna | [2343] Freddy Reyna | typo (D doble) |
| Francisco Tejera | [20054] Francisco M. Tejera | inicial media |
| Neblinna | [1831] Neblina | typo (N doble) |
| Acero Plastiko | [1620] Acero Plastico | K/C + disco en común («ContraSistema») |
| Miguel A. Ferrer | [3348] Miguel Ferrer | inicial media |
| La Banda Casablanca | [1404] La Banda de Casablanca | artículo «de» + disco común («El sueño») |
| Aloisio | [12252] Aloisi | variante ortográfica |

### Las 9 identidades (para tu ojo)

Gustavo Elis vs [36298] Gustavo Celís · Miguel Farías vs [1165] Miguel Arias · Rebelión vs [914]
Rebellion · Mariano Álvarez vs [26500] Mario Alvarez · Jota Rodríguez vs [14271] Joan Rodriguez ·
Raquel González vs [7943] Rael González · Carlitos Flores vs [25703] Carlos Flores · Adriana vs
[25762] Adrián · La Cruz vs [24932] L. Cruz.

**Cierre**: alias confirmados → `createAlias` + run (camino de la web); el resto se anota.

## Paquete 3 · `descartes.tsv|.jsonl` — descartes masivos (269)

- **246** personas «sin evidencia musical» (0 géneros, 0 discos: cineastas, animadores, políticos… del
  barrido de localidades) + **23** fríos sin señales.
- **Cierre**: con tu OK se marcan «descartado (sin alta)» en el dossier; no hay nada que escribir en la
  BD (nunca se crearon).

## Si quieres cambiar algo

Todo cierre va por runs reversibles (`npm run cli -- runs undo <runId> --confirm`). Para corregir una
fila ya aplicada, edita `decision` en el TSV y me avisas; para las 18 parqueadas, dame el veredicto
y las aplico igual.
