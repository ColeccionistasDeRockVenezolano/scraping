# Fichas con integrantes en la bio y sin membresías: análisis (2026-10-01)

Pregunta de Brian: *«hay muchas bandas que tienen los integrantes en la bio y nada en membresía (?tab=miembros)»*.
Lo que sigue se midió sobre la base de desarrollo, después de los runs 10866–10869. Solo se hicieron lecturas.

## Tamaño

| | Fichas |
|---|---|
| Artistas en el catálogo | 2.817 |
| **Sin ninguna membresía** (pestaña Miembros vacía) | **1.953** |
| … con biografía | 1.822 |
| … cuya bio nombra integrantes, por patrones (piso, no techo) | 676 |

El conteo por patrones se queda corto. Detecta «integrada por…», «X (guitarra)» y «X en la batería», pero no formas como «el bajista Francisco» (caso Ruptura).

## Por qué pasa: causas raíz

1. **La síntesis de biografías leyó las alineaciones pero solo escribió prosa.** El 98 % de esas bios son de `crv-sintesis` (1.794 fichas). Sus expedientes traían listas estructuradas de miembros (Lobotoradio, Discogs, MusicBrainz) y párrafos con integrantes (Rock De Vzla, RHV, La Venciclopedia, Last.fm, Wikipedia). La guía (`docs/curation/BIOGRAFIAS_SINTESIS.md`) solo pedía el texto, así que nada de eso se volcó a `artist_members`.
2. **Solo tres caminos crean membresías:**
   - el adaptador de Sincopa (1.295 identidades);
   - la aplicación de Metal Archives (3.100);
   - el operador, que incluye la API web y los aplicadores (3.349).

   Los adaptadores de blogs (`rock-de-vzla`, `rockzuela`, `rhv-blogspot`, `hippito`, `descargas-metal`, `el-punk`, `crv-wordpress`) no extraen integrantes aunque el post traiga una sección «Integrantes:».
3. **Los músicos de cada disco son créditos, no membresías.** La regla de secciones del canal (Musicians / Guest / Other) los guarda en `album_credits`/`track_credits` con tipo `musician`. La ficha del disco los muestra, pero la pestaña Miembros de la banda no los deriva.
4. **Muchos «artistas sin miembros» son solistas.** 2.810 de las 2.817 fichas tienen `artist_type='band'`, así que el tipo no distingue nada. Rudy Márquez, Ilan Chester, Trino Mora y Cecilia Todd están entre los que más discos tienen sin miembros. En el modelo Ashwave, su pestaña debería mostrar a la persona como «Titular del proyecto».

## Qué se puede recuperar (fichas sin miembros, con solapamiento)

| Señal | Fichas | Confianza |
|---|---|---|
| A. Músicos acreditados (`musician`) en sus **propios** discos, sin recopilatorios | 359 (3.000 pares persona–banda; en 259 la bio nombra a esas mismas personas: 1.035 pares) | alta: la persona ya existe |
| B. Lista estructurada ya cosechada (`reports/bio-texts/`: Lobotoradio 103, Discogs 99, MusicBrainz 15) | 167 | alta |
| C. La bio nombra la alineación (patrones; piso) | 676 | media: es texto de IA de segunda mano |
| D. Post de blog de origen con sección de integrantes (Rock De Vzla 168, Rockzuela 57, Hippito 41, RHV 2) | 240 | media-alta: es el texto original |
| Solistas (criterio amplio; 132 ya tienen una persona homónima) | ~224 | alta con la persona homónima |
| **Unión A∪B∪C∪D** | **930** (947 sumando los solistas) | |
| Sin ninguna señal | 1.006 | — |

De las 1.006 sin señal:

- 557 no tienen discos propios y 547 solo aparecen en recopilatorios.
- 129 no tienen bio y 416 tienen una bio corta (menos de 250 caracteres).
- Son bandas de una sola canción en un compilado. Rellenarlas exige fuentes nuevas, no reprocesar las que ya hay.

## Hallazgos de paso

- **Fichas que no son artistas:** «Various Artists», «Sonó Así» y «Venezuela Ska» son series o recopilatorios.
- **Bios de Metal Archives sin traducir y con ruido**, por ejemplo correos de contacto. Casos: Lvctvs, Rotten in Life, Blodmåne. El campo «notas» de MA entró como biografía.
- **`artist_type` casi siempre es `band`.** Hace falta la misma cosecha de tipos que se hizo con los discos.

## Propuesta, en orden de confianza y costo

