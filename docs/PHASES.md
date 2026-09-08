# CRV — Plan de fases

> Cada fase tiene objetivo, entregables, criterios de salida y dependencias.
> Las fases son secuenciales salvo indicación. Ninguna fase modifica el core
> (`crv_simple_v1.sql`): las migraciones posteriores solo tocan el esquema
> `ingest`.
>
> Estado actual (2026-09-07): **F0 en curso, base de aplicación lista**.
> Node 22 LTS instalado (vía nvm; ver nota abajo) y verificado como
> `>=22.0.0` en `package.json`. Repositorio git inicializado con
> `.gitignore` cubriendo secretos, `node_modules`, `data/raw` y salidas
> generadas. Proyecto Node/TS estricto creado (`package.json`, `tsconfig.json`
> strict) con la estructura de módulos de ARCHITECTURE.md §4
> (`src/config`, `src/logger`, `src/db/schema`, `src/fetcher`, `src/cache`,
> `src/storage`, `src/adapters`, `src/normalization`, `src/er`, `src/claims`,
> `src/merge`, `src/conflicts`, `src/review`, `src/ai`, `src/youtube`,
> `src/cli`, `src/api`, `src/doctor`). Drizzle ORM modela por completo
> `public`/`ingest`/`media` (`src/db/schema/`, solo lectura tipada del core;
> el DDL real sigue siendo `migrations/*.sql`), con un runner propio
> (`src/db/migrate.ts`) que conserva `ingest.schema_migrations`. `doctor`
> (`src/doctor/`) verifica hash+catálogo del core, schemas auxiliares,
> migraciones aplicadas y estado de fuentes — verificado en verde contra
> PostgreSQL 16 real. `tests/run_all.sh`/`test_0004_review_kinds.sh` ahora
> verifican también el hash del core como paso 0
> (`crv_simple_v1.sql.sha256` + `verify_core_hash()`), cerrando el hallazgo
> de CONTRACT §11.2. Puerto a Vitest iniciado:
> `test/contract/core-and-schema.test.ts` reproduce el contrato completo
> (core + 0001-0004 + rollback, diff de `pg_dump` vacío) **y** ejercita el
> schema Drizzle real (inserts/joins a través de core+ingest+media),
> contra un contenedor desechable levantado por `test/support/pg-container.ts`.
> **Falta:** `sources` sembradas desde el XLSX, `fetcher`/`cache`/raw storage
> (F1), y el resto de comandos de CLI (F1+).
>
> Nota de entorno: la máquina no tenía Node 22 en el PATH por defecto (solo
> Node 20 vía `nodesource`), pero sí tenía un Node 22.23.1 ya instalado por
> `nvm` sin activar; se corrigió el orden de `~/.bashrc` para que los shells
> interactivos usen Node 22 automáticamente. No requirió `sudo`.

---

## F0 — Bootstrap y contrato del core

**Objetivo:** dejar el repositorio, la base y el core canónico verificados.

Entregables:
- ✅ *Ya hecho:* **Node 22 LTS** activo (nvm, ver nota de entorno arriba).
- ✅ *Ya hecho:* Repositorio git inicializado (`.gitignore` con secretos,
  `node_modules`, `data/raw`, salidas generadas).
- ✅ *Ya hecho:* Repo de la app (Node 22 + TS strict + Vitest + Pino),
  estructura de módulos según ARCHITECTURE.md §4 (`src/*`).
- ✅ *Ya hecho:* Migración baseline = `crv_simple_v1.sql` aplicado
  **verbatim** (hash `b7e7d35a…` en `crv_simple_v1.sql.sha256`; verificado
  por `verify_core_hash()` en el harness bash **y** por `doctor` y el
  contract test de Vitest en cada ejecución).
- ✅ *Ya hecho:* schemas `ingest` + `media` con `sources`, `raw_pages`,
  `scrape_runs`, `scrape_errors`, `seed_uploads`, `genres`, `claims`,
  `claim_evidence`, alias ×5, `conflicts`, `review_queue`, `merge_audit`,
  `youtube_videos`, `video_albums/artists/tracks`, `media_links`
  (migraciones `0001–0003`).
- ✅ *Ya hecho:* migración **`0004_review_kinds`**, que extiende
  `ingest.review_kind` con `missing_url`, `seed_incomplete`,
  `media_type_no_album`, `genre_unknown`, `new_source`, `low_confidence`,
  `ai_biography`, `ai_entity_resolution` (CONTRACT §11.1). Sin ella, F2 no
  podía cumplir sus criterios.
