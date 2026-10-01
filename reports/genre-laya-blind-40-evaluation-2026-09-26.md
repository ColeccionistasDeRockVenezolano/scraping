# Evaluación ciega de Laya: 20 álbumes y 20 artistas

Referencia: género principal `confirmed` por reglas del catálogo, con claims aceptados. Estas 40 asignaciones no son decisiones humanas revisadas individualmente. No se repite ninguno de los 49 casos del ensayo retrospectivo anterior.

El archivo de entrada no marca cuál opción es la referencia ni incluye los IDs de los claims que la sustentan. Los slugs aparecen como opciones cuando la evidencia permite extraerlos. La referencia se abrió para puntuar después de ejecutar Laya.

| Nivel | Aciertos | Acierto | Referencia entre opciones | Acierto con opción disponible | Primer candidato |
|---|---:|---:|---:|---:|---:|
| Álbumes | 16/20 | 80.0 % | 20/20 | 16/20 (80.0 %) | 13/20 |
| Artistas | 7/20 | 35.0 % | 8/20 | 7/8 (87.5 %) | 6/20 |
| Total | 23/40 | 57.5 % | 28/40 | 23/28 (82.1 %) | 19/40 |

## Lectura de los resultados

- Los 20 álbumes recibieron como evidencia el claim de género que sustenta la regla de referencia. Por eso, el 80 % de álbumes mide principalmente interpretación de una etiqueta explícita; no demuestra clasificación independiente.
- Los artistas recibieron solo biografías. En 12/20, el género de referencia no apareció entre las opciones extraídas; Laya no podía acertar esos casos. Con la opción presente acertó 7/8.
- El muestreo tomó primero una entidad de cada género disponible para dar variedad; no representa la distribución de los 5.050 pendientes.
- Hubo 0 abstenciones y 8 errores con probabilidad del modelo de al menos 0,90. Las probabilidades todavía no están calibradas para decisiones de CRV.

## Los 40 casos

| Nivel | Caso | Referencia del catálogo | Laya | Probabilidad | ¿Coincide? | ¿Opción disponible? |
|---|---|---|---|---:|---|---|
| Álbum | Pensées d'hier | ambient | black-metal-depresivo | 99.99 % | No | Sí |
| Álbum | B.E.T.O.E/DHK - caminando sobre ruinas. split | anarcopunk | noise | 43.64 % | No | Sí |
| Álbum | En Mis Horas Más Intimas | balada | balada | 70.53 % | Sí | Sí |
| Álbum | Three Ways Of Consciousness | black-metal | black-metal | 99.99 % | Sí | Sí |
| Álbum | Farewell (Summoning Tribute) | black-metal-atmosferico | black-metal-atmosferico | 99.59 % | Sí | Sí |
| Álbum | EP 2020 | black-metal-depresivo | black-metal-depresivo | 99.89 % | Sí | Sí |
| Álbum | Resiliencias | black-metal-sinfonico | black-metal-sinfonico | 63.63 % | Sí | Sí |
| Álbum | Articulando Rastros de Desesperanza - 3way Split con Sosiego / La Traición De Las Masas | blackened-crust | post-punk | 98.48 % | No | Sí |
| Álbum | Dekatherion: Ten Years of Hate & Pride | blackened-death-metal | blackened-death-metal | 100.00 % | Sí | Sí |
| Álbum | Blues Band | blues | blues | 88.60 % | Sí | Sí |
| Álbum | Loho Sessions NYC | blues-rock | blues-rock | 99.93 % | Sí | Sí |
| Álbum | Forced to Suffering | brutal-death-metal | brutal-death-metal | 99.99 % | Sí | Sí |
| Álbum | Inscripciones Abiertas | country | country | 98.66 % | Sí | Sí |
| Álbum | Testimonio de Sangre EP | crossover-thrash | crossover-thrash | 99.71 % | Sí | Sí |
| Álbum | Nadie es el ultimo | crust-punk | crust-punk | 98.90 % | Sí | Sí |
| Álbum | Sexta Repvblica | dark-ambient | dark-ambient | 96.06 % | Sí | Sí |
| Álbum | Menashi Shawa | dark-metal | dark-metal | 99.92 % | Sí | Sí |
| Álbum | Badao EP | death-and-roll | death-and-roll | 99.88 % | Sí | Sí |
| Álbum | Demonical Torment | death-metal | death-metal | 99.99 % | Sí | Sí |
| Álbum | Esquizofrenia | death-metal-melodico | melodic-metal | 77.33 % | No | Sí |
| Artista | Fethuruz | black-metal | black-metal | 99.86 % | Sí | Sí |
| Artista | Electrotribal | dance | electronica | 98.37 % | No | No |
| Artista | Subconsciente? | death-metal | death-metal | 99.90 % | Sí | Sí |
| Artista | Mantra | death-metal-melodico | death-metal | 83.98 % | No | No |
| Artista | Los Amigos Invisibles | funk | dance | 74.28 % | No | No |
| Artista | Dischord | hardcore-punk | hardcore-punk | 96.98 % | Sí | Sí |
| Artista | Landsemk | heavy-metal | hard-rock | 56.52 % | No | Sí |
| Artista | Levítico | heavy-rock | power-metal | 82.13 % | No | No |
| Artista | La Corte | hip-hop | hip-hop | 94.97 % | Sí | Sí |
| Artista | Caseroloops | latin-electronic-fusion | electronica | 47.22 % | No | No |
| Artista | Sexto Sonar | metal-progresivo | rock-progresivo | 87.32 % | No | No |
| Artista | Dame pa Matala | pop-latino | rock | 98.86 % | No | No |
| Artista | Los Paranoias | pop-rock | punk | 53.31 % | No | No |
| Artista | Los Residuos | punk-rock | rock | 99.84 % | No | No |
| Artista | Onice | reggae | reggae | 99.95 % | Sí | Sí |
| Artista | Los Impala | rock | rock | 99.01 % | Sí | Sí |
| Artista | Animas | rock-alternativo | grunge | 97.36 % | No | No |
| Artista | Tomates Fritos | rock-and-roll | rock | 98.12 % | No | No |
| Artista | Bacalao Men | rock-latino | rock | 99.61 % | No | No |
| Artista | Calle Santiago | rock-progresivo | rock-progresivo | 99.01 % | Sí | Sí |

La evaluación no modificó la base de datos, el catálogo ni la radio.
