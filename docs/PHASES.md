# CRV — Plan de fases

> Cada fase tiene objetivo, entregables, criterios de salida y dependencias.
> Las fases son secuenciales salvo indicación. Ninguna fase modifica el core
> (`crv_simple_v1.sql`): las migraciones posteriores solo tocan el esquema
> `ingest`.
>
> Estado actual (2026-09-08): **F0 cerrado y endurecido, F1 completo**.
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
> (core + 0001-0007 + rollback, diff de `pg_dump` vacío) **y** ejercita el
> schema Drizzle real (inserts/joins a través de core+ingest+media),
> contra un contenedor desechable levantado por `test/support/pg-container.ts`.
> **F0 cerrado.** **F1 completo también:** `ingest.sources` sembrado (14
> filas), `fetcher`+`cache`+storage crudo implementados y **verificados en
> vivo** contra `rhv-blogspot` (264 entradas reales, TTL confirmado con 0
> peticiones nuevas en la re-descarga) — ver detalle en la sección F1 más
> abajo. **Falta:** el resto de comandos de CLI de F2+ (`seed:import-yt`,
> `yt:*`, `merge:run`, `review:*`, `genre:*`, `export:json`). El núcleo de
> **F5/F6** sí está implementado: ER tipada para cinco entidades, merge y
> conflictos auditados, review programática, gateway DeepSeek opcional y
> biografías separadas. Los criterios globales de F5 que dependen del seed y
> dos barridos Blogger siguen pendientes y no se declaran cerrados aquí.
>
> Nota de entorno (actualizada 2026-09-08): la máquina no tenía Node 22 en el
> PATH por defecto (solo Node 20 vía `nodesource`), pero sí un Node 22.23.1
> instalado por `nvm` sin activar. La corrección de `~/.bashrc` solo arreglaba
> los shells **interactivos**: bash no lee `~/.bashrc` en shells no
> interactivos, así que cron, CI, hooks de git y agentes seguían resolviendo
> Node 20 en silencio contra `engines.node: >=22.0.0`. La solución vive ahora
> en el repo y no en el dotfile: `.nvmrc`, `.npmrc` (`engine-strict=true`),
> `scripts/with-node22.sh` (por el que pasan todos los scripts npm) y
> `assertSupportedNode()` en `src/config/runtime.ts`. No requirió `sudo`.

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
- ✅ *Ya hecho:* **Arranque reproducible** — `docker-compose.yml`
  (PostgreSQL 16 local en el puerto 5433, para no chocar con otro PostgreSQL
  de la máquina) y `npm run db:bootstrap` (`scripts/db-bootstrap.sh`), que de
  cero deja `doctor` en verde: crea `.env` desde `.env.example`, verifica el
  hash del core, levanta la base, aplica el core **verbatim** solo si falta,
  migra, siembra `ingest.sources` y corre `doctor`. Idempotente.
- ✅ *Ya hecho:* **Guardia de runtime** — `.nvmrc` + `.npmrc`
  (`engine-strict=true`) + `scripts/with-node22.sh` + `assertSupportedNode()`
  (`src/config/runtime.ts`), invocada por el CLI, por el runner de migraciones
  y por el chequeo `runtime.node` de `doctor`. Cierra el hallazgo de
  CONTRACT §11.2: las ejecuciones **no interactivas** ya no pueden correr con
  Node 20 en silencio.
- ✅ *Ya hecho:* **Huella del catálogo core** (`src/doctor/core-catalog.json`,
  178 objetos: enums con labels, columnas con tipo/NOT NULL/identidad/default,
  vistas con definición, constraints e índices). `doctor` la compara entrada
  por entrada contra la base viva, de modo que un `ALTER` manual sobre
  `public` se detecta aunque los conteos (7/10/3) sigan cuadrando.
  Regenerable con `npm run core:catalog`; validada por mutación en
  `test/contract/core-catalog.test.ts`.