- ✅ *Ya hecho:* Drizzle ORM como runner de migraciones
  (`src/db/migrate.ts`), conservando `ingest.schema_migrations`; el DDL
  real sigue en `migrations/*.sql` (justificación en el propio archivo).
  Schema Drizzle completo (`src/db/schema/`) para `public` (solo lectura
  tipada), `ingest` y `media`.
- ✅ *Ya hecho:* `doctor` (`src/doctor/`, `npm run doctor`): verifica
  integridad del core (hash/catálogo), schemas auxiliares, migraciones
  aplicadas y estado de fuentes.
- ✅ *Ya hecho (parcial):* Puerto a Vitest —
  `test/contract/core-and-schema.test.ts` reproduce el contrato de
  `tests/run_all.sh` (core + 0001-0004 + rollback, diff de `pg_dump` vacío)
  contra un contenedor desechable propio (`test/support/pg-container.ts`),
  y además ejercita el schema Drizzle real (inserts/joins). El harness bash
  original se conserva tal cual (no depende de Node).

Criterios de salida: `doctor` en verde (✅ verificado); contract-tests del
core en verde, diff de `public` vacío (✅ verificado, bash y Vitest); base
`crv_test` desechable y reproducible (✅ vía `test/support/pg-container.ts`
y `tests/lib_pg.sh`).

---

## F1 — Registro de fuentes + fetcher + almacenamiento crudo

**Objetivo:** poder descargar, cachear y conservar HTML crudo de cualquier
fuente autorizada sin interpretarlo.

Entregables:
- Seed de `ingest.sources` desde `Links for Data Scrapping.xlsx` (11 filas,
  `enabled=false` salvo aprobación) + `youtube_data_api` + seeds internos.
- `fetcher` (robots, cortesía, backoff, TTL) y `cache`.
- Storage crudo en `data/raw/` + `ingest.raw_pages`.
- CLI `sources:list` / `sources:add` (crea `new_source` en review, nunca
  habilita directo) / `scrape --observe` (solo descarga, sin extracción).

Criterios de salida: barrido de observación completo sobre 1 fuente Blogger
de prueba; re-descarga dentro del TTL = 0 peticiones nuevas (cache
verificada).

---

## F2 — Importación del seed YT (catálogo audiovisual inicial)

**Objetivo:** convertir `YT Master Spreadsheet.xlsx` en claims + entidades,
con Upload Order preservado.

Entregables:
- `ingest.seed_uploads` + importador idempotente (hash por fila, run).
- Extracción de `video_id` (watch?v= / youtu.be) y `media.youtube_videos`.
- Flujo completo según DATA_MODEL.md §5-6: creación de artistas/álbumes por
  tipo; gating de Music Video/Live Concert/Documentary (no crean álbum);
  filas EMPTY y sin URL → review (`seed_incomplete`, `missing_url`).
- `merge:run` funcional para claims high del seed.

Criterios de salida: importación ejecutada 2 veces → conteos idénticos;
matriz de tipos cumplida (ver acceptance `caramelos-las-paticas.md`);
`ingest.merge_audit` con trazabilidad completa; cola de revisión poblada con
las 88 filas anómalas esperadas (86 `missing_url` + 2 `seed_incomplete`), los
**7 pares duplicados reales** y las 2 colisiones de nombre de artista
(`Soleà `/`Soleà`, `Pacifica`/`Pacífica`); el conflicto interno de año de
`Metrozubdivision / CCS` (2007 vs 2006) registrado conservando ambas
afirmaciones.

---

## F3 — YouTube Data API (sincronización y enriquecimiento)

**Objetivo:** datos de YouTube de primera clase sin tocar la web de YouTube.

Entregables:
- `yt:sync` (videos.list por IDs en lotes de 50 → ~11 llamadas para los 520
  IDs; snapshot crudo en `media.youtube_videos.metadata`; claims de
  disponibilidad).
- `yt:link` (propuestas de vínculo video→álbum → review).
- `yt:enrich-artist` (search.list acotado, modo dirigido, presupuesto de
  cuota por artista).
- Rate limiting de cuota + caché.

Criterios de salida: sync completa sobre los 520 IDs (lotes, reintentos);
disponibilidad proyectada en `albums.youtube_status` solo para videos con
enlace primario en `media.video_albums`; ningún álbum creado por videos
(test); conteo de `albums` idéntico antes y después del sync.

---

## F4 — Scrapers por fuente

**Objetivo:** extracción masiva por fuente y dirigida por artista.

Orden revisado por **valor confirmado** en la auditoría del 2026-09-07
(SOURCES.md §3), no solo por costo:

