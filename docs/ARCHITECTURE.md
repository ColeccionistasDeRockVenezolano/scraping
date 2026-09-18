# CRV — Arquitectura

> Normativo para la implementación. Una **única aplicación modular**,
> ejecutable en una sola máquina. Sin microservicios, sin Kafka, sin
> Kubernetes, sin Elasticsearch, sin colas externas. Postgre es la única
> fuente de verdad; el disco local guarda HTML crudo.

---

## 1. Stack obligatorio

| Componente | Elección | Notas |
|---|---|---|
| Runtime | Node.js 22 LTS | **la máquina tiene hoy Node v20.20.2**: actualizar en F0 antes de escribir código |
| Lenguaje | TypeScript (strict) | |
| Base de datos | PostgreSQL 15+ (probado en 16) | `public` = core canónico inmutable; `ingest` + `media` = auxiliares (DATA_MODEL.md) |
| ORM | Drizzle ORM | migraciones; dos clientes de esquema: `public` (solo lectura por app salvo merge engine) y `ingest` |
| Validación | Zod | contratos de todos los límites: HTTP in/out, payloads de scrapers, payloads de IA, config |
| HTTP (API) | Fastify | plugins: cors (localhost), static (frontend futuro), swagger |
| Extracción HTML | Cheerio | regla general |
| Navegación | Playwright | **no habilitado**. Revalidado 2026-09-08: ninguna fuente activa lo requiere; Instagram es manual y su automatización está deshabilitada |
| Tests | Vitest | unit + integración contra PG de test (`crv_test`) |
| Logs | Pino | structured logs + `ingest.merge_audit` para auditoría de datos |
| Frontend (futuro) | React + Vite (SPA) | solo consume la API; fase F8 |
| IA (puntual) | DeepSeek API vía gateway dedicado | ver §7 |

---

## 2. Regla de oro de red

```
Navegador  ──(HTTPS/JSON)──▶  Backend (Fastify)  ──▶  PostgreSQL
```

El navegador **nunca** conecta directamente al puerto de PostgreSQL.
PostgreSQL solo acepta conexiones locales del backend (listen en localhost;
API en `127.0.0.1:8080` por defecto, configurable por env).

---

## 3. Vista general de módulos

```
                        ┌──────────────────────────────────────────────┐
                        │                 CLI (comandos)               │
                        └───────────────────┬──────────────────────────┘
                                            │ (mismos casos de uso)
   ┌─────────────┐  ┌──────────┐   ┌────────┴────────┐   ┌───────────────┐
   │ scraper     │  │ youtube  │   │  merge engine   │   │  API Fastify  │
   │ adapters    │  │ ingestión│   │ (core writer)   │   │  (CRUD futuro)│
   └──────┬──────┘  └────┬─────┘   └────────┬────────┘   └───────┬───────┘
          │              │                  │                    │
   ┌──────┴──────┐  ┌────┴──────┐   ┌───────┴────────┐   ┌───────┴───────┐
   │ fetcher     │  │ YouTube   │   │ entity resol.  │   │ deepseek      │
   │ (+cache)    │  │ Data API  │   │ + normalización│   │ gateway       │
   └──────┬──────┘  └────┬──────┘   └───────┬────────┘   └───────┬───────┘
          │              │                  │                    │
   ┌──────┴──────────────┴──────────────────┴────────────────────┴───────┐
   │             PostgreSQL (public core + ingest/media aux)              │
   │   claims · claim_evidence · conflicts · review_queue · merge_audit   │
   └──────────────────────────────────────────────────────────────────────┘
   Disco: data/raw/<source>/<sha>.html        (almacenamiento crudo)
```

---

## 4. Módulos y responsabilidades

### 4.1 `fetcher`
GET/HEAD con:
- User-Agent identificable, timeout, reintento con backoff.
- Respeto de `robots.txt` (caché en memoria por proceso): `Allow`/`Disallow`
  con comodines `*`, ancla `$`, `Crawl-delay` y descubrimiento de `Sitemap`.
  Un 404 significa política no publicada; errores transitorios/red/5xx son
  fail-closed y bloquean el fetch hasta que la caché de política venza.
- Límite de concurrencia por dominio (1) y demora mínima entre peticiones (1 s).
- Salida: HTML crudo + cabeceras + código → entrega a `raw storage`.

### 4.2 `cache`
Doble nivel: (a) `ingest.raw_pages` con `UNIQUE(source_id, sha256)` — dedupe
por contenido; para frescura se busca la última fila por URL solicitada o
canónica y, si no venció (TTL default 7 días), se reutiliza; (b) caché de
`robots.txt` y de respuestas de la YouTube Data API
(`media.youtube_videos.metadata`) con TTL propio.

### 4.3 `raw source storage`
- HTML crudo en disco: `data/raw/<source-slug>/<sha256>.html` (+ cabeceras en
  JSON adyacente). Hash = identidad de contenido.
- Fila `ingest.raw_pages` con metadatos (`url`, `canonical_url`, `http_status`,
  `content_type`, `sha256`, `fetched_at`, `headers`, `run_id`).
- El crudo **nunca se modifica ni se re-procesa destructivamente**: si un
  parser cambia, se re-ejecuta sobre el crudo guardado (reproducibilidad).

### 4.4 `scraper adapters`
Interfaz común por fuente:
```ts
interface SourceAdapter {
  slug: string;
  listPages(root: SourceConfig): AsyncIterable<PageRef>;   // descubrimiento
  extract(page: CheerioAPI, url: string): RawRecord[];     // parse
}
```
El registro usa una unión discriminada: `functional/automatic/enabled` contiene
un `SourceAdapter`; `limited/manual/disabled` y `limited/disabled` no exponen
`listPages` ni `extract`. Así `sources.enabled` no es la única barrera ante una
activación accidental. Canales verificados el 2026-09-07 y revalidados para
las tres fuentes restantes el 2026-09-08 (SOURCES.md §3):

| Adapter | Fuentes | Canal de acceso confirmado |
|---|---|---|
| `blogger` | las 5 Blogspot | Feed nativo `/feeds/posts/default` (Atom o `?alt=json`), con `openSearch:totalResults` y paginación. **4.922 entradas** en total |
| `wordpress` | rockhechovenezuela.com, punkenvenezuela.com | RHV: raíz HTML + colecciones REST `posts`/`pages`, frontera fija de 3 recursos. El Punk: REST `pages` (0 posts, 17 páginas) |
| `wordpressCom` | coleccionistasderockvenezolano | API pública `public-api.wordpress.com` (92 posts) |
| `legacyFrameset` | sincopa.com | Frameset estático desde `vertical.htm` → índices por género → fichas. **Decodificar windows-1252 antes de normalizar** |
| `limitedManual` | Hemeroteka (Instagram) | `limited/manual/disabled`; entrada humana a `review_queue`, sin fetch ni claim ficticio |
| `limitedDisabled` | Deska | `limited/disabled`; `robots.txt` declara `Disallow: /`, sin adapter HTTP ni endpoints alternativos |

- Regla: si la fuente ofrece feed/API estructurada, el adapter la usa para el
  inventario. La raíz HTML solo se añade cuando forma parte expresa de la
  frontera (RHV); todo crudo se conserva como evidencia.
