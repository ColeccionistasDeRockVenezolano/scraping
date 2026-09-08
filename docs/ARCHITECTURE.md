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
| Navegación | Playwright | **solo cuando la fuente lo exija**. Verificado 2026-09-07: **ninguna fuente activa lo requiere**; la única que necesita JS (Instagram) es de uso manual, no automatizado |
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
- Respeto de `robots.txt` (cache en `ingest.raw_pages.meta`/disco).
- Límite de concurrencia por dominio (1) y demora mínima entre peticiones (1 s).
- Salida: HTML crudo + cabeceras + código → entrega a `raw storage`.

### 4.2 `cache`
Doble nivel: (a) `ingest.raw_pages` con UNIQUE(source_id, url) — si la página
ya se descargó y no venció (TTL por fuente, default 7 días para páginas
estáticas), se reutiliza; (b) caché de `robots.txt` y de respuestas de la
YouTube Data API (`media.youtube_videos.metadata`) con TTL propio. Ninguna descarga repetida
del mismo URL dentro de un run.

### 4.3 `raw source storage`
- HTML crudo en disco: `data/raw/<source-slug>/<sha256>.html` (+ cabeceras en
  JSON adyacente). Hash = identidad de contenido.
- Fila `ingest.raw_pages` con metadatos (url, final_url, http_status,
  content_type, sha256, fetched_at).
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
Adapters previstos, con el canal **verificado el 2026-09-07** (SOURCES.md §3):

| Adapter | Fuentes | Canal de acceso confirmado |
|---|---|---|
| `blogger` | las 5 Blogspot | Feed nativo `/feeds/posts/default` (Atom o `?alt=json`), con `openSearch:totalResults` y paginación. **4.922 entradas** en total |
| `wordpress` | rockhechovenezuela.com, punkenvenezuela.com | WP REST `/wp-json/wp/v2/`. **Debe recorrer `pages` además de `posts`**: punkenvenezuela tiene 0 posts y 17 páginas |
| `wordpressCom` | coleccionistasderockvenezolano | API pública `public-api.wordpress.com` (92 posts) |
| `legacyFrameset` | sincopa.com | Frameset estático desde `vertical.htm` → índices por género → fichas. **Decodificar windows-1252 antes de normalizar** |
| `manualOnly` | Hemeroteka (Instagram) | Sin acceso anónimo (app JS). Entrada manual como claims `created_by='human'` |
| `shopifyCatalog` | Deska | Inactivo: HTTP 402 |

- Regla: si la fuente ofrece feed/API estructurada, el adapter la usa **antes**
  que el HTML renderizado; el HTML crudo se conserva igual como evidencia.
- Todo adapter emite `RawRecord` (JSON crudo tipado con Zod) → normalización.
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
→ fuzzy (trigram / Jaro-Winkler sobre candidatos indexados) → si ambigüedad
persiste: DeepSeek asistido (opcional, §7) o review_queue.
Cada decisión de ER se guarda como claim (`entity_kind` + field `identity`)
para que sea auditable y reversible. Resultado: `core_id` resuelto o entidad
nueva propuesta.

### 4.7 `claims / evidence`
Capa de persistencia de afirmaciones: `ingest.claims` (dedupe por
el índice `claims_dedupe_uk`) y `ingest.claim_evidence`
(fragmento + selector + URL + hash). Ningún dato cruza al core sin claim.

### 4.8 `merge engine` — único escritor del core
- Política híbrida por confianza (ver CONTRACT §merge):
  high→aplica; medium→solo info nueva no conflictiva; conflicto→review;
  low→nunca escribe core (el claim queda `candidate`).
- Escribe bajo `pg_advisory_xact_lock` con clave determinista por entidad
  (DATA_MODEL.md §6) → idempotencia incluso en ejecuciones concurrentes.
- Regla dura: **un crédito de álbum jamás inserta `artist_members`**.
- Cada write deja entrada en `ingest.merge_audit` (+ `merge_audit_claims`:
  qué claims respaldan la escritura).

### 4.9 `conflict engine`
Detecta dos claims aceptables que afirman valores distintos para el mismo
campo de la misma entidad: crea `ingest.conflicts` (ambos valores + ambas
evidencias), suspende el campo en core y abre `review_queue(conflict)`.
Resoluciones: a, b, both_kept (se registra el dato múltiple en notas/alias),
dismissed.

### 4.10 `review queue`
Fuente única de trabajo humano (`ingest.review_queue`, con FKs reales a las
entidades implicadas). 16 kinds realizados: de 0003 `possible_duplicate`,
`field_conflict`, `ambiguous_alias`, `album_match`, `person_match`,
`organization_match`, `youtube_match`, `manual_review`; de 0004
`missing_url`, `seed_incomplete`, `media_type_no_album`, `genre_unknown`,
`new_source`, `low_confidence`, `ai_biography`, `ai_entity_resolution`.
Consumida por CLI (`review:list|approve|dismiss`) y por la futura UI (F8).

### 4.11 `deepseek gateway`
Único punto de contacto con la IA. Contrato estricto (Zod in/out), registro
en `ingest.ai_runs` con `prompt_hash` (caché: mismo prompt = mismo resultado
reutilizado, ahorro de coste e idempotencia). Usos permitidos **solo**:
(1) resolución de ambigüedad en ER, (2) extracción narrativa compleja
(biografías largas → `ingest.ai_biographies` draft), (3) triage de conflictos
(sugerencia, nunca decisión), (4) normalización de créditos muy desordenados.
**Nunca** como extractor universal ni como fuente primaria de datos
estructurados. Config: key/model/temperatura por env; presupuesto de tokens
por run configurable; sin IA activa = el sistema funciona igual (rutas
deterministas).

### 4.12 `youtube ingestion`
- `yt:seed-import`: importa el XLSX a `ingest.seed_uploads` (verbatim) y
  extrae `video_id` (watch?v=, youtu.be/, ignorando `&t=`/`&pp=` para el ID).
- `yt:sync`: YouTube Data API `videos.list` sobre IDs registrados →
  `media.youtube_videos` (título, canal, fecha, duración, disponibilidad) y
  claims de disponibilidad hacia `albums.youtube_status` solo cuando el video
  tiene enlace primario a un álbum. Hasta 50 IDs por llamada: los 520 IDs
  conocidos se cubren en ~11 llamadas.
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
`sources:list|add`, `scrape <slug>`, `seed:import-yt`, `yt:sync`,
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
  `PORT`, `YOUTUBE_API_KEY`, `DEEPSEEK_API_KEY|MODEL`, `DATA_DIR`,
  `CRAWL_*` (timeouts, TTLs, delays), `REVIEW_*`.
- Pino: logs JSON a stdout; `doctor`/CLI muestran resúmenes.
- Errores de fetch/scrape jamás abortan el run: se registran en
  `import_runs.error_log` y la fila queda `failed` para reintento; el resto
  del lote continúa.

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
  (core + migraciones 0001-0004 vía `src/db/migrate.ts` + rollback + diff
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