1. Adapter `legacyFrameset` → **sincopa.com**. Promovido al primer puesto:
   es la única fuente verificada que aporta `persons`, `artist_members` (rol
   + años), `organizations` (sellos) y `albums.label_id` — datos que el seed
   de YouTube no puede dar. 337 fichas de artista + 290 de disco en rock/pop.
   Requisito duro: **decodificar windows-1252** antes de normalizar.
2. Adapter `blogger` sobre el **feed** `/feeds/posts/default` (Atom/JSON) →
   las 5 fuentes Blogspot, 4.922 entradas. Incluye **filtro de pertinencia**:
   estos blogs publican también material no venezolano.
3. Adapter `wordpressCom` → coleccionistasderockvenezolano (92 posts, API
   pública de WordPress.com).
4. Adapter `wordpress` → punkenvenezuela.com (**recorrer `pages`: tiene 0
   posts y 17 páginas**) y rockhechovenezuela.com (4 posts + 6 páginas;
   rendimiento esperado bajo, contenido dentro de Elementor).
5. `manualOnly` → Instagram Hemeroteka (entrada manual asistida; sin barrido).
6. Deska: registrada pero `enabled=false` (HTTP 402 confirmado dos veces).

Entregables transversales: escribir en `ingest.sources.access_strategy` el
canal confirmado de cada fuente; caracterizar la estructura interna de los
posts (lo único que la sonda no pudo confirmar). Playwright: **no se
incorpora**, ninguna fuente activa lo requiere.

Criterios de salida: Sincopa produciendo claims de miembros y sellos con
evidencia (excerpt+selector+url) y acentos correctos tras la decodificación;
al menos 2 fuentes Blogger produciendo claims con evidencia; ninguna fuente
no autorizada scrapeada.

---

## F5 — Entity resolution, merge y conflictos (núcleo del sistema)

**Objetivo:** el pipeline completo con el merge híbrido gobernado por
confianza.

Entregables:
- ER determinista (normalize → alias → fuzzy → asistencia opcional).
- `merge engine` con advisory locks e idempotencia por entidad.
- `conflict engine` + `ingest.conflicts` (conservación de ambas afirmaciones).
- `review_queue` operativa con CLI (`review:list|approve|dismiss`).
- Regla dura verificada: crédito de álbum ≠ membresía.

Criterios de salida: merge del seed + 2 fuentes Blogger con 0 duplicados
(re-run idéntico); conflictos reales conservados con evidencia doble; una
resolución de conflicto de muestra ejecutada y auditada.

---

## F6 — DeepSeek gateway

**Objetivo:** IA puntual, auditable y opcional.

Entregables:
- Gateway Zod-contract + `ingest.ai_runs` (prompt_hash cache).
- Casos: ER ambiguo (sugerencia), extracción narrativa de biografías largas
  (`ingest.ai_biographies`, draft), triage de conflictos.
- Presupuestos por run; el sistema funciona con IA desactivada.

Criterios de salida: 3 casos de uso cubiertos con salida validada por Zod;
ninguna escritura al core atribuida a `ai` con confianza superior a `low`
sin aprobación; caché de prompts verificado (mismo prompt → 1 llamada).

---

## F7 — API + CLI operativa

**Objetivo:** CRUD controlado y operación por terminal.

Entregables:
- Fastify: CRUD canónico (escribe vía merge engine como claims
  `created_by=human, confidence=high`), lectura de catálogo, review,
  conflictos, fuentes, estado de runs.
- Zod en rutas; auth local de operador; swagger.
- CLI completa (`doctor` incluido).

Criterios de salida: CRUD de artista/álbum con auditoría; una corrección
manual de un dato conflictivo resuelve el conflicto y conserva historial.

---

## F8 — Frontend (futuro)

**Objetivo:** interfaz de consulta y revisión (React SPA servida por la
misma app).

Entregables: catálogo (artista → álbum → tracks → créditos), detalle con
evidencias, cola de revisión, gestión de géneros/fuentes.

Criterios de salida: navegación completa del catálogo; aprobación de un
item de review desde la UI. El navegador solo habla con la API (regla de
oro §2 de ARCHITECTURE.md).

---

## F9 — Endurecimiento y documentación

**Objetivo:** garantías operativas.

Entregables: backups (pg_dump + rsync de `data/raw`), guía de recuperación,
verificación de cuotas/limites, docs actualizadas (DATA_MODEL, SOURCES con
hallazgos de F4), suite de idempotencia completa sobre fixtures golden.

Criterios de salida: restauración desde backup probada; `doctor` y suite
completa en verde en la máquina de producción.
