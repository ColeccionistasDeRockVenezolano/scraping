# CRV — Fuentes autorizadas

> Normativo. La lista de fuentes es un conjunto **cerrado**: las 11 fuentes de
> `Links for Data Scrapping.xlsx` + YouTube Data API + los dos archivos XLSX
> como seeds internos. **Ninguna fuente nueva se añade sin aprobación manual
> del usuario** (proceso en §6).

**Fecha de verificación general: 2026-09-07; revalidación de Rock Hecho En
Venezuela, Deska y Hemeroteka: 2026-09-08.** Todos los datos de "sonda" fueron
obtenidos con peticiones GET de solo lectura
(homepage + `robots.txt` + endpoints públicos de feed/API), con
User-Agent identificable, 1 petición a la vez y pausa entre peticiones.
Lo confirmado se marca **[CONFIRMADO]**; lo no verificado se marca
**[POR CONFIRMAR]** y no se asume. No se ha añadido ninguna fuente nueva.

---

## 1. Política general de fuentes

1. Solo fuentes registradas en `ingest.sources` con `enabled=true` pueden ser
   scrapeadas. El alta de una fuente nueva pasa por la cola de revisión y
   requiere aprobación manual (§6).
2. Las fuentes se almacenan internamente (tabla `ingest.sources`). Su
   exposición pública no es requisito (`public_display=false` por defecto).
3. Dos modos de captura (decisión de gobierno):
   - **Scraping masivo por fuente** (`scrape <slug>`): barrido completo
     dentro del dominio autorizado.
   - **Enriquecimiento dirigido por artista** (`enrich <artist>`): búsqueda
     puntual de un artista en las fuentes relevantes.
4. Cortesía: respetar `robots.txt`, 1 petición concurrente por dominio,
   mínimo 1 s entre peticiones, User-Agent identificable.
5. YouTube es fuente de primera clase pero con reglas propias (§2): solo
   YouTube Data API, nunca scraping visual de la página de búsqueda.
6. **Preferencia de acceso:** cuando una fuente expone datos estructurados
   (feed Atom/JSON, API REST), el adapter usa ese canal **antes** que el
   HTML renderizado. El HTML crudo se conserva igual como evidencia.

### Niveles iniciales de confianza

| Nivel | Significado | Aplica a |
|---|---|---|
| `high` | Curado por el propietario del proyecto; se importa automáticamente | Seeds XLSX (YT Master, Links) |
| `medium` | Editorial establecido, con estructura de datos propia | Sincopa, Coleccionistas (WordPress), El Punk En Venezuela, Rock Hecho En Venezuela |
| `low` | Colaborativo/fan sin verificación editorial; claims quedan en revisión | Blogspots de descargas, Instagram |
| `api` | Datos estructurados de plataforma | YouTube Data API (título, fecha, duración, disponibilidad) |

El nivel es el punto de partida de cada claim; puede subirse campo a campo
por corroboración (dos fuentes independientes `medium`+ concordantes → `high`
para ese campo). Ningún nivel de confianza permite saltarse la evidencia.

---

## 2. YouTube — fuente de primera clase

- **Mecanismo:** YouTube Data API v3. `videos.list(part=snippet,
  contentDetails,status)` sobre los **IDs ya conocidos** (520 extraídos del
  seed, todos distintos). `search.list` opcional, acotado y bajo cuota, solo
  en el modo de enriquecimiento dirigido por artista.
- **Prohibido:** scraping visual/HTML de youtube.com (búsqueda, watch, etc.).
- **Seed:** `YT Master Spreadsheet.xlsx` es el seed inicial del catálogo
  audiovisual (606 filas; detalles y anomalías en DATA_MODEL.md §5).
- **Regla de gobierno:** videos de tipo Music Video, Live Concert o
  Documentary **no crean álbumes**. Se registran en `media.youtube_videos` y
  solo pueden *vincularse* a un álbum existente vía `media.video_albums`.
- **Disponibilidad:** el campo `status` de la API alimenta claims que
  proyectan `albums.youtube_status` (enum `publication_status` del core). El
  `Status` del seed **no** sirve para eso: de sus 87 filas marcadas
  `Unlisted`, 86 no tienen URL ni `video_id` (son exactamente las 86 de
  `missing_url` de F2), así que no hay video del cual afirmar disponibilidad.
  La única marcada `Unlisted` **con** video es `QcnD-UIl0N8` (Zapato 3,
  *Detrás De La Puerta*) — medido el 2026-09-08.
- **Cuotas:** la API tiene cuota diaria por clave; `videos.list` acepta hasta
  50 IDs por llamada, de modo que los 520 IDs conocidos se cubren en ~11
  llamadas. La respuesta cruda se cachea en `media.youtube_videos.metadata`.
  El barrido de descubrimiento del canal (`channels.list` + 13 páginas de
  `playlistItems.list`) costó **14 unidades** de las 10.000 diarias: la cuota
  no es el factor limitante de esta fuente.
- **Canal:** `UCtYlrz6GyvRahlhHjocWQYQ` — *Coleccionistas De Rock
  Venezolano*, abierto el 2015-11-20, playlist de uploads
  `UUtYlrz6GyvRahlhHjocWQYQ`. Declara 648 videos públicos; el barrido del
  playlist ve 646 (§2.1).
- **Disponibilidad real (resuelto el 2026-09-08, paso 2).** De los 648 IDs de
  la unión, `videos.list` devolvió 646, **todos `public`**. No hay un solo
  video no listado en el canal, así que el `Status` de la hoja no describe
  ningún estado real de YouTube. Los 2 que no volvieron —`QcnD-UIl0N8` y
  `nUNxlo6cTbc`— están borrados o en privado: `videos.list` por ID sí
  devuelve los no listados, de modo que su ausencia por las dos vías es
  concluyente. Quedan anotados en `ingest.scrape_errors`.

### 2.1 Lo que el canal tiene y la hoja no (medido el 2026-09-08)