- Todo adapter emite `RawRecord` (JSON crudo tipado con Zod) → normalización.
- **Canales de una entrada Blogger.** `BloggerAdapter.extractEntry()` recibe
  el cuerpo, el **título** y las **etiquetas** (`entry.category`) por separado,
  porque los cinco blogs reparten sus metadatos entre los tres de forma
  distinta: Hippito los pone enteros en el título, Descargas Metal en el
  cuerpo, y Rock De Vzla —1.110 de sus 1.113 entradas con el título vacío—
  solo en la etiqueta. Descartar cualquiera de los canales antes de parsear
  dejaba esas fuentes en cero. El parámetro es opcional, así que un adapter
  que no lo declara conserva su comportamiento.
- **Semántica fuera del texto.** Cuatro fuentes codifican qué es cada cosa en
  un canal que no es prosa, y cada adapter lee el suyo: Sincopa en el
  **directorio** de la imagen, Hippito en el **color gris** del crédito, Rock
  De Vzla en el **tamaño de fuente** (`x-large` = banda, `large` = ficha de
  disco) y en una línea de guiones que separa la discografía de los videos, y
  Rockzuela en la **etiqueta de sección** (`Musica` = publicación, `Videos` =
  actuación). Los dos últimos resuelven el mismo problema: un título con forma
  de ficha que no siempre describe un disco.
- **Tablas heredadas de Sincopa.** Sus fichas de disco permiten artista y
  título en varias líneas y sus fichas de artista mezclan una tabla anual con
  bloques detallados de sencillos. El adapter ancla `Company`, `Genre` y
  `Release Year` desde el final de la cabecera, conserva el bloque en negrita
  como artista y solo acepta una fila anual cuando su primera celda es un año
  de cuatro cifras. `review sincopa-organizations` reextrae todo el crudo con
  esas reglas y puede retirar, con nota y confirmación, únicamente los falsos
  sellos sin evidencia de otra fuente ni dependencias; el run conserva las
  fichas, claims e historia retirados.
- **Gramática compartida.** `parseReleaseHead()` (en `adapters/shared.ts`) lee
  la forma `Título (Tipo Año)` que usan tres de los blogs por canales
  distintos, con un vocabulario español común: `Demo`/`Ep`/`Single` son tipo de
  publicación y aterrizan en `album_type`; `Lp`/`Cassette`/`Vinilo` nombran el
  soporte y van a `format`, porque decir en qué se editó no es decir qué clase
  de publicación es. Un paréntesis con solo el año no rellena el tipo.
- **Artes.** `contentImages()` (en `adapters/shared.ts`) separa imagen de
  adorno por descarte explícito —iconos sociales, plantilla, `data:` URIs y
  anchos declarados < 100px— y no decide qué representa cada imagen: eso lo
  dice el canal de cada fuente. Sincopa lo declara en la **ruta**
  (`covers*/` → portada, `photos*/|pictures/|artist_photo*/` → foto de
  artista); los blogs, en el **orden** (la primera imagen de contenido de una
  ficha de disco es su portada). Aterriza en `albums.cover_url` y
  `artists.picture_url`, columnas que ya existían: **ninguna migración**.
  Cuando el servidor declara el tamaño servido (`/s400/` de Blogger) eso
  decide sobre el nombre del archivo, que en un blog es el que tuviera quien
  la subió. Detalle por fuente y recuentos en SOURCES.md §3.3.
- **Artes que no son portada** (migraciones 0008 y 0009). `albums.cover_url` y
  `artists.picture_url` guardan UNA imagen cada una: la canónica. Un disco de
  CRV WordPress trae además contraportada, galleta de CD y libreto, y
  escribirlos en esa columna obligaría a elegir uno y tirar el resto. Van a
  `media.media_links` a través del tipo de claim `media_link`, cuyo puente
  (`src/merge/media-links.ts`) obedece las mismas cuatro reglas que el de
  relaciones: **un arte nunca crea su entidad** —si el disco no está en el
  core, va a revisión—, el destino lo fija el claim y no la URL, un claim
  `low` no escribe, y los claims hermanos se leen juntos. La escritura es
  idempotente por `UNIQUE(destino, url)`.
  El core no participa: 0008 y 0009 solo tocan `ingest`, la huella de
  `core-catalog.json` no cambia y el diff de `pg_dump` de `public` sigue vacío
  tras el rollback completo.
- **Playwright solo se incorpora como adapter opcional** si una fuente lo
  exige tras verificación en F4. Verificado hoy: **ninguna fuente activa lo
  requiere**; ninguna de las 9 fuentes accesibles necesita JS.

- **Recopilatorios y el marcador «Various Artists»** (C3). `albums.artist_id`
  es NOT NULL y un recopilatorio no tiene artista único, así que necesita algo
  en esa columna. El marcador la ocupa —`artist_type = other`, con nota— y
  quien toca cada pista se afirma en `track_credits.artist_id`, que existe
  precisamente para eso. Para que el puente no conjeture, el claim declara
  `credited_kind`: sin él probaría `person → organization → artist` en ese
  orden y podría enganchar la pista a un homónimo.
- **Un DEFAULT del DDL no es una afirmación.** Varias columnas del core son
  NOT NULL con default (`artists.artist_type` = 'band', `albums.album_type` =
  'other'), y `createEntity` solo escribe la columna de identidad. Tratar ese
  valor como parte contraria archivaba en conflicto todo claim de tipo de
  todas las fuentes. Una contradicción exige DOS afirmaciones: el motor
  consulta `merge_audit` —la ausencia de rastro prueba que nadie lo afirmó— y
  deja que la primera fuente complete el default. La segunda discrepancia sí
  es contradicción y se conserva, como siempre.

### 4.5 `normalization`
Pipeline determinista sobre `RawRecord` → `NormalizedClaim`:
- Unicode NFC, trim, colapso de espacios, nombres de persona/artista,
  normalización de títulos (mayúsculas/tildes para match-key, **sin** alterar
  el valor original que se conserva en `raw_value`).
- Tokenización de `Type of Album` (DATA_MODEL.md §5) y mapping a enums core.
- Validación de años (SMALLINT, 1900..2100; el rango real del seed es
  1964-2023), URLs, video IDs (`^[A-Za-z0-9_-]{11}$`).
- Caveats confirmados que el pipeline debe absorber: celdas numéricas del
  XLSX que llegan como flotantes (`'2009.0'`); años partidos por espacios en
  el HTML de Sincopa (`'201 6'`); parámetros de UI en las URLs de YouTube
  (`&t=`, `&pp=`) que se descartan al derivar el ID y la URL canónica.
- Consulta de `ingest.genres` para el campo género (desconocido → claim +
  review, nunca bloqueo).

### 4.6 `entity resolution` (ER)
Orden determinista: normalización → match exacto → tablas de alias
(`ingest.artist_aliases` y hermanas)
→ señales contextuales tipadas → Jaro-Winkler como señal secundaria. Una
similitud fuzzy, una diferencia de artículo o una coincidencia solo sin tildes
**nunca autorizan un merge por sí solas**. Si la ambigüedad persiste, el
gateway DeepSeek puede adjuntar una propuesta (opcional, §4.11), pero no
elevar la acción determinista; de lo contrario se abre `review_queue`.
Cada decisión se persiste en `ingest.entity_resolution_decisions` con input
original, score, thresholds, features, candidatos y explicación. Resultado:
FK resuelta, revisión o propuesta de entidad nueva.
La decisión **no se borra nunca**: `src/er/retention.ts` (migración 0022)
compacta por edad el dossier de candidatos —conserva acción, score, features,
explicación, `input_context` y las 20 mejores candidatas con el conteo en
`candidates_count`—, porque con el catálogo crecido una sola fila llegaba a
pesar cientos de kB (19 GB de tabla, auditoría 2026-09-17). Lo corre la API
sola y `crv er:prune [--dry-run]` a mano.