1. **Solistas:** membresía «Titular del proyecto» para la persona homónima (vía `link_project`). Si la persona no existe, se crea con la bio.
2. **Créditos → membresía:** un `musician` acreditado en los discos propios de la banda pasa a miembro, con `from_year`/`to_year` sacados de los años de esos discos. Los `guest` y los recopilatorios no cuentan. Requiere una regla de Brian, porque cambia el significado de los créditos.
3. **Listas estructuradas ya cosechadas (B):** se aplican directamente. Las personas se casan con la regla de proyecto común; sin ese vínculo, se crean.
4. **Extracción con DeepSeek flash (C+D):** una llamada por ficha sobre los **textos originales** (el post del blog y las fuentes del expediente), no sobre la bio sintetizada. Devuelve `{nombre, rol, años, cita}` y se valida que el nombre aparezca literalmente en la fuente. Lo dudoso va a la cola.
5. **Futuro:** que los adaptadores de blogs extraigan las secciones «Integrantes:», y que la síntesis de bios devuelva también la alineación estructurada.

## Aplicación (2026-10-01, aprobada por Brian: «Apruebo todo»)

Scripts:

- `scripts/export-member-dossiers.mts`: expedientes por ficha sin miembros.
- `scripts/extract-members-deepseek.mts`: DeepSeek flash, una llamada por ficha, con cita literal validada en código.
- `scripts/apply-members.mts`: aplicador por fases.
- Ajustes puntuales en `tmp-analysis/miembros-2026-10-01/`.

Extracción: 1.810 de 1.816 expedientes (6 rechazos de esquema), 2,87 M tokens de entrada y 0,48 M de salida. Clasificación:

| Clase | Fichas |
|---|---|
| Banda | 1.328 |
| Proyecto personal | 158 |
| Solista | 105 |
| Desconocido | 190 |
| No-artista | 37 |

| Run(s) | Qué | Resultado |
|---|---|---|
| 10992–11001 | Fase IA: integrantes con cita, más titulares de solistas y proyectos | 3.976 membresías; 200 titulares (`artist_type`: 87 `solo_artist`, 113 `project`); 2.805 personas nuevas |
| 11003, 11006 | Homónimos nuevos con colegas en común con una ficha previa | 55 fusiones |
| 11007 | Homónimos sin proyecto común → cola `person_duplicate` | 866 revisiones |
| 11008 → 11009 | Primera fase `structured`: duplicaba personas dentro de la misma banda | deshecho |
| 11011 | Listas estructuradas, solo si la IA dijo banda y confirmó a alguien de esa misma lista | 106 membresías, 79 personas |
| 11012–11013 | Créditos `musician` → membresía, con filtro: el texto lo nombra, ≥2 años de discos o ≤7 músicos | 363 membresías; 72 fichas a revisión (`reports/apply-members-credits-review.json`) |
| 11014 | Duplicados dentro de una misma banda (nombre corto/largo, errata) | 12 fusiones |
| 11015 | Bandas homónimas extranjeras coladas (Tarot de Finlandia, Discarga de Brasil) | 10 membresías y 10 personas retiradas |
| 11016 | Titulares con una persona previa de nombre compatible → cola | 9 revisiones |

Resultado: las fichas sin membresía bajan de **1.953 a 885**.

Pendiente:

- La cola `person_duplicate`: unas 875 revisiones nuevas.
- Los 72 artistas con posibles músicos de sesión.
- 190 fichas «desconocido» y 37 «no-artista»: Various Artists, series, orquestas; la OSV fue clasificada como no-artista y no se tocó.
- El reapuntado de créditos de los nuevos titulares (`retarget-titular-credits.ts`, de la sesión del caso Canserbero; dry-run primero).
- El punto 5 del plan: que los adaptadores de blogs y la síntesis de bios devuelvan la alineación estructurada.

### Segunda pasada (2026-10-02)

- **6 fichas que fallaron:** reintentadas; 5 aplicadas en los runs 11273–11277 (Vía de Escape, Bélica como proyecto de Annabella Almenar, Skatz, Vargas).
- **Fallo del extractor:** una corrida con `--ids` reescribía el archivo de salida con solo esas fichas. Está corregido, y el archivo se reconstruyó desde la caché de `ingest.ai_runs` sin coste.
- **Punto 5, hecho como proceso reutilizable:** los adaptadores siguen sin inferir membresías de la prosa, por decisión del proyecto.
  - `scripts/fill-members.sh [--confirm] [--ids=…]` encadena expedientes, extracción, las tres fases, `scripts/members-cleanup.mts --phase=dedupe` y `--phase=homonyms`.
  - Guarda de homónimos en el aplicador: si la nota del modelo descarta una fuente por ser de otra banda, sus integrantes van a `reports/apply-members-foreign-review.json`. Hoy hay 5: Tarot, Discarga, Los Sharks, Nocturnal Avernus y Jasón.
- **Pertinencia (para Brian):** Infestation (Vilnius), Jasón (Argentina) y Nocturnal Avernus (Houston) son fichas de bandas extranjeras; su presencia en el catálogo no se tocó.
