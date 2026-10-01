# Asignación de lotes de síntesis (fase 1: discos, personas, organizaciones)
Lanzados (2026-09-27): organization-001..007; album-001..016; person-001..024.
Pendientes de lanzar: album-017..091; person-025..085.
Artistas: esperan a lastfm, discogs, wikipedia, venciclopedia, theaudiodb, musicbrainz y fase de artistas+discos de lobotoradio.
Fase 2: fichas de disco/persona/organización que reciban fuentes nuevas (--with-sources) → BIO_DOSSIERS_DIR=reports/bio-dossiers-p2, BIO_SYNTH_DIR=reports/bio-synth-p2.
Estado real: `for f in reports/bio-dossiers/*-[0-9]*.jsonl; do python3 scripts/bio-batch-tool.py check $(basename $f .jsonl); done`

## Estado al cortar por límite de uso (2026-09-27)
- organization-001..007: COMPLETOS (64 de 836 con text null por falta de datos).
- album-001..016 y person-001..024: agentes lanzados; verificar con `check` (pueden haber quedado a medias).
- Cosechas en segundo plano (nohup, logs/bio-*.log): lastfm y discogs (ya en paralelo), wikipedia, venciclopedia, musicbrainz, theaudiodb, lobotoradio (por fases). Salidas en reports/bio-texts/.
- Nada aplicado todavía al core: falta `tsx scripts/apply-biographies.ts` (ensayo) y `--confirm`.

## Ola 2 (tras el reinicio del límite)
Lanzados: album 002-008, 012-020 (013/015 a medias); person 001-004, 006-008, 010-012, 014-016, 018-029.
Pendientes: album 021-091; person 030-085; artistas (tras cosechas).
Nota: bio-batch-tool.py ahora divide solo en "\n" (splitlines rompía en U+2028) y tiene `missing`.
Lanzado: album 021-023. Completos confirmados: album 005, 006, 015.
Lanzado: album 024-026. Completos confirmados: album 002, 003, 004, 013 (notas: album:42, album:43).
Lanzado: person 030-034. Completos confirmados: person 007, 008, 010, 011, 012.
Lanzado: person 035-039. Completos confirmados: person 025-029.
Lanzado: person 040-044. Completos confirmados: person 014-016, 018, 019. Corrección aplicada a salidas de personas: «es compositor de X» → «compuso temas grabados por X» (82).
Lanzado: album 027-029. Completos confirmados: album 007, 008, 012 (notas de año en varios; album:285 ciudad Caracas/Valencia).

## Aplicado (2026-09-28, run 10429)
Lotes completos aplicados con `apply-biographies.ts --only=…`: album-001, album-002, album-003, album-004, album-005, album-006, album-007, album-008, album-009, album-010, album-011, album-012, album-013, album-014, album-015, album-016, album-018, album-019, album-020, album-021, album-022, organization-001, organization-002, organization-003, organization-004, organization-005, organization-006, organization-007, person-001, person-002, person-005, person-007, person-008, person-009, person-010, person-011, person-012, person-013, person-014, person-015, person-016, person-017, person-018, person-019, person-020, person-021, person-022, person-025, person-026, person-027, person-028, person-029.
Resultado: 4.048 textos (490 discos, 2.863 personas, 695 organizaciones); 64 «sin datos»; 95 rechazados por validación (82 demasiado cortos, 7 hablan del expediente, 6 no parecen en español) — detalle en reports/apply-biographies-2026-09-28.json.
Pendientes: album-017 y album-023..091, person-003/004/006/023/024 y 030..085, artist-001..050 (a medio escribir o sin lanzar). Volver a aplicar todo es seguro: lo ya aplicado sale como «changedSinceExport» y no se reescribe.
Ojo: 32 páginas de Last.fm son de homónimos (lista en scripts/genre-source-skip.ts, 2026-09-28). Cruzado con los expedientes de artistas: solo artist:2726 (Trujillo, ref s2 en artist-031) lleva texto de lastfm de un homónimo; descartarlo al sintetizar.

## Ola 3 (2026-09-28, sesión de reanudación; NO relanzar estos lotes desde otra sesión)
- Expedientes de artistas regenerados tras todas las cosechas (lobotoradio, discogs, musicbrainz, venciclopedia, lastfm): 67 lotes (antes 50; los viejos en reports/bio-dossiers-artist-old-2026-09-27/, no tenían ninguna línea escrita).
- El exportador ahora respeta los vetos de scripts/genre-source-skip.ts (homónimos de Last.fm, MusicBrainz, Wikipedia).
- Expedientes pendientes de discos y personas refrescados en su sitio (2.674 líneas, mismo orden; copia previa en reports/bio-dossiers-ap-before-refresh-2026-09-28/).
- Lanzados todos los lotes pendientes (198) en 80 subagentes Sonnet 5, por olas.
- CANCELADA a pedido de Brian (consumen mucho): se detuvieron los 16 subagentes lanzados; solo alcanzaron album-030 (+10) y person-003 (+20). Quedan 198 lotes (≈13.690 fichas) sin lanzar. No relanzar subagentes sin que Brian lo pida.

## Ola 4 (2026-09-28): DeepSeek flash, una llamada por ficha
- Script: `scripts/synth-biographies-deepseek.ts --kinds=artist,album,person --concurrency=20` (log en logs/bio-deepseek-2026-09-28.{log,json}). Cada salida lleva `model: deepseek-flash`; cada llamada queda en ingest.ai_runs (task_kind biography).
- Piloto de 30 (album-025, artist-001, person-031): ~3.000 tokens de entrada y ~250 de salida por ficha; 40 % de la entrada en caché.
- Control automático con un reintento: persona llamada «venezolana» sin respaldo; reseña con más de 4 títulos entre comillas.
- Reanudable: volver a correr el mismo comando salta lo ya escrito.
- TERMINADA (2026-09-28 13:40): 13.663 fichas sintetizadas (32,5 M tokens de entrada, ~75 % en caché; 1,9 M de salida; 1.497 reintentos por el control). Falta solo artist:1387 (cita refs inexistentes).
- 106 salidas llevaban `current` sin biografía previa: se quitó esa etiqueta (el texto no cambia).
- Aplicado en el run 10442: 12.751 textos (1.976 artistas, 4.049 discos, 6.726 personas; 994 enriquecen una biografía previa); 421 rechazados por validación, 1.045 «sin datos», 48 con años del texto anterior no repetidos (informe). Ojo: reports/apply-biographies-2026-09-28.json ahora es el de este run; el del 10429 se sobrescribió.
- Cobertura: artistas 1.985/2.620, discos 4.539/4.618, personas 9.589/10.198, organizaciones 695/836.
- Revisión de años (2026-09-28): 48 textos con años ausentes del expediente; resintetizados con control de años (añadido al script). 20 cambiaron y se aplicaron en el run 10444 sobre el texto del 10442 (expedientes y salidas en reports/bio-synth-fix-years-2026-09-28/). Informes: reports/apply-biographies-run10442-2026-09-28.json y reports/apply-biographies-run10444-años-2026-09-28.json.