### 4.7 `claims / evidence`
Capa de persistencia de afirmaciones: `ingest.claims` (dedupe por
el índice `claims_dedupe_uk`) y `ingest.claim_evidence`
(fragmento + selector + URL + hash). Ningún dato cruza al core sin claim.

### 4.8 `merge engine` — único escritor del core
- Política híbrida por confianza (ver CONTRACT §merge):
  high→crea/confirma/completa; medium→solo info nueva no conflictiva;
  cualquier contradicción→claims rivales + review; low/AI→nunca escribe core.
- Escribe bajo `pg_advisory_xact_lock` con clave determinista por entidad
  (DATA_MODEL.md §6) → idempotencia incluso en ejecuciones concurrentes.
- **Identidad heredada:** cuando un claim crea la entidad, sus hermanos (año,
  género, duración) llegan con el mismo `identity_key` y sin FK. Volver a
  resolverlos por ER los estrella contra los guardias de homónimos y de
  contexto, porque un álbum o una pista recién creados aún no tienen el
  contexto que el ER exige; el efecto era que solo el nombre entraba al
  catálogo. El motor reusa la FK que otro claim de esa misma identidad y
  fuente ya resolvió y auditó — no es una decisión de identidad nueva. Si esa
  identidad apunta a más de una entidad, no se elige ninguna.
- Regla dura: **un crédito de álbum jamás inserta `artist_members`**.
- Cada write deja entrada en `ingest.merge_audit` (+ `merge_audit_claims`:
  qué claims respaldan la escritura).

#### 4.8.1 `relationship bridge` (`src/merge/relations.ts`)
Los tres `entity_kind` de relación (`artist_membership`, `album_credit`,
`track_credit`) no describen una entidad sino un vínculo entre dos, así que
tienen su propio puente, al que el merge engine delega. Sus reglas:

- **La tabla destino está fijada por el `entity_kind`**, no por el rol. Ahí
  vive la regla dura: un crédito no puede aterrizar en `artist_members` ni
  por un rol ambiguo ni por un error de mapeo — es estructuralmente
  imposible.
- **Una relación nunca crea sus extremos.** Si el artista, la persona, el
  álbum o la pista todavía no existen en el core, el claim queda `candidate`
  y abre revisión. El orden es siempre entidad → relación.
- **La unidad es el registro completo**, no el campo: los claims hermanos de
  la misma `(entity_kind, identity_key)` se leen juntos. Si dos claims
  contradicen un campo, no se elige ninguno: la relación va a revisión.
- **Resolución de extremos heredada.** El extremo es la misma entidad que un
  claim hermano de esa fuente ya resolvió y auditó; el puente reusa esa
  decisión (`claim_graph`) antes de recurrir al ER. Esto no relaja el guardia
  de homónimos: no introduce una decisión de identidad nueva, hereda la que
  ya se tomó y se auditó aguas arriba. Solo si no hay herencia se consulta el
  ER, y de él únicamente cuenta un `AUTO_MATCH`.
- **La pista se resuelve dentro de su álbum**, por título exacto o por número
  (`(tracks 03, 05)` produce una fila por pista), no por ER global: el título
  de una pista solo identifica dentro de su disco.
- `credit_type` es una clasificación determinista del rol
  (`creditTypeForRole`); el rol crudo se conserva íntegro en `role`, y lo que
  no se reconoce cae en `other` en vez de forzarse a `musician`.