El barrido de descubrimiento (`crv youtube discover-channel`, runs 85 y 86,
idempotente: la segunda pasada insertó 0 filas) deja esta partición entre los
646 videos del playlist de uploads y los 520 `video_id` distintos del seed:

| Conjunto | Videos |
|---|---|
| En el canal y en la hoja | 518 |
| **En el canal, ausentes de la hoja** | **128** |
| En la hoja, ausentes del canal | 2 |

La hoja **no es un superconjunto del canal**, que era el supuesto implícito
al llamarla "discografía curada". De los 128 que faltan, 115 llevan el
marcador `|| Full Album ||` en el título — discos, no material accesorio — y
no son solo subidas recientes: 74 se publicaron entre 2016 y 2019. Los otros
13 son 10 piezas editoriales (`#repost`, entrevistas, reseñas) y 3 sin
clasificar por título.

Los 2 ausentes del canal son `QcnD-UIl0N8` (marcado `Unlisted` en la hoja) y
`nUNxlo6cTbc` (*Various Artists — Tributo a CDC: Harakiri City*, sin marca).
El paso 2 los interrogó por ID y `videos.list` tampoco los devolvió: no están
"no listados", están borrados o en privado. Sobre la hipótesis de que el
playlist de uploads oculte los no listados no hay evidencia ni en contra ni a
favor, porque en el canal no quedó ningún video no listado con el cual
probarla.

### 2.2 La descripción es la fuente, no el metadato (medido el 2026-09-08)

`playlistItems.list` devuelve la descripción **completa**, no un resumen:
contrastada contra la que dio `videos.list` para `Q-pRpO2sYSI`, 599
caracteres contra 599, byte a byte. El descubrimiento del paso 1, entonces,
ya dejó en disco las **636 descripciones no vacías** de los 646 videos. El
parser se calibró contra ese corpus, no contra suposiciones.

El vocabulario real de encabezados es corto y estable:

| Encabezado | Descripciones | Sección |
|---|---|---|
| Other Credits | 634 | `other_credits` |
| Musicians | 622 | `musicians` |
| Tracklist / Timestamps / Tracks | 634 | `tracklist` |
| Guest Musicians | 374 | `guest_musicians` |
| Bonus Track(s) | 94 | `bonus_tracks` |
| Artwork · Illustration · Photography | 27 · 7 · 2 | idem |

Dos correcciones que el corpus impuso sobre el parser anterior:

1. **`Guest Musicians` no estaba** y aparece en 374 descripciones — más de la
   mitad del canal. Es además donde vive la atribución por pista
   ("Acoustic Guitar: Reynaldo Goitia (track 10)").
2. **Los nombres de crédito no son encabezados.** `Produced by`,
   `Recorded by`, `Mixed by`, `Mastered by`, `Written by` figuraban en
   `SECTION_NAMES` con anclas `^…$` que no podían casar con nada: en el canal
   son líneas sueltas dentro de Other Credits, y con el verbo a menudo
   compuesto ("Recorded & Mixed by Boris Milan, August 1992"). Se reconocen
   ahora por forma de línea, no por sección.

Lo que **no** se ascendió a sección, deliberadamente: `Guitars`, `Bass`,
`Backing Vocals` y demás roles. Aparecen a comienzo de línea con frecuencia
(58, 31, 29…) pero son roles *dentro* de un bloque de músicos; tratarlos como
secciones partiría el bloque y perdería a quién pertenece cada instrumento.

Cobertura resultante sobre el corpus completo: **636/636** descripciones no
vacías con tracklist reconocida — 6.769 pistas con marca de tiempo y 1.633
créditos en línea. Las pistas de `Bonus Tracks` cuentan como pistas: comparten
numeración y reloj con el tracklist principal, y la distinción se conserva en
`media.youtube_description_sections`.

Materializado por el paso 2 y corregido por el paso 3:
`media.youtube_tracklist_entries` tiene **6.792 filas** y
`media.youtube_description_sections` **2.396**. La primera hidratación dio
6.769 y 2.394 —exactamente lo que la derivación local había anticipado sobre
el corpus— y la re-derivación sumó 23 pistas al cubrir `Trackslist`, una
errata con ese de más que aparece en dos videos (§2.4).

Cobertura de línea sobre el corpus: **99,7%** de las 23.371 líneas no vacías
cae dentro de alguna sección reconocida.

### 2.4 Re-derivar sin red (paso 3)

`crv youtube rederive [--dry-run]` vuelve a parsear las descripciones **ya
guardadas** en `media.youtube_videos.metadata` y reescribe secciones y
pistas. No toca la red: el parser se puede iterar cuantas veces haga falta
sin gastar una unidad de cuota, que era el motivo de separar *hidratar* de
*derivar*. Cada video se re-deriva en su propio `SAVEPOINT`, así que uno que
falle se anota en `ingest.scrape_errors` sin arrastrar al lote, y `--dry-run`
calcula el delta y lo deshace.

Hidratación y re-derivación comparten un único camino de código
(`persistDerivedDescription`), de modo que no pueden divergir.

Primera ejecución útil: la medición de líneas huérfanas destapó `Trackslist:`
en `9eEUpRt1n-E` (Andreazulado) y `J65Ep1xwcn0` (Tomates Fritos), donde el
encabezado no casaba y solo sobrevivía la pista del bloque `Bonus Track`. El
dry-run anticipó `6.769 -> 6.792 (+23)` en esos dos videos y la ejecución
real dio exactamente eso; una segunda pasada, 0 cambios.

### 2.3 El título también es un registro

De los 646 títulos del canal: **616 llevan el año** entre paréntesis, 631 el
separador ` - `, 595 el marcador `|| Full Album ||` y 77 una etiqueta de
formato — 44 `[EP]`, 32 `[Single]`, 1 `[u(n)clear]`. `parseYouTubeTitle`
extrae los cuatro. El año que sale de ahí es una afirmación **independiente**
del `Album Year` de la hoja: cuando discrepen, el conflicto se registra
conservando ambas, como el caso `Metrozubdivision / CCS`.