- ✅ *Ya hecho:* **Matriz de PostgreSQL** — `npm run test:matrix`
  (`scripts/test-pg-matrix.sh`) ejecuta el harness contra `postgres:15-alpine`
  y `postgres:16-alpine`; el contrato exige "PostgreSQL 15+" y hasta ahora
  solo se probaba 16 por defecto. Ambas en verde.
- ✅ *Ya hecho:* **Documentación reconciliada con el DDL** — `DATA_MODEL.md`
  §4.2/§4.3/§4.5/§4.6/§4.7/§4.8/§4.12/§4.13/§4.15 reescritas contra
  `migrations/*.up.sql` (el caso material: §4.2 decía
  `UNIQUE(source_id, url)`; el real es `UNIQUE(source_id, sha256)`, dedupe por
  contenido); §4.11/§4.14 actualizadas con la realización de F6 en 0007;
  `docs/db/ER_INGEST_MEDIA.md` actualizado al conjunto vigente de migraciones.
- ✅ *Ya hecho (parcial):* Puerto a Vitest —
  `test/contract/core-and-schema.test.ts` reproduce el contrato de
  `tests/run_all.sh` (core + 0001-0007 + rollback, diff de `pg_dump` vacío)
  contra un contenedor desechable propio (`test/support/pg-container.ts`),
  y además ejercita el schema Drizzle real (inserts/joins). El harness bash
  original se conserva tal cual (no depende de Node).

Criterios de salida: `doctor` en verde (✅ verificado — **desde cero con
`npm run db:bootstrap`**, sin configuración manual); contract-tests del core
en verde, diff de `public` vacío (✅ verificado, bash y Vitest, PostgreSQL 15
y 16); base desechable y reproducible (✅ vía `test/support/pg-container.ts`,
`tests/lib_pg.sh` y `docker-compose.yml`).

Estado de la suite (2026-09-08): `npm test` = **103 tests en 13 archivos**,
más 1 smoke test DeepSeek correctamente omitido sin API key;
`npm run test:matrix` en verde en PostgreSQL 15 y 16, y
`npm run typecheck` limpio.

Fuera de alcance de F0, documentado y diferido: el servidor HTTP
(`src/api/`, F8) — por eso no existe script `dev`.

---

## F1 — Registro de fuentes + fetcher + almacenamiento crudo

**Objetivo:** poder descargar, cachear y conservar HTML crudo de cualquier
fuente autorizada sin interpretarlo.

Entregables:
- ✅ *Ya hecho:* Seed de `ingest.sources` (`src/ingest/sources.ts`,
  `npm run cli -- sources:seed`) desde `Links for Data Scrapping.xlsx`
  (lee URL/Name/Type reales del archivo; el enriquecimiento
  access_strategy/trust_level/enabled inicial es exactamente el ya
  auditado en SOURCES.md §3, no se re-deriva) + `youtube_data_api` + los
  2 XLSX como seeds internos = **14 filas** (10 `enabled=true`: 9 del XLSX +
  YouTube Data API; Deska y Hemeroteka `enabled=false` por lo ya
  confirmado en SOURCES.md §3.2). Idempotente por `slug`: un re-seed nunca
  pisa `enabled`/`trust_level` si la fila ya existía (protege cambios
  operativos manuales); el registro de adapter bloquea igualmente toda fuente
  clasificada como limitada.
- ✅ *Ya hecho:* `fetcher` (`src/fetcher/http.ts`): robots.txt real
  (`src/fetcher/robots.ts`, algoritmo Allow/Disallow por regla más
  específica, comodines `*`, ancla `$`, `Crawl-delay` y `Sitemap`), cortesía
  (concurrencia=1 + mayor demora entre la local y la declarada por dominio),
  fail-closed ante red/5xx de robots (404 sigue significando sin reglas),
  timeout, reintento con backoff exponencial (no reintenta 4xx salvo 429).