- **Un crédito equivalente no se duplica** (`creditEquivalenceKey`, 2026-09-14):
  antes de insertar se busca un crédito del mismo acreditado, en la misma obra
  y con el mismo `credit_type` cuya clave coincida. En `photography` y
  `artwork` el texto del rol no distingue ("Photos" = "Photography by";
  "Graphic Design & Illustrations" = "Artwork & Illustration"); en los demás
  tipos solo se ignoran la preposición final, tildes, mayúsculas y signos
  ("Produced by" = "produced", pero "Guitar" ≠ "Bass" y "Executive
  Production" ≠ "Produced by").
- Igual que las entidades, **una relación `low` automática no escribe**: solo
  `high` o una decisión humana (`createdBy="human"`, vía `review approve`).

### 4.9 `conflict engine`
Detecta dos claims aceptables que afirman valores distintos para el mismo
campo de la misma entidad: crea `ingest.conflicts` (ambos valores + ambas
evidencias), suspende el campo en core y abre `review_queue(field_conflict)`.
Resoluciones: a, b, both_kept o dismissed; solo a/b proyectan un valor y toda
proyección queda auditada.

### 4.10 `review queue`
Fuente única de trabajo humano (`ingest.review_queue`, con FKs reales a las
entidades implicadas). 16 kinds realizados: de 0003 `possible_duplicate`,
`field_conflict`, `ambiguous_alias`, `album_match`, `person_match`,
`organization_match`, `youtube_match`, `manual_review`; de 0004
`missing_url`, `seed_incomplete`, `media_type_no_album`, `genre_unknown`,
`new_source`, `low_confidence`, `ai_biography`, `ai_entity_resolution`.
Consumida por CLI (`review list|approve|dismiss`) y por la UI React.

**Aprobación por lotes** (`src/review/batch.ts`). La cola guarda un ítem por
claim y se decide por entidad, pero un barrido completo produce del orden de
10.000 entidades candidatas: promoverlas de una en una no llena el catálogo,
llena la cola. `runBatch` deja que la persona exprese **una** decisión sobre
un conjunto (por tipo, por fuente, con techo) sin relajar ninguna guarda:
sigue llamando a `approveEntity`, que re-ejecuta el merge con
`createdBy="human"`. Tres invariantes propias del lote:

1. **Orden de dependencia** (`BATCH_ORDER`): organización → artista → persona
   → álbum → pista → membresía → crédito de disco → crédito de pista.
   `albums.artist_id` es NOT NULL y los puentes necesitan sus dos extremos,
   así que aprobar por orden de llegada dejaría discos sin artista.
2. **Trazabilidad**: el lote es una fila real en `ingest.scrape_runs` (kind
   `merge_run`) y su id encabeza la nota de resolución de cada revisión que
   cierra, de modo que "qué aprobó este lote" es una consulta.
3. **Aislamiento del fallo**: una entidad rota no aborta el resto; se acumula
   en `errors` y el run termina `partial`.

El CLI previsualiza por defecto y sólo escribe con `--confirm` y `--note`.

**Correcciones de identidad de personas** (`src/review/person-corrections.ts`,
`crv review persons --plan=<json> [--note --confirm]`). La detección de
duplicados solo ve nombres exactos; que «Luis Barrios» sea Luis "Golding"
Barrios, que «Car» y «los Rondon» sean un nombre cortado o que una «persona»
sea la banda lo decide una persona, y se escribe como plan JSON versionado en
`docs/decisions/`. Operaciones: `rename`, `merge` (reusa `mergeInto` de
`duplicates.ts`: reapunta toda FK antes de borrar), `drop_aliases`,
`to_artist` y `to_organization` (los créditos pasan al destino, los claims de
nombre se rechazan —nunca se borran— y la historia de la ficha se copia a la
auditoría del destino). Cada operación nombra el id y el nombre que espera; si
la base no coincide se aborta el plan entero, y lo ya aplicado se reconoce y
se salta. Tras cada operación se unen los créditos equivalentes del
acreditado. Sin `--confirm` el plan se ejecuta en una transacción que se
deshace.

**Motor de fusión** (`src/review/duplicates.ts`, endurecido en E11.1). Es el
único camino que borra una fila del core, y lo hace al final: primero reapunta
todas las FKs que la apuntan (descubiertas en el catálogo), moviendo por lotes
y bajando a fila a fila solo ante una colisión de unicidad. Un claim nunca se
borra: el gemelo queda `superseded` sin destino. Una revisión que careaba las
dos fichas se suelta en vez de reapuntarse (violaría
`review_queue_distinct_*_chk`). Todo lo movido, descartado y soltado queda en
`merge_audit.new_value` (`version: 2`) para poder deshacer la fusión. Las
columnas vacías se completan en una sola sentencia, contando los DEFAULT del
core (`album_type='other'`, `is_venezuelan=false`) como «vacío».

**Relaciones equivalentes** (`src/merge/equivalent-relations.ts`, E11.1). Dos
créditos del mismo acreditado en la misma obra con la misma clave de
equivalencia, y dos membresías de la misma persona en la misma banda con el
mismo rol y períodos compatibles, son una sola fila. Los períodos que se
contradicen no se tocan: abren revisión `manual_review` y decide una persona.
Lo usan la corrección por plan y la fusión de personas (servicio y API).

**Resolución de ambigüedades** (`src/ambiguity/`, PHASES §E10; plan, fase
10B). Trabaja solo sobre la cola, en tres pasos:

1. `crv ambiguity:scan [--dry-run]` encola como `possible_duplicate` los pares
   que el cierre de F2–F5 dejó descritos: discos del mismo artista con ≥3
   pistas equivalentes en la misma posición y personas cuyos nombres guardan
   una relación reconocible (apodo, segundo nombre, iniciales, errata) **y**
   comparten una banda. Various Artists no cuenta como banda. El parecido de
   nombre sin banda común no se encola; se lista en
   `reports/ambiguity-scan.json`. Idempotente por `payload.pairKey`.
2. `crv ambiguity:resolve [--dry-run] [--review=<ids>] [--ai | --arbiter-file=<json>] [--export=<json>]`
   carga un dosier por caso abierto (`dossiers.ts`) —nombres, alias, años,
   tipos y clasificaciones, pistas, créditos, bandas, fuentes, título y
   descripción del video, fila de la hoja, decisiones previas de la Mesa— y
   decide cada pregunta con reglas deterministas (`albums.ts`, `persons.ts`,
   `youtube.ts`): MATCH_HIGH_CONFIDENCE, KEEP_SEPARATE, NEEDS_HUMAN o
   CONFLICT. Cada decisión cita hechos del dosier por id (`assertGrounded`);
   ninguna distinta de NEEDS_HUMAN puede carecer de evidencia, y el DDL lo
   repite. Dos candidatos plausibles (una inicial que encaja con dos personas,
   un disco en dos pares) son NEEDS_HUMAN. Solo lo que queda NEEDS_HUMAN con
   ambigüedad semántica pasa a un árbitro (`arbiter.ts`): DeepSeek por el
   gateway con el modelo flash, o un archivo de decisiones externas atado al
   hash del dosier. `applyArbiterPolicy` descarta la propuesta que cite hechos
   inexistentes, un MATCH con menos de dos hechos a favor, con hechos en contra
   o con incertidumbres. Escribe `ingest.ambiguity_resolutions` y
   `reports/ambiguity-resolution.{json,md}`; no toca el core. El hash del
   dosier hace idempotente la corrida: la misma evidencia reutiliza la fila y
   una evidencia nueva la sustituye (`superseded`).
3. `crv ambiguity:apply [--review=<ids>] --note=... --confirm` es la única
   puerta al core de la etapa. Aplica MATCH (fusión de discos o personas con
   `mergeInto` y alias, enlaces `live_concert` y ocurrencias de video con
   `merge_audit`) y KEEP_SEPARATE (solo cierra); nunca CONFLICT ni
   NEEDS_HUMAN. En lote solo entran decisiones de reglas; una de árbitro se
   aplica nombrando su revisión. Antes de escribir comprueba que las fichas
   siguen como se vieron, y cierra la revisión cuando todas sus preguntas
   están aplicadas. En una fusión conserva primero la ficha respaldada por el
   canal, después la que tiene tipo y tracklist más completos y, en empate, el
   título menos truncado; para personas pesan además el nombre completo, el
   apodo, el uso y la grafía menos cortada.

### 4.11 `deepseek gateway`
Único punto de contacto con la IA. Contrato estricto (Zod in/out), registro
en `ingest.ai_runs` con `prompt_hash` (caché: mismo prompt = mismo resultado
reutilizado, ahorro de coste e idempotencia). Usos permitidos **solo**:
(1) resolución de ambigüedad en ER, (2) extracción narrativa compleja
(biografías largas → `ingest.ai_biographies` draft), (3) triage de conflictos
(sugerencia, nunca decisión), (4) normalización de créditos muy desordenados.
**Nunca** como extractor universal ni como fuente primaria de datos
estructurados. No recibe tools, no ejecuta SQL y no llama al merge: retorna
propuestas JSON; una respuesta vacía, truncada, no-JSON o que no satisfaga el
schema Zod se rechaza. Flash atiende clasificación/extracción narrativa/
normalización semántica; Pro, ER difícil/conflictos/historia; Vision queda
aislado para entrada visual. Los tres IDs se configuran por
`DEEPSEEK_MODEL_FAST|REASONING|VISION`, sin acoplar reglas a nombres de modelo.
Una llamada puede fijar su `modelClass`: el arbitraje de ambigüedades (E10) usa
flash por decisión del propietario (2026-09-14), aunque su tarea sea de ER.
Sin API key el sistema y toda la suite funcionan con rutas deterministas/mock.

### 4.12 `youtube ingestion`
- `youtube import-sheet`: importa el XLSX a `ingest.seed_uploads` (verbatim) y
  extrae `video_id` (watch?v=, youtu.be/, ignorando `&t=`/`&pp=` para el ID).
- `youtube sync`: YouTube Data API `videos.list` sobre IDs registrados →
  `media.youtube_videos` (título, canal, fecha, duración, disponibilidad) y
  claims de disponibilidad hacia `albums.youtube_status` solo cuando el video
  tiene enlace primario a un álbum. Hasta 50 IDs por llamada: los 520 IDs
  conocidos se cubren en ~11 llamadas.
- `youtube seed-claims` (`src/youtube/seed-claims.ts`): la hoja maestra **no
  es una lista de videos, es una discografía escrita a mano** (606 filas →
  258 artistas, 570 discos con año y tipo). `importYouTubeMasterSheet` la
  deja en `ingest.seed_uploads` y abre una revisión por cada release sin
  álbum canónico, así que el dato mejor documentado del archivo vivía como
  JSON en `review_queue` sin llegar nunca al core. Este comando lo mete por
  la puerta normal: cada fila se convierte en `RawRecord` y pasa por
  adapter → normalización → claim → ER → merge. Sale como **candidato**
  (`confidence: "low"`, `createdBy: "system"`) aunque la fuente sea `high`:
  quien escribió la hoja es una persona, pero quien la lee aquí es un
  programa, y la decisión humana se expresa después aprobando el lote. Un
  `media` (videoclip, concierto, documental) no produce álbum; un tipo
  compuesto ("Solo Artist, Studio Album") sí produce álbum pero **sin**
  `album_type`, porque lo ambiguo es el tipo, no la existencia del disco.
- `yt:link`: vinculación video→álbum existente. El barrido automático exige
  identidad exacta artista+título de un release de la hoja maestra y sólo
  entonces escribe un `full_album` primario; ausencia o más de un candidato
  abre `youtube_match`. `yt:link --album=<id> --video=<id> --note=... --confirm`
  registra una selección humana auditada. **Nunca crea álbumes.**
- `yt:enrich-artist "<artista>" [--max=N] [--dry-run]` (`src/youtube/enrich.ts`):
  último recurso para los discos del artista que siguen sin video. Un
  `search.list` restringido al `channelId` del proyecto (100 unidades, techo
  de 25 resultados), hidratación de los videos nuevos y una revisión
  `youtube_match` por disco con coincidencia exacta artista+título+año. Antes
  de gastar compara lo consumido hoy con `YOUTUBE_DAILY_QUOTA_UNITS`. Nunca
  enlaza ni crea álbumes: la selección se confirma con `yt:link --confirm`.
  Prohibido scrapear la web de YouTube.
- `yt:reconcile [--dry-run]` (`src/youtube/reconcile.ts`, PHASES E6): cruza
  lo ya hidratado con el catálogo, sin red ni cuota. Escribe
  `media.video_artists` (el artista del disco enlazado, o el de la fila de la
  hoja / el título si es exacto, incluidos alias; `subject` para
  documentales) y `media.video_tracks` (cada entrada del tracklist cuyo título
  es idéntico a una pista del disco enlazado —la posición solo desempata
  homónimas—, con fin = siguiente marca o final del video y el claim
  `youtube_start_seconds` que la respalda; un videoclip con una sola canción
  homónima en la discografía, de 0 al final). Un plan puro
  (`planReconciliation`) clasifica cada video en MATCHED_HIGH /
  MATCHED_MEDIUM / AMBIGUOUS / UNMATCHED_VIDEO / CONFLICT; las tres
  intermedias abren `youtube_match` (una por video; una descartada no se
  reabre). Nunca crea álbumes ni pistas, nunca corrige un inicio de pista
  del core, y no borra relaciones que el plan ya no deriva: las cuenta.
  Deja `reports/youtube-reconciliation.{json,md}`. Una revisión que una
  persona ya cerró (aprobada o descartada, p. ej. con `ambiguity:apply`)
  asienta su veredicto mientras la evidencia no traiga nada que esa persona no
  viera (`coversVerdict`: propuestas, entradas sin pista e inicios
  discrepantes): el video pasa a MATCHED_HIGH citando la revisión y no se
  vuelve a preguntar.
- Los tipos Music Video / Live Concert / Documentary nunca generan álbumes
  (gating en el adaptador + test obligatorio). Se registran con
  `media.video_albums.album_kind` = `music_video` / `live_concert` /
  `documentary` **solo si el álbum ya existe por otra vía**.

### 4.13 `cli`
Comandos (mismos casos de uso que la API, sin UI):
`sources:list|add|evidence`, `scrape <slug>`, `youtube import-sheet`,
`youtube sync`, `yt:link`,
`yt:enrich-artist <artist>`, `scrape source <slug> --all [--dry-run]`,
`review list|approve|dismiss`,
`review sincopa-organizations [--confirm]`,
`ambiguity:scan|resolve|apply` (§4.10),
`doctor` (integridad: core intacto, hashes, orphans de claims). `genre:add`,
`genre:disable` y `export:json` siguen especificados pero no implementados.

### 4.14 `api`
Fastify (F7): CRUD de entidades canónicas (artistas, personas, álbumes,
tracks, créditos, organizaciones) — **los writes del CRUD pasan por el merge
engine como claims `created_by=human, confidence=high`**, manteniendo
auditoría única. Endpoints de lectura para el catálogo, fuentes, review queue,
conflictos y estado de importaciones. Zod en cada ruta. Auth local simple:
lectura abierta y escritura con `Authorization: Bearer $CRV_OPERATOR_TOKEN`
(sin token configurado, solo lectura; no hay usuarios públicos en el alcance
inicial). Cada escritura es una transacción y un run `manual` de la fuente
`crv-operador` (`src/merge/operator.ts`); la cola se decide con
`POST /review-queue/:id/{accept,reject,resolve-conflict}` y el historial se
consulta en `GET /audit` y `GET /runs/:id` (PHASES §E7B).

### 4.15 `frontend` (E8/E9)
React SPA en `web/` (Vite), separada de Fastify. Solo habla con la API
(`VITE_API_BASE_URL`, por defecto `http://127.0.0.1:8080`); nunca con
PostgreSQL. `npm --prefix web run dev|build`; para publicarla bajo un prefijo,
`build:public` + `serve:public` (`web/server.mjs`: sirve `dist-public/` en
`/crv/*` y reenvía `/crv/api/*` a la API en loopback; `npm run build` escribe
`dist/` para verificación y no toca lo publicado).

---

### 4.16bis Fusiones, duplicados y búsqueda (E11)

| módulo | responsabilidad |
| --- | --- |
| `src/review/duplicates.ts` | motor de fusión (`mergeInto`): mueve referencias por clave primaria, guarda la auditoría v2, escribe la redirección y comprime la cadena |
| `src/merge/entity-merge.ts` | servicio de fusión con previsualización para persona, organización y artista; los campos comparables salen de `ENTITY_SPECS` |
| `src/merge/unmerge.ts` | `undoMergeRun`: reversión completa de un run de fusión con las precondiciones de «nada cambió desde entonces» |
| `src/merge/redirects.ts` | `resolveRedirect`: única lectura de `entity_redirects`; la capa HTTP la traduce a `404 movedTo` |
| `src/review/person-names.ts` | apodos, apellido, palabras de organización y clave de organización: una sola definición para el detector, el aviso y el plan |
| `src/review/person-candidates.ts` / `organization-candidates.ts` | detectores que PROPONEN pares con bloqueo y puntuación explicable (score + features) y abren revisiones idempotentes |
| `src/review/person-junk.ts` | `classifyPersonName`: organización, duración, fragmento o varias personas |
| `src/review/person-corrections.ts` | operaciones `merge`, `rename`, `absorb`, `to_artist`, `to_organization`, `split` sobre un plan JSON versionado, con el mismo servicio de fusión que la API |
| `src/api/search-index.ts` | índice en memoria (nombre + alias, sin tildes) con refresco **stale-while-revalidate** (auditoría 2026-09-17): una lectura con el índice vencido sirve lo que hay y dispara la recarga en segundo plano —una por tipo, con backoff—; solo bloquea el primer uso. `invalidateSearchIndex()` marca y refresca ya tras cada escritura (la base está caliente) |
| `src/api/repositories/tracks.ts` + `routes/tracks.ts` | `GET /tracks` (paginado, filtro por disco o texto en título y alias) y `GET /tracks/{id}` (contexto de disco/artista, alias propios y créditos): el CRUD de pistas era asimétrico (auditoría, hallazgo #7) |
| `src/api/routes/entity-merge.ts` | router de fusiones: las mismas rutas y esquemas para las tres entidades, más `POST /persons/:id/convert` |
| `src/api/routes/person-candidates.ts`, `merge-runs.ts` | listado de candidatos vivos y `POST /merge-runs/:runId/undo` |

Reglas que no cambian: la lectura es abierta y la escritura exige credenciales;
toda escritura pasa por `withOperatorRun` (claims humanos + auditoría) y las
consultas de comparación de nombres se hacen en TypeScript porque la base es
`SQL_ASCII` (regla 0.1.11 del plan).

### 4.16ter Detector de conflictos de Curaduría (2026-09-16)

Analiza el catálogo entero y agrupa por categoría lo que no encaja. Las reglas
no llevan listas de nombres: aprenden del propio catálogo (lugares desde
`origin_city`, palabras de rol desde los créditos, vocabulario de organización
por su peso frente a los nombres de persona, palabras de tipo de disco, nombres
de pila y apellidos, descriptores de género o serie, piezas breves, perfil de
signos y largos de cada campo).

| módulo | responsabilidad |
| --- | --- |
| `src/curation/snapshot.ts` | foto plana del catálogo (core, cola viva, conflictos abiertos, pares ya decididos y pares declarados distintos) en una sola transacción `REPEATABLE READ READ ONLY` |
| `src/curation/lexicon.ts` | léxico aprendido y perfiles por campo |
| `src/curation/detectors/*.ts` | un detector por problema; cada uno declara categoría, etiqueta y subgrupos |
| `src/curation/detectors/anomalies.ts` | «Otros»: valores que se salen del perfil de su campo y que ningún detector explica |
| `src/curation/taxonomy.ts` | categorías; una categoría o tipo de revisión desconocido cae en «otros» |
| `src/curation/analyze.ts` | corre los detectores (uno roto no apaga al resto), dice cuáles miraron el catálogo entero (`completed`), huella estable por hallazgo |
| `src/curation/scan.ts` | persiste en `ingest.curation_findings` (abierto/ignorado/resuelto), marca lo encadenado; análisis completo o dirigido a unas fichas; un análisis a la vez en el proceso y entre procesos (candado de sesión) |
| `src/curation/resolution.ts` | por qué se resolvió cada hallazgo: el ítem de lote que lo corrigió, o el run de `merge_audit` que cambió el valor |
| `src/curation/actions/types.ts`, `registry.ts` | acciones de corrección tipadas (nivel 0–3, parámetros con Zod, precondiciones, vista previa, aplicar, inversa); cada detector declara cuáles ofrece por subgrupo (`actions`) |
| `src/curation/actions/text.ts`, `merge.ts` | `limpiar_texto` (los cinco detectores con valor sugerido) y `fusionar` (fichas repetidas, y la propuesta cuando un renombrado choca) |
| `src/curation/actions/names.ts` | colisiones de nombre por `nameKey` antes de renombrar, con los renombrados del propio lote superpuestos |
| `src/curation/actions/batches.ts` | lotes de correcciones: vista previa con hash, aplicar ítem a ítem, verificación dirigida y deshacer |
| `src/merge/field-undo.ts` | diario de una corrección de campo (`withFieldJournal`) y su deshacer con CAS inverso (`undoFieldCorrections`) |
| `src/api/routes/curation-actions.ts` | `GET /curation/findings/:id/actions` y `/curation/fixes/*` (vista previa, aplicar, progreso, deshacer) |
| `src/curation/retention.ts` | poda: últimos 500 análisis y resueltos de 180 días (`crv curation prune`) |
| `src/curation/watcher.ts` | análisis tras cada escritura correcta de la API y cuando cambian los contadores del catálogo; nunca deja promesas rechazadas |
| `src/api/routes/curation.ts` | `/curation/*` (solo admin) y el gancho `onResponse` que dispara la verificación solo ante escrituras de la lista `CATALOG_WRITES` |

Encadenamiento: si un análisis resuelve un hallazgo y en la misma ficha (o en
una relacionada) aparece otro —nuevo o reabierto—, el nuevo guarda
`evidence.triggeredBy`. La web lo muestra como «apareció al corregir…».

Detectar sin mentir (PLAN_CURADURIA E1, migración 0019):

- **Solo se resuelve lo mirado.** La resolución filtra por los detectores que
  terminaron (`detector = ANY(completed)`), más los que las reglas ya no
  tienen. Si uno falla, sus hallazgos quedan intactos y el análisis queda
  `partial`; si falla uno de forma, «Otros» tampoco corre (mostraría lo que
  ese detector explica). Antes, un solo `&#xFFFFFF;` hacía lanzar a
  `entidades_html` y resolvía de golpe todos sus hallazgos.
- **Nada rechaza.** Todo lo que toca la base en `executeScan` va dentro del
  `try` (una base caída termina en `failed`), `notifyCatalogWrite` encadena
  `.catch` y `src/api/server.ts` registra `unhandledRejection`: en Node 22 una
  promesa rechazada sin manejar termina el proceso.
- **Una foto, un instante.** Las consultas de la foto (13, más 1 o 2 para los
  pares declarados distintos) comparten cliente y transacción: durante una
  ingesta, pistas y discos siempre se corresponden.
- **Un proceso a la vez.** `pg_try_advisory_lock(hashtext('crv:curation:scan'))`
  sobre la conexión del análisis (y de la poda). Si otro proceso lo tiene, el
  análisis se registra `skipped`: la verificación de una escritura se reintenta
  unas veces cada 5 s y el vigilante lo retoma en su siguiente vuelta. Un
  `--dry-run` no escribe y no toma el candado.
- **Motivo de resolución.** `fixed_by_curation` (un ítem de lote aplicado
  sobre el hallazgo desde que apareció —su run, también si una fusión retiró la
  ficha—, o el último `merge_audit` que cambió el valor detectado es de un run
  `api:curation:*` que no es un deshacer), `changed_elsewhere`
  (otra escritura auditada, o nada auditado), `entity_removed` (la ficha ya no
  está en la foto) y `rules_changed` (detector retirado, o reglas de otra
  versión sobre un valor que no cambió). `resolved_by_run_id` apunta al run
  cuando se conoce. Un cambio de reglas no cuenta como causa de encadenamiento.
- **Solo escrituras del catálogo disparan análisis**: fichas, alias, fusiones,
  conversiones, relaciones, aceptar/rechazar/resolver en la cola y deshacer un
  run. Cambiar la prioridad de una revisión ya no lanza un análisis completo.

Precisión y decisiones duraderas (PLAN_CURADURIA E2, reglas
`curation-rules.v2`, migración 0020; informe en
`docs/curation/E2_PRECISION_2026-09-16.md`):

- **Léxico más fino.** Una palabra aprendida de tipo de disco no puede estar sin
  clasificar en más de la mitad de sus discos ni ser de volumen («vol», «parte»)
  o un descriptor de género o serie («rock», «punk»: en nombres de artista, en
  títulos de disco y bastante más en títulos de disco que de pista). Solo la
  semilla permite corregir sin criterio (`evidence.wordSource`). Nombres de pila
  y apellidos aprendidos dan `isPersonShaped`: «Dan Warner» no es un sello y
  «Angel Rada» es el solista detrás del proyecto, no la banda cargada como
  persona.
- **Subgrupos nuevos** en vez de falsos positivos: `empieza_en_2`,
  `posible_estilizado`, `alias_en_nombre`, `solista_detras_del_proyecto` /
  `banda_como_persona`; «Otros» agrupa por clase Unicode y campo. Las piezas
  breves («Intro») no son duraciones atípicas; la numeración continua entre
  discos no es un hueco.
- **Huella por par.** Los duplicados se emiten por par; la huella es detector +
  tipo + id menor + id mayor, así que un tercer miembro o un renombrado no
  invalidan «no es un problema».
- **Son distintas.** `ingest.curation_distinct_pairs` entra en `handledPairs`; el
  hallazgo del par se resuelve con `declared_distinct` y no vuelve.
- **Ignorar con motivo y caducidad.** `ignore_reason` obligatorio en la API. Un
  ignorado cuyo problema desaparece pasa a `resolved` (con el motivo del
  clasificador) y conserva quién y por qué; si vuelve, vuelve abierto.
- **Historia.** `evidence.history` guarda los últimos 5 cambios de gravedad,
  título o subgrupo de un hallazgo.
- **Precisión medida.** `test/unit/curation-precision.test.ts` analiza una foto
  congelada del catálogo de desarrollo
  (`test/fixtures/curation/catalog-2026-09-16.json.gz`) contra el corpus
  etiquetado (`corpus.json`): ningún verdadero positivo perdido, ningún falso
  positivo corregido de vuelta y precisión por detector ≥ su umbral.

Correcciones como lotes (PLAN_CURADURIA E4, migración 0021). Toda corrección
—de un hallazgo, de una selección o de un grupo filtrado— recorre el mismo
ciclo: vista previa → aplicar → verificar → deshacer.

- **Acciones tipadas.** Una acción declara clave, nivel (0 seguro, 1 sugerido,
  2 asistido, 3 manual), esquema de parámetros, precondiciones, vista previa
  (antes → después, fichas tocadas, colisiones, bloqueo o propuesta), cómo se
  aplica por el motor y su inversa. Se ofrece si el detector la declara para el
  subgrupo **y** la acción aplica (`limpiar_texto` necesita valor sugerido); a
  mano solo se pide una no declarada si la acción lo acepta. Hoy hay dos:
  `limpiar_texto` (invisibles, espacios y entidades son nivel 0; reparar la
  codificación, un signo colgante que no sea « -», «,» o «/» suelto, o un valor
  escrito a mano, 1) y `fusionar` (pares de artistas, personas y organizaciones:
  1 si solo cambian tildes o mayúsculas, 2 si no).
- **Lote.** `ingest.curation_fix_batches` y `ingest.curation_fix_items`. La
  vista previa es una foto `REPEATABLE READ READ ONLY`; cada ítem guarda su
  antes → después y el hash de lo que se vio, y el lote el hash de todos. Una
  corrección individual o una selección llegan a nivel 2; un grupo, a 1; el 3
  nunca (`auto` queda para la autocorrección de E10). Varios ítems sobre la
  misma ficha y campo se encadenan: cada uno parte de lo que deja el anterior
  (reparar la codificación antes que quitar invisibles), y uno que ya no
  cambiaría nada queda cubierto por el anterior y comparte su run.
- **Aplicar.** Exige el hash del lote y una nota. Antes de escribir se vuelve a
  planificar lo pendiente sobre una foto nueva: si el hash de algún ítem
  cambió, `409 stale_preview` con `changedItemIds` y nada escrito (se vuelve a
  previsualizar o se excluyen). Después, un `withOperatorRun` por ítem
  (`api:curation:fix:<acción>`, auditoría por ficha), con candados por ficha
  (`crv:curation:fix:<tipo>:<id>`, siempre en el mismo orden), vuelve a
  bloquear y leer el hallazgo, y recalcula el hash dentro de la transacción: si
  la ficha cambió o el hallazgo ya no sigue abierto en medio del lote,
  `skipped_stale`; si falla, `failed`; ninguno detiene el lote. Hasta
  `CRV_CURATION_FIX_BATCH_MAX` ítems por llamada: el lote queda `running` y otra
  llamada igual continúa (sin la comprobación previa: cada ítem se comprueba al
  escribirse). Un candado de sesión por lote impide aplicarlo o deshacerlo desde
  dos sitios a la vez.
- **Colisiones (M6).** Antes de renombrar se buscan fichas del mismo tipo con la
  misma `nameKey` (en TypeScript: la base es `SQL_ASCII`): artistas, personas y
  organizaciones en todo el catálogo; discos del mismo artista; pistas del mismo
  disco; también los nombres que deja el propio lote. Es un aviso, salvo el
  nombre idéntico de otro artista (`artists.name` es `UNIQUE`): el ítem queda
  bloqueado (`collision`) y propone `fusionar` con los parámetros listos.
- **Verificación dirigida.** Tras aplicar o deshacer, un análisis con
  `scope = 'dirigido'` y foco en las fichas tocadas, la del hallazgo y sus
  relacionadas: analiza la foto entera pero solo guarda y resuelve lo que toca
  al foco. Los dirigidos van en cola detrás del análisis en curso y no cuentan
  como último análisis ni para el vigilante. El lote guarda en `verification`
  lo resuelto, lo nuevo y lo desencadenado. Las rutas de lotes no están en
  `CATALOG_WRITES`: no disparan el análisis completo, que el vigilante hace en
  su vuelta.
- **Deshacer (A8).** Otro lote (`mode = 'undo'`, `undo_of_batch_id`) que recorre
  lo aplicado en orden inverso, un run por corrección
  (`api:curation:undo:<acción>`). Un campo: `undoFieldCorrections` restaura el
  `old_value` exacto de `merge_audit` si el valor actual sigue siendo el
  `new_value` (CAS inverso, comparado en SQL), sin pasar por `updateEntity`
  —que normalizaría justo el texto que se limpió—, y con el diario que
  `withFieldJournal` guardó en el run retira el alias que añadió el renombrado,
  devuelve el estado de los claims, conflictos y revisiones que la corrección
  cerró, deja `superseded` sus claims (no se borran) y descarta lo que abrió.
  Una fusión: `undoMergeRun`, que ahora retira el alias de fusión de toda ficha
  con nombre (antes solo de personas) y devuelve los alias primarios del
  duplicado (`primaryAliases` en la auditoría desde 0021). Si algo cambió
  después, el ítem de deshacer queda `skipped_stale`, la corrección
  `not_undoable` con el motivo, y el resto se deshace igual. Deshacer no es
  corregir: no resuelve nada como `fixed_by_curation`.
- **Alias obsoletos.** `POST /curation/findings/:id/fix`, `fix-selected` y
  `fix-group` se mantienen una versión: previsualizan y aplican en la misma
  llamada un lote de `limpiar_texto` y responden con la forma de E3. La web los
  sigue usando hasta E8.

### 4.16quater Acciones de texto y estructurales (E5–E6, 2026-09-17/18)

Cierra A1 para lo que toca un campo y para lo que toca relaciones o entidades.
Sobre el marco de E4 (tipos, lotes, hash, verificación dirigida y deshacer):

| módulo | responsabilidad |
| --- | --- |
| `src/curation/actions/textual.ts` | 15 acciones de texto: `decodificar_html`, `reparar_codificacion`, `reparar_cp1251`, `sustituir_homoglifos`, `restaurar_letra`, `quitar_signo_huerfano`, `cerrar_signo`, `recortar_extremos`, `capitalizar`, `dominio_a_alias`, `quitar_prefijo_artista`, `quitar_rotulo`, `separar_palabras`, `mover_region` (con colisión) y `renombrar_con_alias` (conserva el dato como alias dentro del mismo run para que el deshacer lo retire) |
| `src/curation/actions/structural.ts` | 20 acciones estructurales: extraer intérprete/invitado/autores, mover duración, convertir a organización/artista, vincular como miembro, dividir persona, retirar con créditos o huérfana, fusionar discos, retirar pista duplicada, fijar tipo, vaciar año/duración, corregir unidades y `renumerar_consecutivo` en dos fases (desplaza +1000 y fija el valor final en la misma transacción: el core exige `track_number > 0`) |
| `src/merge/album-merge.ts` | fusión de discos con vista previa y hash determinista: empareja pistas por (disco, número) y por título normalizado, unifica créditos y formatos equivalentes, reubica las pistas sueltas y repunta enlaces de medios; la auditoría va con `version: 2`, compatible con `undoMergeRun` |
| `src/merge/structural-undo.ts` | deshacer de retiros y relaciones creadas por las acciones |
| `GET /albums/:id/merge-preview`, `POST /albums/:id/merge`, `POST /persons/:id/split` | las rutas de la fusión de discos y la división de personas (reparto de créditos con vista previa) |
| `crv curation scan --dry-run` | informa la cobertura por niveles de acción (nivel 0/1/2/manual) por categoría antes de aplicar nada |

Las acciones siguen la regla «IA propone, nunca ejecuta»: cada una declara sus
precondiciones, su nivel y su inversa, y no escribe nada fuera de los servicios
auditados (`withOperatorRun`, `mergeInto`, `removeEntity`).

### 4.17 Desviaciones conocidas

- `public.albums.label_id` es la única FK del catálogo sin índice (auditoría
  2026-09-17). No se corrige desde aquí: el core canónico (`public`) es
  inmutable por contrato y `doctor` verifica su huella objeto por objeto, así
  que añadirlo exige regenerar `core:catalog` con aprobación del propietario.

## 5. Flujo de datos end-to-end

```
1. FETCH      fetcher + cache          → raw HTML en disco + raw_pages
2. EXTRACT    scraper adapter          → RawRecord (Zod)
3. NORMALIZE  normalization            → NormalizedClaim
4. RESOLVE    entity resolution        → core_id o propuesta de entidad
5. CLAIM      claims + evidence        → ingest.claims (dedupe por hash)
6. MERGE      merge engine             → core (high/medium-ok) o review (resto)
7. CONFLICT   conflict engine          → conflictos conservados + review
8. AUDIT      audit_log                → trazabilidad de cada cambio
```

El seed YT sigue el mismo flujo saltando 1-2 (el "raw" es la fila XLSX).

---

## 6. Configuración, logs y errores

- Config por variables de entorno + archivo `config/` (Zod): `DATABASE_URL`,
  `PORT`, `YOUTUBE_API_KEY`, `DEEPSEEK_API_KEY`,
  `DEEPSEEK_MODEL_FAST|REASONING|VISION`, `DATA_DIR`,
  `CRAWL_*` (timeouts, TTLs, delays), `REVIEW_*`.
- Pino: logs JSON a stdout; `doctor`/CLI muestran resúmenes.
- Errores de fetch/scrape se registran por recurso en `ingest.scrape_errors`;
  `scrape_runs` queda `partial` y conserva checkpoint + URLs pendientes en
  `params`. El resto de la cola continúa y el siguiente run reanuda los huecos.

---

## 7. Tests (Vitest)

- **Contract tests del core:** aplicar `crv_simple_v1.sql` a `crv_test` y
  hacer snapshot de catálogo (tablas/columnas/enums/vistas) comparado contra
  el SHA del archivo → el core nunca se altera sin que la suite grite.
  Ya existe una realización de esta prueba en `tests/run_all.sh`: levanta un
  PostgreSQL 16 desechable, aplica el core, migra, y exige que el diff de
  `pg_dump --schema=public --schema-only` antes/después sea **vacío**
  (también tras el rollback completo). `tests/test_0004_review_kinds.sh`
  cubre además la migración de enums, y `tests/lib_pg.sh` comparte el arranque
  del contenedor. **Portado a Vitest (F0):**
  `test/contract/core-and-schema.test.ts` reproduce ese mismo contrato
  (core + todas las migraciones, hoy 0001–0022, vía `src/db/migrate.ts` + rollback + diff
  vacío) contra un contenedor propio (`test/support/pg-container.ts`, mismo
  arranque en dos fases que `tests/lib_pg.sh`), y añade el ejercicio real
  del schema Drizzle: inserts y joins a través de `public`+`ingest`+`media`
  con FKs y enums reales (artist→album→track, source→claim→evidence,
  video↔album N:N con enlace primario, review_queue con un kind de 0004).
  El harness bash original se conserva (no depende de Node).
- **Idempotencia:** cada importación ejecutada 2 veces → conteos idénticos
  (fixtures golden de los dos XLSX reales, versionados en `test/fixtures/`).
- Unit: normalización, tokenización de tipos, extracción de video IDs,
  merge por confianza, conflictos, gating de videos (no-album).
- Integración: PG de test con contenedor o instancia local `crv_test`.
- **CI (auditoría 2026-09-17, hallazgo #3):** `.github/workflows/ci.yml` corre
  en cada push a `master` y cada PR tres puertas — calidad (typecheck + lint +
  unitarias con cobertura v8 y umbral en `vitest.config.ts`, informe como
  artefacto), contratos (PostgreSQL desechable por archivo) y build de la web.
  `npm run test:coverage` reproduce la puerta de calidad en local.
  `test:matrix` y `test:deepseek:real` siguen siendo verificación manual.

---

## 8. Despliegue (una sola máquina)

- Un proceso Node (`tsx`/compilado) sirve API; CLI se invoca ad-hoc o vía
  cron del SO para barridos programados.
- PostgreSQL local; `data/` en volumen. Respaldo con `npm run db:backup`
  (`pg_dump` custom + `data/raw` + manifest + SHA-256), prueba con
  `npm run db:restore-check` y restauración sin sobrescribir con
  `npm run db:restore` (`docs/DATABASE_BACKUP_RESTORE.md`). Los tres scripts
  usan `docker exec` contra el contenedor de PostgreSQL.
- Arranque con systemd (o PM2 si el usuario lo prefiere); nada más.

---

## 9. Decisiones explícitas de simplicidad

- No hay worker pool: el scraping masivo es un proceso CLI secuencial con
  concurrencia por dominio = 1 (fuentes pequeñas; 1 máquina alcanza).
- No hay búsqueda full-text propia: LIKE + índices PG son suficientes para el
  catálogo; si el frontend necesita búsqueda, se evalúa `pg_trgm` (extensión
  de PG, sin infraestructura nueva).
- No hay cola externa: `ingest.review_queue` es una tabla.
- No hay copias de datos fuera de PG salvo el HTML crudo (por diseño).
