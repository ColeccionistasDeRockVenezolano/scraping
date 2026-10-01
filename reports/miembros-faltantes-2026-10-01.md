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
