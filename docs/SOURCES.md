# CRV — Fuentes autorizadas

> Normativo. La lista de fuentes es un conjunto **cerrado**: las 11 fuentes de
> `Links for Data Scrapping.xlsx` + YouTube Data API + los dos archivos XLSX
> como seeds internos. **Ninguna fuente nueva se añade sin aprobación manual
> del usuario** (proceso en §6).

**Fecha de verificación: 2026-09-07.** Todos los datos de "sonda" de este
documento fueron obtenidos ese día con peticiones GET de solo lectura
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
- **Disponibilidad:** `Status` del seed ('Unlisted' en 87 filas) y el campo
  `status` de la API alimentan claims que proyectan
  `albums.youtube_status` (enum `publication_status` del core).
- **Cuotas:** la API tiene cuota diaria por clave; `videos.list` acepta hasta
  50 IDs por llamada, de modo que los 520 IDs conocidos se cubren en ~11
  llamadas. La respuesta cruda se cachea en `media.youtube_videos.metadata`.
- **[POR CONFIRMAR]** disponibilidad real de cada video (público / no listado
  / eliminado): solo se sabrá al ejecutar la API en F3. El seed no es
  autoridad sobre el estado actual.

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
| 10 | Rock & Pop Venezuela Merch Store | `deska.site/collections/rock-pop-venezuela` | Website | medium | **no** (HTTP 402) |
| 11 | Hemeroteka | `instagram.com/hemeroteka/` | Instagram | low | **no** (manual) |

### 3.1 Resumen de acceso verificado (2026-09-07)

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
| 10 | Deska | **402** | 200 | UTF-8 | — | — | tienda deshabilitada |
| 11 | Hemeroteka (Instagram) | 200 | 200 | UTF-8 | **sí** | ninguno anónimo | ~2,5 KB de texto visible |

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
- *Limitaciones confirmadas:* son blogs de descargas; el dato musicológico
  vive en prosa dentro del post (tracklist, año, formación), **no** en campos.
  Requiere extracción narrativa cuidada y, en casos desordenados, asistencia
  puntual de IA. Además **no todo el contenido es venezolano** (p. ej. la
  entrada más reciente de Descargas Metal Venezolano en la sonda era de una
  banda no venezolana), por lo que hace falta un filtro de pertinencia antes
  de crear entidades.
- *Confianza:* `low` — colaborativo, sin verificación editorial.
- **[POR CONFIRMAR]** Estructura interna de cada post (formato del tracklist,
  presencia de créditos) — se caracteriza en F4 sobre el crudo ya guardado.

**6. Rock Hecho En Venezuela** (`rockhechovenezuela.com`)

- **[CONFIRMADO]** HTTP 200, UTF-8, nginx, WordPress con **Elementor 3.29.2**
  (meta generator), `robots.txt` 200, sin JS para el HTML inicial.
- **[CONFIRMADO]** API REST de WordPress accesible en `/wp-json/wp/v2/`, pero
  el inventario es **muy pequeño: 4 posts y 6 páginas** (`X-WP-Total`).
- *Consecuencia:* pese a una portada de 243 KB, el contenido indexable por
  REST es mínimo; el grueso del texto vive dentro de estructuras de Elementor
  embebidas en las páginas. **Rendimiento esperado bajo** respecto a lo que
  sugiere el tamaño del sitio.
- *Estrategia:* WP REST para el inventario + Cheerio sobre el HTML de las 6
  páginas para el contenido de Elementor.
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
- *Confianza:* `medium`.

**10. Deska / Rock & Pop Venezuela Merch Store**

- **[CONFIRMADO, dos auditorías]** **HTTP 402 "Store unavailable"** (tienda
  Shopify deshabilitada). `robots.txt` responde 200. Sigue caída a
  2026-09-07.
- *Consecuencia:* no hay datos accesibles. Queda registrada con
  `enabled=false`. No se elimina del registro (es fuente autorizada), pero no
  se scrapea hasta que vuelva y se re-verifique.
- **[POR CONFIRMAR]** Todo su contenido y utilidad real.

**11. Hemeroteka** (Instagram)

- **[CONFIRMADO]** HTTP 200 y ~726 KB de HTML, pero solo ~2,5 KB de texto
  visible: es una aplicación JavaScript. El contenido real requiere
  JS/sesión. `robots.txt` 200.
- *Consecuencia confirmada:* **el scraping anónimo simple NO funciona**, y el
  scraping masivo de Instagram no está autorizado por esta especificación.
- *Estrategia:* fuente de **uso manual asistido**: el operador aporta
  hallazgos puntuales que entran como claims `created_by=human`. Sin barrido
  automático. Playwright **no** se habilita para esta fuente.
- *Confianza:* `low`.

### 3.3 Qué NO se asume

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
| `yt_master_seed` (`YT Master Spreadsheet.xlsx`) | high | Seed del catálogo audiovisual (606 filas). Mapeo en DATA_MODEL.md §5. |
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
