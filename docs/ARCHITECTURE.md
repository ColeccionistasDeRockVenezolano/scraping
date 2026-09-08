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
- **Playwright solo se incorpora como adapter opcional** si una fuente lo
  exige tras verificación en F4. Verificado hoy: **ninguna fuente activa lo
  requiere**; ninguna de las 9 fuentes accesibles necesita JS.

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
Consumida por CLI (`review:list|approve|dismiss`) y por la futura UI (F8).

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
Sin API key el sistema y toda la suite funcionan con rutas deterministas/mock.

### 4.12 `youtube ingestion`
- `yt:seed-import`: importa el XLSX a `ingest.seed_uploads` (verbatim) y
  extrae `video_id` (watch?v=, youtu.be/, ignorando `&t=`/`&pp=` para el ID).
- `yt:sync`: YouTube Data API `videos.list` sobre IDs registrados →
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
- `yt:link`: vinculación video→álbum existente (match artista+título+año)
  escribiendo en `media.video_albums`; las propuestas van a revisión.
  **Nunca crea álbumes.**
- `yt:enrich-artist`: `search.list` acotado (máx. N resultados, bajo cuota)
  solo en modo dirigido. Prohibido scrapear la web de YouTube.
- Los tipos Music Video / Live Concert / Documentary nunca generan álbumes
  (gating en el adaptador + test obligatorio). Se registran con
  `media.video_albums.album_kind` = `music_video` / `live_concert` /
  `documentary` **solo si el álbum ya existe por otra vía**.

### 4.13 `cli`
Comandos (mismos casos de uso que la API, sin UI):
`sources:list|add|evidence`, `scrape <slug>`, `seed:import-yt`, `yt:sync`,
`yt:enrich <artist>`, `merge:run [--dry]`, `review:list|approve|dismiss`,
`genre:add|disable`, `export:json <entidad>`, `doctor` (integridad:
core intacto, hashes, orphans de claims).

### 4.14 `api`
Fastify (F7): CRUD de entidades canónicas (artistas, personas, álbumes,
tracks, créditos, organizaciones) — **los writes del CRUD pasan por el merge
engine como claims `created_by=human, confidence=high`**, manteniendo
auditoría única. Endpoints de lectura para el catálogo, fuentes, review queue,
conflictos y estado de importaciones. Zod en cada ruta. Auth local simple
(fase F7 define token de operador; no hay usuarios públicos en el alcance
inicial).

### 4.15 `frontend` (futuro, F8)
React SPA servida por Fastify (static) en la misma app. Solo API. Vistas:
catálogo (artista/álbum/track), detalle con evidencias, cola de revisión,
géneros y fuentes. Fuera del alcance de esta fase.

---

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
  (core + migraciones 0001-0007 vía `src/db/migrate.ts` + rollback + diff
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

---

## 8. Despliegue (una sola máquina)

- Un proceso Node (`tsx`/compilado) sirve API; CLI se invoca ad-hoc o vía
  cron del SO para barridos programados.
- PostgreSQL local; `data/` en volumen con respaldo simple (pg_dump + rsync
  de `data/raw`). Sin Docker obligatorio; si se usa, solo PG en contenedor.
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