### 2.5 El canal como fuente de claims (paso 4)

`crv youtube api-claims [--dry-run]` mete lo derivado por la puerta normal
—adapter → normalización → claims → ER → merge—, igual que `seed-claims`
hace con la hoja. No abre ninguna vía nueva al core.

**Qué cuenta como publicación.** Solo los videos con `|| Full Album ||` en el
título producen álbum. La regla está contrastada contra la clasificación de
la hoja y las dos nunca se contradicen: de los 596 marcados, la hoja llama
`release` a 425 y `review` a 56, y **`media` a ninguno**; de los 50 sin
marcar, 32 son `media` para la hoja. Videoclip, concierto y documental
siguen sin crear disco.

**Qué sale.** 646 videos → 596 discos, 35 audiovisuales sin disco y 15 sin
identidad (documentales y entrevistas cuyo título usa `:` en vez de ` - `):

| Registro | Cantidad |
|---|---|
| Pistas | 6.531 |
| Créditos de disco | 7.762 |
| Personas | 3.840 |
| Créditos acotados a pista | 1.458 |
| Discos | 596 |
| Organizaciones (estudios) | 408 |
| Artistas | 268 |

**Todo sale como candidato** (`confidence: low`), igual que el seed. El canal
es del propio proyecto y su `trust_level` es `api`, pero quien lo lee aquí es
un programa: la decisión humana se expresa después, con
`review approve-batch --source=youtube-data-api`.

**Lo que se descarta a propósito.** Un valor con año, punto y coma o salvedad
no se convierte en nombre: "Produced by X, except; Track 12 by Y" nombraría a
alguien que no existe. Un dígito, en cambio, **no** descalifica —"Zapato 3" y
"Candy66" son bandas del catálogo—. De los 1.633 créditos por verbo, 1.536
dan nombre y 713 además un estudio; 40 se descartan por ambiguos.

**Persona y lugar son dos hechos.** "Recorded by Jesús Jiménez at Optilaser
(Caracas, Venezuela)" produce un crédito de persona y otro de organización
con `organization_type='recording_studio'`. Y "Recorded & Mixed by X" produce
dos créditos, uno por verbo, para que `credit_type` no pierda la mitad al
clasificar.

### 2.6 Lo que la primera emisión enseñó sobre los nombres

Muestreando los 3.840 candidatos a persona de la primera pasada, un **7,7%**
no era utilizable. Cuatro defectos, todos de la misma familia: el parser
tomaba por nombre cosas que acompañaban al nombre.

| Defecto | Casos | Ejemplo |
|---|---|---|
| Dos personas fundidas por una coma | 194 | `Ana Valencia, María José Valencia` |
| Ciudad o marca pegada al nombre | 113 | `Alfredo "Chofa" Loero (Caracas, Venezuela)` |
| Banda de procedencia en corchetes | ~50 | `José Echezuría [from Sentimiento Muerto` |
| Sello o estudio acreditado con "by" | 15 | `Silversound Mastering Studios` |

Corregidos, el porcentaje baja a **0,1%** (4 de 3.743), y de esos cuatro,
tres son nombres legítimos que el heurístico marca de más: un coro, una
sección de cuerdas y un nombre artístico. Queda un solo defecto real —dos
personas separadas por `/`— que **no** se corrige a propósito: admitir `/`
como separador partiría nombres como AC/DC, y el beneficio es un caso.

De paso, el alcance por pista aceptaba `(track 05)` pero no `(CD2 track 05)`
ni `(all tracks)`, así que el paréntesis se quedaba dentro del nombre. Los
créditos acotados a pista pasan de 1.458 a 1.510.

La lección que conviene retener: **la coma no separaba, el paréntesis no se
retiraba, y el corchete tampoco**. Los tres son la misma clase de error que
` at ` y `&`, y los cuatro se encontraron midiendo la salida contra el corpus
guardado, no leyendo el código.

**Los residuos de la primera pasada están descartados.** Se identificaron por
diferencia —lo que el código corregido ya no emite y seguía en la base— y se
cerraron con `dismissEntity`, que marca los claims `rejected` y cierra sus
revisiones con una nota; no se borró nada. Fueron **755 identidades y 2.467
claims**: 359 personas, 1.430 créditos de disco y 678 de pista. Pistas,
discos, artistas y organizaciones no perdieron ni uno, porque el defecto solo
afectaba a nombres de personas y a los créditos que los citaban.

**[PENDIENTE]** El mismo defecto sobrevive en ~32 nombres de organización
(`Estudios Tumbador & La Cosa Nostra Estudios`, `El Techo, VinilH Records`):
`splitCreditValue` separa las personas pero no los locales. Arreglarlo cuesta
otra emisión completa —unos cien minutos— por 32 entidades, así que de momento
quedan señalados en el Visor de cola, donde se descartan a mano.

---

## 3. Las 11 fuentes autorizadas (registro del XLSX)

Columnas reales del archivo: `URL`, `Name`, `Type` (las 23 columnas restantes
de la cabecera están vacías). 11 filas de datos.

