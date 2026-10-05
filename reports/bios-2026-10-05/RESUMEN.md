# Bios desde las fuentes externas — campaña 2026-10-05

Contexto: la fase «bios» de RYM rindió 5 de 774 artistas (RYM casi no tiene biografías
para ese lote). Esta campaña buscó la biografía en las demás fuentes del proyecto,
siguiendo `docs/curation/BIOGRAFIAS_SINTESIS.md`.

## Cosecha (`scripts/bio-harvest-2026-10-05.sh`, 10 fuentes con caché en data/raw/<fuente>-bio)

13:44 → 16:58 (3 h 14 min), un proceso por fuente + segunda pasada de discogs (1,4 min):

| fuente | resultado |
|---|---|
| discogs | 130,5 min · 649 fichas |
| lastfm | 61,8 min · 1.007 filas |
| lobotoradio | fichas de fichas casadas 2.530; prosa útil solo 6 nuevos |
| theaudiodb | 70,9 min · 5 filas nuevas |
| wikipedia (es+en) | 4.348+ títulos existentes; 12 nuevos |
| venciclopedia | 10.850/36.757 iteradas · 21 nuevos |
| musicbrainz | 565 fichas · 6 con texto |
| rhv | 364 · vzlarockea 545 · sincopa 10.396 filas (local) · rym 5 (volcadas aparte) |

Las segundas pasadas de wikipedia y venciclopedia se abortaron: re-enumeraban su
lista completa de títulos por minutos de ganancia marginal (anotado en estado.txt).

## Cobertura medida

- 1.773 artistas sin bio al empezar → **702 con al menos un texto ≥80** (39,6 %).
- Por fuente (artistas sin bio): sincopa 288 · lastfm 163 · discogs 162 ·
  vzlarockea 64 · rhv 60 · venciclopedia 21 · wikipedia 12 · lobotoradio 6 ·
  rym 5 · theaudiodb 1 · musicbrainz 1.

## Síntesis y aplicación

- 701 expedientes (sin bio + con fuentes) → **700 síntesis escritas** · 33 «sin datos».
  (La primera vuelta gastó ~1,9 M tokens; las re-corridas salieron de la caché
  por prompt de `ingest.ai_runs`.)
- **637 bios aplicadas al catálogo** (runs 16835 + 16836, reversibles desde el diario).
  Catálogo: 2.754 → **3.391 artistas con bio** (sin bio: 1.773 → 1.136).
- Rechazadas 41 (28 demasiado cortas, 10 sin texto, 2 en inglés, 1 nombraba fuente);
  notas para revisión en `notas-para-revision.jsonl` (259).

## Pitfalls corregidos de paso (commit de la campaña)

- El sintetizador no creaba su directorio de salida (`BIO_SYNTH_DIR`): muere con
  ENOENT al escribir la primera ficha. Ahora hace `mkdirSync` (regresión vista hoy).
- Nueva regla anti-sloppiness: prohibido nombrar fuentes («en Last.fm», «según
  Discogs»…) en el texto — en el sintetizador (pide corrección) y en el aplicador
  (rechaza). 15 casos detectados y re-sintetizados.
- El informe del aplicador (`reports/apply-biographies-<fecha>.json`) se sobreescribe
  si rediriges stdout al mismo path: no redirigir ahí.
- Las segundas pasadas de fuentes con iteración completa (wikipedia, venciclopedia)
  cuestan ~25-30 min cada una: solo valen si hay enlaces nuevos que explotar.