- ✅ *Ya hecho:* `cache` (`src/cache/raw-pages.ts`) sobre `ingest.raw_pages`,
  respetando la unicidad real de la tabla (`UNIQUE(source_id, sha256)`,
  dedupe por CONTENIDO, no por URL — documentado en el propio módulo) y
  TTL configurable (`CRAWL_CACHE_TTL_DAYS`).
- ✅ *Ya hecho:* Storage crudo en `data/raw/<source-slug>/<sha256>.<ext>`
  (+ `.headers.json` adyacente) vía `src/storage/raw.ts`.
- ✅ *Ya hecho:* migración `0005_raw_pages_run`: `raw_pages.run_id` enlaza
  cada snapshot con el último run que realmente lo descargó (un cache hit no
  falsea la procedencia).
- ✅ *Ya hecho:* CLI `sources:list` / `sources:seed` / `sources:add`
  (crea `new_source` en `review_queue` con `enabled=false`, nunca habilita
  directo — verificado) / `scrape <slug> --observe` (solo descarga +
  cachea, sin extracción): pagina el feed de Blogspot y también observa las
  URLs/entrypoints públicos conocidos de WordPress, sitios web y Sincopa.
  Los tipos con flujo propio (`youtube_api`, `spreadsheet`, `instagram`) se
  rechazan explícitamente en lugar de simular un scrape.
- ✅ *Ya hecho:* errores por recurso persistidos en `ingest.scrape_errors`
  (kind, mensaje, reintentos, URL y `raw_page_id` cuando existe). Un error
  aislado no aborta la cola; el checkpoint y las URLs pendientes quedan en
  `scrape_runs.params` y el siguiente run las reanuda.

Criterios de salida: ✅ **verificado en vivo** contra `rhv-blogspot`
(RHV Blogspot, la fuente Blogger más pequeña) — barrido de observación
completo: 11 páginas del feed, **264 entradas** (coincide exacto con
SOURCES.md §3.1); re-descarga dentro del TTL: **0 peticiones nuevas**, las
11 páginas servidas 100% desde caché. Automatizado además en
`test/contract/fetcher-observe.test.ts` contra un servidor Blogger simulado
(hermético, sin depender del sitio real en CI), incluyendo robots.txt real
con Disallow, dedupe por contenido, observación no-Blogger, procedencia por
run y un 503 intermedio que se persiste, no aborta y se recupera al reanudar.

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

Orden revisado por **valor confirmado** en la auditoría del 2026-09-07 y la
revalidación de las tres fuentes restantes del 2026-09-08
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
   posts y 17 páginas**) y rockhechovenezuela.com (portada HTML + 4 posts + 6
   páginas REST; frontera fija, sin navegador).
5. `limitedManual` → Instagram Hemeroteka (`limited/manual/disabled`): entrada
   humana a revisión, sin fetch, login, Playwright, proxy ni claim ficticio.
6. `limitedDisabled` → Deska: `enabled=false`; `robots.txt` declara
   `Disallow: /`, por lo que no se consume ni se prueban endpoints alternos.

Entregables transversales: escribir en `ingest.sources.access_strategy` el
canal confirmado de cada fuente; caracterizar la estructura interna de los
posts (lo único que la sonda no pudo confirmar). Playwright: **no se
incorpora**, ninguna fuente activa lo requiere.

Criterios de salida: Sincopa produciendo claims de miembros y sellos con
evidencia (excerpt+selector+url) y acentos correctos tras la decodificación;
al menos 2 fuentes Blogger produciendo claims con evidencia; ninguna fuente
no autorizada scrapeada; las once filas del XLSX con capacidad explícita (9
automáticas, 1 manual limitada y 1 deshabilitada).

---

## F5 — Entity resolution, merge y conflictos (núcleo del sistema)

**Objetivo:** el pipeline completo con el merge híbrido gobernado por
confianza.

Entregables:
- ✅ ER determinista tipada (ARTIST/PERSON/ALBUM/TRACK/ORGANIZATION), con
  scores/features y fuzzy incapaz de autorizar por sí solo.
