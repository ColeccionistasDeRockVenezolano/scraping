# Paquetes de revisión — etapa 4 (para tu confirmación)

Construidos el 2026-10-04 con `scripts/etapa4-altas-2026-10-03/paquetes-revision.py` (solo lectura;
re-ejecutable: `python3 scripts/etapa4-altas-2026-10-03/paquetes-revision.py`). **Nada aplicado a la BD.**

## Paquete 1 · `careo-discos.tsv|.jsonl` — los 49 discos en cola (album_match)

Cada fila: disco RYM (título/año/tipo/pistas) **vs** álbum del catálogo (id/título/año), clase y
**veredicto sugerido**:

| veredicto | n | qué son |
|---|---|---|
| `misma` | 7 | variantes de escritura/typo de la misma obra («Mutant Dubstep Vol. 2»≅«Volume 2») |
| `otra` | 4 | secuencias distintas (Acto I/II, Split 01/02/03, «Nada que perder 2») |
| `revisar` | 38 | pares a ojo (ratio 0,70–0,95; p. ej. «Colorado» vs «Coloreado») |

**Cómo se cierra (tras tu confirmación)**: se registra el veredicto en la Mesa
(`ingest.review_decisions`: `same`/`different`) y se aplica **con alcance a estos 49 reviews**
(`applyReviewDecisions(note, {reviewIds})`, run reversible por el diario). `same` = el claim RYM se
adjunta al álbum existente (sin ficha nueva; puede completar año); `different` = se crea el álbum nuevo.
Sin aplicar nada, los 49 siguen *open* en la cola.

## Paquete 2 · `careo-homonimos.tsv|.jsonl` — 77 pares «¿es la misma ficha?»

| veredicto | n | lectura |
|---|---|---|
| `alias_probable` | 5 | «Gypsy Ska»-style: casi seguro la misma ficha → alias |
| `alias_dudoso` | 13 | sim 0,93–0,97 (ojo: «Miguel Farías» vs «Miguel Arias» NO es prueba) |
| `distinto_probable` | 59 | sim <0,93: casi siempre otra persona/banda → sin acción |

Cada fila trae a los dos lados (nombre/id de la ficha viva, fecha de creación, sim), la evidencia
capturada (formed/born, géneros, discos, «Member of») y, si el lado es artista, cuántos discos
coinciden con los del candidato.

**Cierre**: los `alias_probable` que confirmes → alta de alias (`createAlias` + run, camino de la
web); los `distinto_probable` → nada (se anotan); los dudosos → tu ojo.

**Nota**: eran 79; 2 («GypsySka Orquesta», «North 95») salieron al corregir un bug del cruce
compacto del dossier — ya figuraban en el catálogo con otro espaciado y ahora se reportan
`ya_artista` (bug corregido en `dossier-nuevos.py`; ninguna fila aplicada del lote 1 estaba afectada).

## Paquete 3 · `descartes.tsv|.jsonl` — descartes masivos

- **246** personas «sin evidencia musical» (0 géneros, 0 discos, ficha vacía): cineastas, animadores,
  políticos… del barrido de localidades (Chalbaud, Bendayán, Vigas, de la Cerda…).
- **23** fríos sin ninguna señal (stubs vacíos).
- **Cierre**: con tu OK se marcan «descartado (sin alta)» en el dossier; no hay nada que escribir en
  la BD (nunca se crearon).

## Cómo confirmar

1. **Rápido**: respóndeme por paquete — p. ej. «paquete 1 y 2 como sugerido», «de los homónimos, estos
   cambian: …», «descartes OK».
2. **Con lupa**: edita la columna `decision` de los TSV (valores: `misma`/`otra`/`revisar`,
   `alias`/`distinto`/`revisar`, `descartar`) y me avisas; yo aplico lo confirmado.