| # | Nombre (XLSX) | URL (XLSX) | Tipo (XLSX) | Confianza inicial | `enabled` inicial |
|---|---|---|---|---|---|
| 1 | Descargas Metal Venezolano | `descargasmetalvenezolano.blogspot.com` | Blogspot | low | sí |
| 2 | Rockzuela | `rockzuela.blogspot.com` | Blogspot | low | sí |
| 3 | Rock De Vzla | `rockdevzla.blogspot.com` | Blogspot | low | sí |
| 4 | Hippito y Sus Chatarritas | `hippitoysuschatarritas.blogspot.com` | Blogspot | low | sí |
| 5 | RHV Blogspot | `rockhechovzla.blogspot.com` | Blogspot | low | sí |
| 6 | Rock Hecho En Venezuela | `rockhechovenezuela.com` | Website | medium | sí |
| 7 | Sincopa | `sincopa.com` | Database | medium | sí |
| 8 | Coleccionistas De Rock Venezolano | `coleccionistasderockvenezolano.wordpress.com` | WordPress | medium | sí |
| 9 | El Punk En Venezuela | `punkenvenezuela.com` | Website | medium | sí |
| 10 | Rock & Pop Venezuela Merch Store | `deska.site/collections/rock-pop-venezuela` | Website | medium | **no** (`limited/disabled`) |
| 11 | Hemeroteka | `instagram.com/hemeroteka/` | Instagram | low | **no** (`limited/manual`) |

### 3.1 Resumen de acceso verificado (2026-09-07; tres fuentes revalidadas 2026-09-08)

| # | Fuente | HTTP | robots.txt | Encoding | ¿JS? | Canal estructurado | Volumen medido |
|---|---|---|---|---|---|---|---|
| 1 | Descargas Metal Vzla | 200 | 200 | UTF-8 | no | Atom/JSON Blogger | **1.355 entradas** |
| 2 | Rockzuela | 200 | 200 | UTF-8 | no | Atom/JSON Blogger | **1.127 entradas** |
| 3 | Rock De Vzla | 200 | 200 | UTF-8 | no | Atom/JSON Blogger | **1.113 entradas** |
| 4 | Hippito y Sus Chatarritas | 200 | 200 | UTF-8 | no | Atom/JSON Blogger | **1.063 entradas** |
| 5 | RHV Blogspot | 200 | 200 | UTF-8 | no | Atom/JSON Blogger | **264 entradas** |
| 6 | Rock Hecho En Venezuela | 200 | 200 | UTF-8 | no | WP REST `/wp-json` | **4 posts + 6 páginas** |
| 7 | Sincopa | 200 | **404** | **windows-1252** | no | ninguno (HTML estático) | **337 artistas + 290 fichas** (rock/pop) |
| 8 | CRV WordPress | 200 | 200 | UTF-8 | no | API pública WordPress.com | **92 posts** |
| 9 | El Punk En Venezuela | 200 | 200 | UTF-8 | no | WP REST `/wp-json` | **0 posts / 17 páginas** |
| 10 | Deska | no consumido | 200, `Disallow: /` | — | — | ninguno autorizado | `limited/disabled` |
| 11 | Hemeroteka (Instagram) | no automatizado | 200, `Disallow: /` + restricción expresa | — | — | ingreso humano | `limited/manual/disabled` |

Total accesible por feed Blogger: **4.922 entradas** en las 5 fuentes Blogspot.

### 3.2 Ficha por fuente

**1–5. Las cinco fuentes Blogspot** (Descargas Metal Venezolano, Rockzuela,
Rock De Vzla, Hippito y Sus Chatarritas, RHV Blogspot)

- **[CONFIRMADO]** HTTP 200, UTF-8, plataforma Blogger (servidor `GSE`,
  marcadores Blogger en el HTML), `robots.txt` presente (200).
- **[CONFIRMADO]** El contenido se sirve **sin JavaScript**: HTML completo.
- **[CONFIRMADO]** Feed nativo de Blogger disponible en
  `/feeds/posts/default` (Atom, `application/atom+xml`) y en JSON con
  `?alt=json`. Devuelve `openSearch:totalResults` con el total de entradas y
  acepta paginación (`max-results`, `start-index`).
- *Estrategia:* **adapter `blogger` sobre el feed**, no sobre el HTML de
  portada. El feed da título, fecha, autor, etiquetas y contenido del post ya
  estructurado; el HTML crudo se conserva como evidencia.