- ✅ `merge engine` con advisory locks, dedupe y auditoría de todo write core.
- ✅ `conflict engine` + `ingest.conflicts` (ambas afirmaciones/evidencias) y
  resolución exclusivamente humana.
- ✅ `review_queue` operativa como módulo (`src/review/queue.ts`); comandos CLI
  aún pertenecen al cierre operativo de F7.
- ✅ Regla dura verificada: crédito de álbum ≠ membresía.
- ✅ Puente de relaciones (`src/merge/relations.ts`): `artist_membership` →
  `artist_members`, `album_credit` → `album_credits`, `track_credit` →
  `track_credits`, con la tabla destino fijada por el `entity_kind`, extremos
  que nunca se crean desde la relación y la misma compuerta `low`. Cubierto
  por `test/contract/relationship-bridge.test.ts`.
- ✅ Promoción por entidad (`src/review/approval.ts` + `crv review
  entities|approve|dismiss`): una decisión humana por identidad, que es lo
  único capaz de llevar un claim `low` de fuente web al catálogo.

Criterios de salida: merge del seed + 2 fuentes Blogger con 0 duplicados
(re-run idéntico); conflictos reales conservados con evidencia doble; una
resolución de conflicto de muestra ejecutada y auditada. El motor y la
resolución de muestra están cubiertos por
`test/contract/entity-resolution-merge.test.ts`.

Las **dos fuentes Blogger ya existen**: Descargas Metal Venezolano (11.313
registros: 1.338 artistas con ciudad de origen, 1.345 álbumes con año y
género, 8.630 pistas) y Hippito y Sus Chatarritas (14.868 registros, ficha en
el título). Rock De Vzla y Rockzuela tienen estructura explícita medida y
aún no tienen adapter, igual que RHV Blogspot, cuyo título usa dos puntos
(`BANDA: Álbum (Año)`) en vez de guion — ver SOURCES.md §3.2.
**El barrido completo estaba bloqueado por la ergonomía de la revisión, no
por los adapters.** 2.962 claims ingeridos habían producido 406 entidades
candidatas y el core tenía 40 discos: la promoción era de una en una por CLI,
y extrapolando a los 73.789 registros que las tres fuentes ya saben extraer
salen ~10.000 decisiones individuales. `crv review approve-batch` (ver
ARCHITECTURE.md §4.10) convierte eso en una decisión por conjunto sin relajar
ninguna guarda; con él, falta ejecutar el barrido y verificar el re-run
idéntico.

La **hoja maestra de YouTube** ya está emitida como claims (`crv youtube
seed-claims`): 606 filas → 258 artistas y 570 discos con año y tipo, 2.942
claims candidatos, y la re-corrida reusa los 2.942 sin insertar ninguno —el
criterio de idempotencia de esta fase, verificado sobre la fuente de mayor
confianza del archivo.

Las **portadas** entran por `albums.cover_url` sin migración: **1.345 de
1.345** discos de Descargas Metal, 671 de 673 de Hippito y 782 de Sincopa
(+259 fotos de artista en `artists.picture_url`).

---

## F6 — DeepSeek gateway

**Objetivo:** IA puntual, auditable y opcional.

Entregables:
- ✅ Gateway aislado con JSON/Zod estricto + `ingest.ai_runs` (prompt_hash
  cache); modelos por rol configurables, sin tools ni acceso a SQL/merge.
- ✅ Casos: ER ambiguo y conflicto (propuestas), extracción/normalización con
  Flash y biografías trazables (`ai_biographies` + bridge de claims).
- ✅ Presupuesto/timeout por llamada; suite offline con mock y smoke test real
  opt-in mediante `npm run test:deepseek:real`.

Criterios de salida: 3 casos de uso cubiertos con salida validada por Zod;
ninguna escritura al core atribuida a `ai` con confianza superior a `low`
sin aprobación; caché de prompts verificado (mismo prompt → 1 llamada).
✅ Cubierto por tests unitarios y contractuales; el test real se omite sin key.

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