- *Estructura real, medida sobre las 4.922 entradas guardadas (2026-09-08).*
  Los cinco blogs NO comparten convención, y por eso no comparten extractor:

  | fuente | entradas | forma del dato | registros |
  |---|---:|---|---:|
  | Descargas Metal Venezolano | 1.355 | campos etiquetados en el cuerpo (`Banda:`, `Álbum:`, `Lanzamiento:`, `Género:`, `Lugar:`, `Web:`) + tracklist numerada — 1.352 de 1.355 | 11.313 |
  | Hippito y Sus Chatarritas | 1.063 | ficha completa en el **título** (`Artista - Título (Sello CAT / País Año)`) — 973 de 1.063; compositores en gris en el cuerpo | 14.868 |
  | Rock De Vzla | 1.113 | sin título; banda en la **etiqueta** y ficha rotulada por tamaño de fuente (`x-large` = banda, `large` = `Título (Tipo Año)`) — 1.110 entradas con banda, 1.815 discos, 9.908 pistas | 54.143 |
  | Rockzuela | 1.127 | la **etiqueta de sección** dice si el post es publicación (`Musica` 586, `Videos` 431, `Eventos` 94) + título `Banda - Álbum (Año)` — 475 artistas, 549 discos | 5.326 |
  | RHV Blogspot | 264 | prensa. Título `BANDA: Álbum (Año)` — **24** terminan en año, 18 dan banda y disco separables; etiquetas = secciones editoriales; **cero** tracklists | 126 |

  **Corrección (2026-09-08):** una medición anterior daba 0 a Rockzuela y Rock
  De Vzla y las declaraba "prosa". Era un error de la sonda, no de las
  fuentes: buscaba las etiquetas de Descargas Metal (`Banda:`) y recorría solo
  bloques `<div>/<p>/<li>`, mientras que esos posts separan sus líneas solo
  con `<br>`. Ambas tienen estructura explícita y datos abundantes.

  **Segunda corrección (2026-09-08):** la misma medición declaraba RHV
  Blogspot "prosa editorial, solo 12 entradas aprovechables". También era la
  sonda: RHV separa banda y disco con **dos puntos** (`PROARESIS: Propios Y
  Extraños (2022)`), no con guion, y el patrón `Banda - Álbum` no lo veía.
  Ninguna de las cinco Blogspot es prosa inextraíble.

  **Tercera corrección (2026-09-08), al escribir el adapter:** la fila de Rock
  De Vzla decía "formación (`La banda estuvo conformada por:`) … 1.028
  membresías, 16.171 pistas". Las tres cifras eran de una sonda laxa. Medido
  contra el parser real: esa frase aparece en **18** entradas y `Integrantes:`
  en **17**, casi siempre dentro de una oración en prosa, así que el adapter
  **no extrae ninguna membresía** de esta fuente; y las pistas que caen dentro
  del bloque de una ficha son **9.908**, no 16.171 — la cifra anterior contaba
  además las líneas numeradas de la zona de videos y las de fuera de toda
  ficha. Lo que la fuente sí da en abundancia son discos y portadas.

  **Cuarta corrección (2026-09-08), al escribir los dos últimos adapters:** de
  Rockzuela se decía "tracklist en 273 — 290 entradas con datos"; el adapter
  encuentra **549 discos** pero **ninguna pista**, porque el blog casi nunca
  publica lista de temas. Y de RHV Blogspot se decían "44 con esa forma, 28 con
  año; 8 tracklists (121 pistas)"; medido con el parser son **24** títulos
  terminados en año, **18** con banda y disco separables y **cero** tracklists
  — los temas se nombran dentro de la prosa de la reseña, que no se extrae. Es
  el mismo error de las tres correcciones anteriores: una sonda laxa contando
  líneas que parecen datos.

  **Quinta corrección (2026-09-08), al escribir el adapter de artes:** de CRV
  WordPress se decía "821 artes sobre 176 discos" y que el `alt` seguía la
  forma `<banda> <álbum> <tipo>`. Medido con el parser: **1.020** artes
  internas sobre **170** discos, y la convención del `alt` es más irregular —
  el tipo aparece también DELANTE y la banda DETRÁS ("Contraportada Parte
  Interna Misión Fantasma La Puta Eléctrica"), el índice de página va por los
  dos lados, y hay `alt` cortados a media palabra ("Contraportada Pa"). Además
  488 de sus 1.730 imágenes son avatares de Gravatar de quien comenta, que no
  son artes de nada.

- *Canal de las etiquetas Blogger (`entry.category`).* El feed trae las
  etiquetas del post y en dos fuentes son el dato que falta en el cuerpo:

  | fuente | etiquetas/post | qué son | uso |
  |---|---:|---|---|
  | Rock De Vzla | 1,0 | **el nombre de la banda** (1.110 de 1.113 con etiqueta única) | resuelve el artista, que el título no da: 1.111 entradas tienen título vacío |
  | Rockzuela | 3,1 | banda + **sección** (`Rock Nacional`, `Musica`, `Videos`, `Eventos`) | banda = la etiqueta fuera del vocabulario de sección; y la sección decide si el post es una publicación — sin ella, "Zapato 3 - En La Otra Cara (Parte II)" y "Los Paranoias - Leslie Sessions EP (2008)" son indistinguibles |
  | RHV Blogspot | 3,2 | **solo secciones** (`variedad`, `prensa`, `reseñas`, `noticias`) | ninguna nombra una banda: las 15 etiquetas del blog son editoriales, así que aquí el único canal es el título |
  | Descargas Metal | — | géneros (`Technical Death Metal`) | corrobora el campo `Género:` ya extraído |
  | Hippito | — | secciones (`Sólo Hits`) | sin valor |
- *Recopilatorios de Hippito (C3, decisión de modelo aprobada 2026-09-08).*
  Las 350 entradas `VA - ...` entran bajo la entidad marcador **"Various
  Artists"**, que ocupa `albums.artist_id` porque la columna es NOT NULL. El
  marcador no afirma que esas bandas sean "Various Artists": la línea de cada
  pista trae el grupo delante —`01. Los 007 - El Ultimo Beso`, en 4.027 de
  4.107 pistas— y ese grupo va a `track_credits.artist_id` con rol
  *intérprete*, una fila por pista y con su evidencia. Rinde **344
  recopilatorios, 2.283 bandas** que no aparecen en ninguna otra fuente y
  4.022 créditos de intérprete.
- *Limitaciones confirmadas:* son blogs de descargas. Además **no todo el contenido es venezolano** (p. ej. la
  entrada más reciente de Descargas Metal Venezolano en la sonda era de una
  banda no venezolana), por lo que hace falta un filtro de pertinencia antes
  de crear entidades.
- *Confianza:* `low` — colaborativo, sin verificación editorial.
- **[CONFIRMADO 2026-09-08]** Estructura interna de cada post caracterizada
  sobre el crudo ya guardado; ver la tabla de arriba.

**6. Rock Hecho En Venezuela** (`rockhechovenezuela.com`)

- **[CONFIRMADO]** HTTP 200, UTF-8, nginx, WordPress con **Elementor 3.29.2**
  (meta generator), `robots.txt` 200, sin JS para el HTML inicial.
- **[CONFIRMADO]** API REST de WordPress accesible en `/wp-json/wp/v2/`, pero
  el inventario es **muy pequeño: 4 posts y 6 páginas** (`X-WP-Total`).
- *Consecuencia:* pese a una portada de 243 KB, el contenido indexable por
  REST es mínimo; el grueso del texto vive dentro de estructuras de Elementor
  embebidas en las páginas. **Rendimiento esperado bajo** respecto a lo que
  sugiere el tamaño del sitio.
- *Estrategia implementada:* adapter HTTP ordinario con frontera fija de tres
  recursos derivados de la única raíz del XLSX: portada HTML, colección REST
  `posts` y colección REST `pages`. Cheerio procesa HTML y `content.rendered`;
  la lista estructurada de la página «Leyendas» puede emitir personas, pero un
  título de post o la prosa libre por sí solos no.
- *Confianza:* `medium` (editorial), pero volumen reducido.

**7. Sincopa** (`sincopa.com`) — **la fuente más rica en datos estructurados**

- **[CONFIRMADO]** HTTP 200. La raíz es una **página splash** de 2,4 KB con
  un enlace `ENTER` a `mainframe.htm`; por eso una sonda superficial la ve
  "casi vacía".
- **[CONFIRMADO]** `mainframe.htm` es un **frameset HTML clásico** (`top.htm`,
  `vertical.htm` como índice de navegación, `welcome.htm` como panel
  principal). Sitio estático generado con Microsoft FrontPage 6.0.
  **No requiere JavaScript.**
- **[CONFIRMADO]** Encoding **windows-1252** (declarado en el `<meta>`). Sin
  decodificación correcta los nombres acentuados se corrompen
  ("Agresión" → "Agresi", "Agonía" → "Agon"). El adapter **debe** decodificar
  a UTF-8 antes de normalizar.
- **[CONFIRMADO]** `robots.txt` devuelve **404** (el sitio no declara reglas).
  Se aplica igualmente la política de cortesía propia (1 req/s).
- **[CONFIRMADO]** Índices enumerables por género desde `vertical.htm`:
  `rock_pop/rock_artists_index.htm`, `classic/`, `new_age/`, `jazz/`,
  `latin_pop/`, `traditional/`, `ethnic/`, más
  `musicians/musicians_index.htm` (índice de músicos) y
  `rock_pop/rock_compilations_index.htm`.
- **[CONFIRMADO]** El índice rock/pop contiene **667 enlaces**: 337 a fichas
  de artista (`artist_rock/<slug>.htm`) y 290 a fichas de disco
  (`cdinfo_rock/<slug>_<album>.htm`).
- **[CONFIRMADO]** Una ficha de artista contiene, ya estructurado en tablas:
  año y ciudad de formación, género, **formación con instrumento y rango de
  años** (incluida sección "Ex Members") y **discografía con año, título,
  anotación de formato y sello discográfico**.
- *Valor para el core:* es la única fuente verificada que alimenta
  directamente `persons`, `artist_members` (rol + `from_year`/`to_year` +
  `is_current`), `organizations` (sellos) y `albums.label_id` — campos que el
  seed de YouTube **no puede** poblar.
- *Limitaciones confirmadas:* HTML de 2002-era sin marcado semántico (tablas
  anidadas, `<font>`); años a veces partidos por espacios en el HTML
  ("201 6" por 2016) → el parser debe normalizar dígitos separados; sin feed
  ni API. El copyright del sitio indica actividad hasta 2026.
- *Estrategia:* adapter `legacyFrameset`: descarga de `vertical.htm` →
  índices por género → fichas de artista y de disco; decodificación 1252;
  extracción por posición en tabla, no por clase CSS.
- *Confianza:* `medium` (editorial, curado, con página propia de fuentes).

**8. Coleccionistas De Rock Venezolano** (WordPress.com)

- **[CONFIRMADO]** HTTP 200, UTF-8, nginx, generator `WordPress.com`,
  `robots.txt` 200, sin JS. Título del sitio: "Rock & Roll criollo.".
- **[CONFIRMADO]** API pública de WordPress.com operativa:
  `https://public-api.wordpress.com/wp/v2/sites/coleccionistasderockvenezolano.wordpress.com/posts`
  → **92 posts** (`X-WP-Total`).
- *Estrategia:* adapter `wordpressCom` sobre la API pública (JSON con
  contenido, fecha, categorías); HTML crudo como evidencia.
- *Estructura real (medido 2026-09-08 sobre los 94 HTML guardados).* No es un
  blog de reseñas: es un **archivo de escaneos**. La banda es el título del
  post y el `alt` de cada imagen sigue la convención `<banda> <álbum> <tipo>`
  (`"Billy Se Fue Todo No Es Suficiente Contraportada"`), así que quitando el
  prefijo de la banda quedan disco y tipo de arte sin inferir nada:

  | tipo de arte | imágenes |
  |---|---:|
  | parte interna | 454 |
  | portada | 121 |
  | CD (galleta) | 121 |
  | contraportada | 119 |
  | cassette | 1 |

  **821 artes clasificadas sobre 176 discos**, de 1.420 imágenes en 92 posts.
  Es la única fuente con contraportadas, partes internas y galletas de CD, y
  la única que exige `media.media_links`: 700 de esas 821 no son portada y no
  caben en `albums.cover_url`.
- *Confianza:* `medium`. Es el blog del propio proyecto, de ahí su relevancia
  para `albums.wordpress_url` / `wordpress_status` en el core.

**9. El Punk En Venezuela** (`punkenvenezuela.com`)

- **[CONFIRMADO]** HTTP 200, UTF-8, Cloudflare, **WordPress 6.5.10**
  (generator), `robots.txt` 200, sin JS. Título: "Educación anterior: Una
  historia incompleta del punk venezolano".
- **[CONFIRMADO]** WP REST accesible, con un reparto importante: **0 posts**
  y **17 páginas** (`X-WP-Total`). El contenido es un sitio-libro por
  páginas, no un blog cronológico.
- *Consecuencia normativa:* el adapter `wordpress` **no puede** limitarse al
  endpoint `posts`; debe recorrer `pages`. Un adapter que solo lea `posts`
  extraería cero datos de esta fuente.
- *Estrategia:* WP REST `/pages` + Cheerio para el cuerpo narrativo.
  Contenido monográfico sobre punk venezolano → extracción narrativa
  (candidato legítimo a asistencia de IA acotada).
- *Estructura dura, medida 2026-09-08 y confirmada con el adapter:* 28
  reproductores de Bandcamp incrustados en los capítulos, **14 discos
  distintos**, todos de `humanoderechorecords.bandcamp.com`. Cada uno lleva
  dentro un enlace de respaldo con la convención propia de Bandcamp,
  `<Título> by <Artista>`. **De los 14 entran 8**: los otros seis dicen "by
  Recopilatorio", "by Recopilación" o "by Humano Derecho Records" — un
  recopilatorio no tiene artista único y `albums.artist_id` es NOT NULL, la
  misma decisión de modelo pendiente que con los VA de Hippito. Se emite
  además el sello como organización (`record_label`). El resto del cuerpo es
  narrativa.
- *Fuera de alcance, y verificado por un test:* las **1.705 imágenes** de los
  12 capítulos son escaneos del libro (© Rafael Uzcátegui, © Provea). No se
  ingieren: los hechos son extraíbles, las páginas escaneadas no. El adapter
  de esta fuente no emite **ni un solo** campo de imagen, y hay una prueba
  que lo comprueba. Tampoco traen `figcaption`, así que
  no aportan metadatos.
- *Confianza:* `medium`.

**10. Deska / Rock & Pop Venezuela Merch Store**

- **[CONFIRMADO 2026-09-08]** `robots.txt` responde 200 y publica
  `User-agent: *` / `Disallow: /`. Bajo la política del proyecto la URL de
  colección no es consumible automáticamente y no se prueban endpoints
  Shopify alternativos.
- *Clasificación implementada:* `limited / disabled`, `enabled=false`, sin
  `listPages`, parser ni entrada manual semántica. El fetcher vuelve a
  rechazarla por capacidad aunque alguien cambie accidentalmente `enabled`.
- *Condición para reconsiderar:* una superficie pública autorizada que no
  requiera eludir la política de acceso.

**11. Hemeroteka** (Instagram)

- **[CONFIRMADO 2026-09-08]** `robots.txt` declara `Disallow: /` y que la
  recolección automatizada requiere permiso expreso. El proyecto no dispone
  de una API pública autorizada ni de credenciales para este uso.
- *Clasificación implementada:* `limited / manual / disabled`, con
  `enabled=false`. No hay login automatizado, Playwright, proxies, API privada
  ni descubrimiento de publicaciones.
- *Entrada disponible:* `sources:evidence` acepta una URL de perfil o
  permalink de Instagram y un extracto aportados por una persona, valida el
  alcance y abre `review_queue(manual_review)`. No descarga la URL y no crea
  `raw_pages`, claims ni entidades; su interpretación queda pendiente.
- *Confianza:* `low`.

### 3.3 Artes de disco: qué fuente tiene qué

Medido el 2026-09-08 sobre todo el crudo guardado. **Casi todas las fuentes
traen portadas** —una afirmación anterior de que CRV WordPress era "la única
fuente con artes" era falsa— y cada una las declara por un canal distinto:

| fuente | imágenes de contenido | portadas atribuibles a un disco | canal que lo dice |
|---|---:|---:|---|
| Descargas Metal | 1.354 | 1.275 | título `Banda - Álbum (Año)` de la entrada |
| Sincopa | 1.437 | 917 + 520 fotos de artista | **la ruta del archivo** |
| Hippito | 1.575 | 987 | título de la entrada |
| Rock De Vzla | 1.868 | **1.775** | la imagen que cae dentro del bloque de su ficha (97,8% de los discos) |
| Rockzuela | 773 | **543** | primera imagen de la entrada, cuando la etiqueta `Musica` dice que es una ficha |
| RHV Blogspot | 835 | 18 | título `BANDA: Álbum (Año)` |
| CRV WordPress | 1.730 (488 avatares) | **163 portadas + 1.020 artes internas** | `alt` = `<banda> <álbum> <tipo>`, con el tipo por cualquiera de los dos extremos |

**Sincopa es el caso más explícito de todo el archivo**: el directorio declara
el tipo de medio sin ambigüedad y el `alt` trae la identidad (1.417 de 1.437
lo tienen), incluido el crédito del fotógrafo cuando lo hay.

- `covers160/ coversbig/ covers_big/ cover_latin16/ covers160cl/ covers100cl/
  covers10/` → portada · `alt="Culto Oculto - Puticlub"`
- `photos/ photos1..5/ pictures/ artist_photo(s)/ photos_class/` → foto de
  artista · `alt="Daiquirí (Photo: Emigdio Simancas)"`

*Consecuencia de diseño:* `albums.cover_url` ya existe en el merge spec, así
que la portada entra **sin migración**. Lo que no es portada necesitaba un
destino, y `media.media_links` existía desde 0002 pero ningún claim podía
nombrarla. Las migraciones **0008 y 0009** añaden el tipo de claim
`media_link` —sin tocar el core— y con él entran las 1.020 artes internas de
CRV WordPress (contraportadas, galletas de CD, libretos) y las fotos de
artista de Sincopa. Ver ARCHITECTURE.md §4.4.

*Lo que emiten hoy los ocho adapters* (la columna de arriba mide el crudo; lo
que sigue mide los `RawRecord` reales, que se apoyan en los campos etiquetados
del cuerpo y no sólo en el título):

| adapter | discos | `cover_url` | `picture_url` | `media_link` |
|---|---:|---:|---:|---:|
| Descargas Metal | 1.345 | **1.345** | — | — |
| Rock De Vzla | 1.815 | **1.775** | — | — |
| Hippito | 997 | 671 | — | — |
| Rockzuela | 549 | 543 | — | — |
| CRV WordPress | 170 | 163 | — | **1.020** |
| RHV Blogspot | 18 | 18 | — | — |
| El Punk En Venezuela | 8 | — | — | — |
| Sincopa | 2.414 | 782 | 259 | — |

Sincopa emite muchos más discos que portadas porque su discografía también se
lee de la tabla de la ficha de artista, que no lleva imagen: la portada sólo
existe en la ficha del disco.

### 3.4 Qué NO se asume

- No se asume la estructura interna de los posts de Blogger ni la calidad de
  sus tracklists: se caracteriza en F4 sobre el crudo ya almacenado.
- No se asume que el contenido de las fuentes Blogspot sea íntegramente
  venezolano: se requiere filtro de pertinencia antes de crear entidades.
- No se asume paginación ni sitemap fuera de lo confirmado en §3.1/§3.2.
- No se asume que los datos de Sincopa sean correctos por estar
  estructurados: alimentan claims `medium`, sujetos al motor de conflictos.
- El scraping arranca en modo **observación** (descarga + almacenamiento
  crudo, sin claims); la extracción se activa por fuente tras validar su
  estructura real.

### 3.5 Adapters de extracción (fase actual)

El registro cubre los once slugs del XLSX: nueve adapters automáticos
funcionales (los cinco Blogspot, Rock Hecho En Venezuela, Sincopa,
Coleccionistas WordPress.com y El Punk En Venezuela), Hemeroteka como adapter
limitado/manual y Deska como adapter limitado/deshabilitado. Los funcionales
emiten el mismo contrato de `RawRecord`/claims con URL, selector, extracto y posición de
evidencia. Los feeds/API se prefieren a HTML; Blogspot mantiene clases por
dominio aunque comparta infraestructura, y WordPress.com (`posts`) no se
confunde con El Punk (`pages`).

La extracción automática es conservadora: sólo consume etiquetas explícitas,
tablas de formación, tracklists y líneas de crédito. La prosa, un título por
sí solo, o un músico acreditado en un álbum no crean membresía. Todos los
claims web se persisten inicialmente con confianza `low` y quedan como
candidatos para revisión; no mutan el core ni crean entidades canónicas.

El crawler conserva la cortesía de §1 y suma límites finitos: 100 páginas de
feed Blogger y 700 documentos para la frontera estática confirmada de
Sincopa. Los enlaces descubiertos de Sincopa se restringen al mismo origen y
a rutas de índice/ficha confirmadas. No se intenta autenticación, CAPTCHA ni
evasión anti-bot; si una fuente pasara a exigirlos se marca `limited` y se
documenta, sin reintentos de evasión.

---

## 4. Conflictos ya detectados entre fuentes (material real para F5)

Detectados durante esta auditoría comparando el seed YT con la ficha de
Sincopa de Caramelos De Cianuro. Se registran aquí como **casos de prueba
reales**, no como verdades resueltas:

| Entidad | Campo | Seed YT (`high`) | Sincopa (`medium`) | Tratamiento |
|---|---|---|---|---|
| Caramelos De Cianuro — *Las Paticas De La Abuela* | `release_year` | 1992 | 1993 | Conflicto: ambas afirmaciones + evidencias conservadas |
| Caramelos De Cianuro — *8* | `release_year` | 2015 | 2016 (en HTML como "201 6") | Conflicto + nota de parsing |
| Caramelos De Cianuro — *La Historia: Grandes Éxitos* | `title` | "La Historia: Grandes Éxitos" | "La Historia" | Variante de título → alias, no conflicto |

Estos casos confirman que la política de conservación de ambas afirmaciones
(CONTRACT §5) no es teórica: aparece ya en el primer cruce de dos fuentes.

---

## 5. Seeds internos (fuentes de tipo spreadsheet)

| Fuente interna | Confianza | Uso |
|---|---|---|
| `yt_master_seed` (`YT Master Spreadsheet.xlsx`) | high | **Discografía curada por el propietario**, no una lista de videos: 606 filas → 258 artistas, 598 discos, 587 con año y 20 tipos de álbum que mapean casi 1:1 al enum `album_type`. 86 filas ni siquiera tienen URL. Mapeo en DATA_MODEL.md §5. |
| `links_seed` (`Links for Data Scrapping.xlsx`) | high | Seed de `ingest.sources` (11 filas; columnas reales URL, Name, Type). |

Los XLSX se importan una vez por versión (hash del archivo registrado en
`ingest.scrape_runs.params`); si el usuario edita el archivo, la nueva
versión se importa como un run nuevo y las filas nuevas se procesan
incrementalmente (`upload_order` único + `row_hash` por fila).

---

## 6. Proceso de alta de una fuente nueva (aprobación manual)

1. El usuario propone URL + alcance (dominio/páginas) + justificación.
2. Se crea la fila en `ingest.sources` con `enabled=false` y se abre un ítem
   en `ingest.review_queue` con el payload de la propuesta.
3. Tras la aprobación manual: se ejecuta la sonda de verificación (GET,
   robots, encoding, JS, canal estructurado), se completan
   `access_strategy` y `trust_level` y se habilita `enabled=true`
   **solo para el alcance aprobado**.
4. El dominio nuevo no puede exceder el alcance aprobado sin una nueva
   aprobación.
5. Ninguna fase posterior puede añadir fuentes por su cuenta: la lista de
   §3 es cerrada hasta que el propietario la amplíe explícitamente.

### 2.7 Un valor de `organization_type` que el enum no admite

De las 26 contradicciones abiertas, 22 son sobre `organization_type` y todas
parten del mismo sitio: el catálogo tiene `other` (el valor por defecto de la
columna) y la fuente propone algo más preciso.

| Cuántas | Catálogo | Propuesta | Estado |
|---|---|---|---|
| 15 | `other` | `record_label` | válido |
| 7 | `other` | `label` | **no existe en el enum** |

El enum admite `record_label, production_company, recording_studio,
distributor, management, other`. `label` no está: es `record_label` sin
normalizar, y aplicarlo tal cual fallaría al escribir.

Las otras 4 contradicciones son de `track_number` con `null` en los dos lados:
no hay nada que decidir y la Mesa de Cotejo ya lo dice en lugar de ofrecer
botones que fingen una elección.

**[PENDIENTE]** Normalizar `label` → `record_label` en el adaptador, o mapearlo
en el paso que aplique las decisiones. Hasta entonces las 7 se pueden decidir
en la mesa —la intención humana queda bien registrada— pero no se podrán
aplicar sin la traducción.
