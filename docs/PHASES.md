# CRV — Plan de fases

> Cada fase tiene objetivo, entregables, criterios de salida y dependencias.
> Las fases son secuenciales salvo indicación. Ninguna fase modifica el core
> (`crv_simple_v1.sql`): las migraciones posteriores solo tocan el esquema
> `ingest`.
>
> Estado actual (cierre del 2026-09-13): **F0 y F1 cerradas**; F2 y F3 cierran
> sus criterios (ver «Estado al cierre» de cada una); F4 y F5 se cierran con la
> promoción auditada de todas las fuentes con adapter y la verificación final
> descrita en «Cierre F2–F5». **F6 ya está implementada y probada.**
>
> El trabajo restante se reestructuró el 2026-09-14 en las etapas **E6–E11**
> (ver «Plan restante»). **E6 ejecutada el 2026-09-14**: reconciliación del
> canal idempotente y verificada; las cinco desviaciones de créditos del caso
> Caramelos, heredadas de la ingesta, se corrigieron ese mismo día por decisión
> del propietario y el caso cumple entero.
> **E7A ejecutada el 2026-09-14**: API de lectura Fastify (búsqueda global,
> fichas agregadas de artista/disco/persona/organización, fuentes, claims,
> review-queue y videos de YouTube), probada con PostgreSQL desechable y a
> mano contra la base real.
> **E7B ejecutada el 2026-09-14**: API de escritura con token de operador —
> CRUD de las 10 tablas del core a través del merge engine, acciones de la
> cola (aceptar, rechazar, resolver conflicto) e historial de auditoría—,
> probada con PostgreSQL desechable.
> **E10 ejecutada el 2026-09-14**: barrido y resolución explicable de las
> ambigüedades de discos, personas y YouTube sobre la cola. Las 663 preguntas
> tienen dosier y evidencia; el core sigue intacto hasta que una persona use
> la puerta explícita `ambiguity:apply --confirm`.
>
> Existen `youtube import-sheet`, `youtube seed-claims`, `youtube
> discover-channel`, `youtube sync`, `youtube rederive`, `youtube api-claims`,
> el enlazador conservador `yt:link`, el enriquecimiento dirigido
> `yt:enrich-artist` y los comandos `review` individuales y por lote. La
> aplicación auditada de las decisiones de la Mesa de Cotejo ya existe y fue
> ejecutada.
>
> Reglas del propietario que gobiernan el cierre (2026-09-13): un artista de
> blog entra solo con señal venezolana (ya en el catálogo, ciudad/estado/sello
> venezolano en la fuente, o fuente 100 % venezolana); en Hippito, que no da
> origen de nadie, solo se completan artistas ya catalogados; personas y sellos
> nuevos solo entran si algo conservado los nombra; géneros solo los que
> afirma la fuente; créditos con varios nombres se parten en personas; el canal
> de YouTube manda sobre la lista de pistas.
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

## Cierre F2–F5 (base local, 2026-09-13)

Criterio de cierre: 0 claims nuevos al repetir, 0 entidades duplicadas, 0 filas
sin auditoría, 0 conflictos sin decisión, y `doctor`, typecheck y suite en
verde. Verificado el 2026-09-13 (22:08–22:45) con la base de desarrollo:

| Criterio | Resultado |
|---|---|
| Re-ingesta de las 9 fuentes con adapter | **0 nuevas**: Sincopa 0/158.061, Hippito 0/129.679, Rock De Vzla 0/54.143, Descargas Metal 0/47.237, CRV WordPress 0/7.279, Rockzuela 0/5.326, RHV 0/126, El Punk 0/74, Rock Hecho 0/8 |
| `youtube seed-claims` / `youtube api-claims` | 0 nuevos / 3.156 reusados · 0 nuevos / 96.771 reusados (la primera pasada emitió los 250 claims del video `hnAeUGloVP8`, publicado ese mismo día, y se aprobaron) |
| Claims `candidate` o `conflict` | **0** en todas las fuentes (509.653 claims) |
| Revisiones abiertas · conflictos abiertos | **0 · 0** |
| Duplicados por nombre exacto (artistas, discos, personas, sellos, pistas, formatos) | **0**; `crv review duplicates`: 0 grupos (5 descartes legítimos: mismo título, años distintos) |
| `doctor` | todo verde, incluida `merge_audit.coverage` (116.651 auditorías, todas con claim) |
| typecheck · suite | exit 0 · 247 pruebas pasan, 1 omitida (DeepSeek real opcional) |

Catálogo resultante: 1.982 artistas, 4.761 discos, 27.439 pistas, 10.722
personas, 763 organizaciones, 1.367 membresías, 17.284 créditos de disco,
12.247 de pista, 744 formatos de edición, 1.020 `media_links` y **603 discos
con enlace primario** a su video. `person_organizations` sigue en 0: ninguna
fuente emite esa relación.

Cómo se cerró (reglas del propietario en el encabezado):
- **Promoción por fuente** con plan JSON + run auditado: RHV, El Punk, Rock
  Hecho, CRV WordPress, Rock De Vzla, Sincopa y Hippito. Los créditos con varios
  nombres se partieron en personas; lo que el motor dejó en revisión (pista
  inexistente, acreditado inexistente, varias etapas de membresía) se resolvió
  con la lista de pistas del canal como verdad: el crédito de una pista que el
  canal no lista se reemplaza.
- **Pertinencia**: en Hippito solo se completan artistas ya catalogados; de 334
  recopilatorios de Various Artists se conservan los 60 que nombran a algún
  artista del catálogo y se retiran 274 ediciones venezolanas de música
  extranjera (discos borrados con su historia copiada en `merge_audit`, claims
  rechazados, nunca borrados). Personas y sellos nuevos solo entran si algo
  conservado los nombra.
- **Duplicados**: además de `crv review duplicates`, se buscaron discos del
  mismo artista con pistas iguales en la misma posición (títulos truncados y
  erratas de las fuentes) y se fusionaron 20, alineando antes —auditado— los
  títulos de pista que impedían la fusión; también Azúcar Cacao y Leche →
  Azúcar, Cacao & Leche (nombre del canal) y los seudoartistas Escenario Juvenil
  y Venerock → Various Artists.

Queda para revisión humana (decisiones conscientemente abiertas, fuera del
criterio de cierre):
- **85 pares de discos** del mismo artista que comparten ≥3 pistas en la misma
  posición pero no pasan la regla estricta de fusión: 51 comparten menos del
  80 % de pistas, 18 tienen años distintos, 13 títulos sin relación
  (recopilatorios, directos), 2 están ambos en el canal y 1 es reedición.
  Algunos son probablemente el mismo disco con otra edición o una errata de año
  (p. ej. Krueger *Decade of Perversion* 2002/2003, Luz Verde *Cinema 0* /
  *Cinema Cero*). También *Desde Una Orilla* de Hydra: la pista 5 difiere.
- **Personas con varias grafías**: la detección de duplicados compara nombre
  exacto, así que variantes como José Manuel "Chema" Arria / José Manuel Arria
  "Chema" / J. M. Arria o Augie Verde / Augie "Oggi" Verde siguen como fichas
  separadas. Requiere una pasada de ER de personas con decisión humana.

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

Regresión corregida (2026-09-13): `test/contract/core-and-schema.test.ts`
listaba las migraciones solo hasta `0010`, así que al llegar
`0011_album_classifications` fallaban 2 tests (subida y rollback). Ya la
incluye y vuelve a pasar completo.

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
- `youtube seed-claims` emite los claims del seed y ejecuta el merge por la
  puerta normal; no existe un paso `merge:run` separado.

Criterios de salida: importación ejecutada 2 veces → conteos idénticos;
matriz de tipos cumplida (ver acceptance `caramelos-las-paticas.md`);
`ingest.merge_audit` con trazabilidad completa; cola de revisión poblada con
las 88 filas anómalas esperadas (86 `missing_url` + 2 `seed_incomplete`), los
**7 pares duplicados reales** y las 2 colisiones de nombre de artista
(`Soleà `/`Soleà`, `Pacifica`/`Pacífica`); el conflicto interno de año de
`Metrozubdivision / CCS` (2007 vs 2006) registrado conservando ambas
afirmaciones.

Estado al cierre (2026-09-13):
- ✅ Las filas `EMPTY` (órdenes 97 y 440) iban a `missing_url` porque la
  comprobación de URL corría antes que la de fila vacía. `importYouTubeMasterSheet`
  las manda ahora a `seed_incomplete` (`isEmptySeedRow`), las dos revisiones
  existentes se reclasificaron y `test/contract/youtube-pipeline.test.ts` lo
  fija.
- ✅ El título `[object Object]` de la fila 564 (celda con formato mixto) está
  corregido en `asText` y no queda en claims, core ni cola.
- ✅ `Metrozubdivision / CCS`: conflicto 20 resuelto por una persona (2007,
  Live Album) conservando ambos claims.
- ✅ B-Sides (9 filas): `album_type='other'` + clasificación «B-Sides» en
  `ingest.album_classifications` (decisión del propietario, 2026-09-13).
- ✅ Aceptación Caramelos De Cianuro: un solo artista, *Las Paticas De La
  Abuela* 1992 EP con enlace primario, 0 membresías desde el seed, Live
  Concert sin álbum. *En Vivo* (fila 370) tiene ahora su segundo video
  (fila 553) como `live_concert` no primario. La hoja creció desde el
  escenario original: 17 discos del canal en vez de 14.

---

## F3 — YouTube Data API (sincronización y enriquecimiento)

**Objetivo:** datos de YouTube de primera clase sin tocar la web de YouTube.

Entregables:
- ✅ *Ya hecho:* **paso 0 (sonda) y paso 1 (descubrimiento)** —
  `crv youtube discover-channel [channel-id] [--resume]`
  (`discoverChannelUploads`, `src/youtube/pipeline.ts`). Recorre el playlist
  de uploads **sin hidratar**: la red nunca ocurre dentro de una transacción
  abierta, cada página se confirma sola, el progreso vive en
  `ingest.scrape_runs.counters.nextPageToken` y un fallo deja el run
  `partial` en vez de perder lo descargado. Ejecutado en vivo el 2026-09-08:
  646 entradas en 13 páginas, 14 unidades de cuota, idempotente (segunda
  pasada: 0 filas nuevas). El resultado —128 videos del canal que la hoja no
  registra— está en SOURCES.md §2.1.
- ✅ *Ya hecho:* **`syncYouTubeChannel` reescrito** sobre
  `discoverChannelUploads` + `hydrateYouTubeVideos`. Ya no existe la
  transacción única que envolvía las llamadas HTTP del canal: descubrimiento
  con commit por página, hidratación en lotes de 50 con commit por lote, y un
  lote que falla no arrastra a los anteriores ni impide los siguientes.
- ✅ *Ya hecho:* **parser calibrado contra el corpus real.** El paso 1 dejó en
  disco las 636 descripciones completas (`playlistItems.list` no las trunca:
  verificado byte a byte contra `videos.list`), así que la calibración no
  costó cuota. Cobertura **636/636**: 6.769 pistas y 1.633 créditos. Detalle
  y las dos correcciones que impuso el corpus, en SOURCES.md §2.2.
- ✅ *Ya hecho:* **`parseYouTubeTitle` extrae artista, disco, formato y año**
  (616 de 646 títulos llevan año; 77, etiqueta de formato) — SOURCES.md §2.3.
- ✅ *Ya hecho:* **paso 2 — `crv youtube sync [--pending]`**
  (`knownYouTubeVideoIds` + `hydrateYouTubeVideos`). Hidrata la unión de la
  hoja y el canal: 648 IDs en 13 lotes de 50. Ejecutado el 2026-09-08 (runs
  87 y 88): **646 hidratados, 2 sin respuesta, 0 lotes con error**, y la
  segunda pasada deja conteos idénticos. Los 2 ausentes —`QcnD-UIl0N8` y
  `nUNxlo6cTbc`— van a `ingest.scrape_errors` y vuelven en `missing`: un ID
  que no vuelve es un dato, no un fallo silencioso.
  Derivado en el mismo paso: **6.769 pistas** en
  `media.youtube_tracklist_entries` sobre 636 videos y **2.394 secciones** en
  `media.youtube_description_sections`. De esas pistas, **1.353 vienen de los
  128 videos que la hoja nunca registró**.
- ✅ *Ya hecho:* **paso 3 — `crv youtube rederive [--dry-run]`**
  (`rederiveYouTubeDescriptions`). Re-parsea el payload ya guardado sin
  tocar la red; `SAVEPOINT` por video; `--dry-run` mide el delta y lo
  deshace. Hidratar y re-derivar comparten `persistDerivedDescription`, un
  solo camino de código. Ejecutado el 2026-09-08 (runs 89-92): dry-run
  inicial con delta cero —la derivación es fiel—, luego +23 pistas al cubrir
  la errata `Trackslist`, y una segunda pasada con 0 cambios. Total:
  **6.792 pistas** y **2.396 secciones**; el core sigue en 40 álbumes y 278
  pistas.
- ✅ *Ya hecho:* **paso 4 — `crv youtube api-claims [--dry-run]`**
  (`src/youtube/api-claims.ts`). Cierra el hueco: hasta aquí
  `persistVideoPayload` escribía el espejo en `media.*` sin emitir un solo
  claim. Ahora lo derivado entra por adapter → normalización → claims → ER →
  merge, como cualquier fuente, y **como candidato** (`confidence: low`), a
  la espera de `review approve-batch --source=youtube-data-api`.
  De 646 videos salen 596 discos, 6.531 pistas, 3.840 personas, 408
  organizaciones, 7.762 créditos de disco y 1.458 acotados a pista
  (SOURCES.md §2.5). El marcador `|| Full Album ||` decide qué es publicación
  y nunca contradice la clasificación de la hoja.
- ✅ *Ya hecho:* `yt:link` (vínculo video→álbum exacto; el resto a revisión)
  y `yt:link --album --video --note --confirm` para la selección humana. Al
  cierre (2026-09-13) **602 de 602** discos con video tienen enlace primario
  y ningún video queda con varios discos sin primario.
- ✅ *Ya hecho (2026-09-13):* **`yt:enrich-artist "<artista>" [--max=N]
  [--dry-run]`** (`src/youtube/enrich.ts`). `search.list` restringido al
  `channelId` del proyecto (nunca todo YouTube), techo de 25 resultados, solo
  para los discos del artista que siguen sin video; hidrata lo nuevo y abre
  `youtube_match` ante una coincidencia exacta artista+título+año. Nunca
  enlaza ni crea álbumes. Prueba real sobre Caramelos De Cianuro: 15 videos
  del canal encontrados, todos ya hidratados y enlazados → sus 7 discos sin
  video no están en el canal (el inventario del canal está completo).
- ✅ *Ya hecho (2026-09-13):* **presupuesto de cuota**: `QUOTA_COST` en
  `api.ts` y `YOUTUBE_DAILY_QUOTA_UNITS` (10.000 por defecto). Antes de gastar,
  `youtubeQuotaUsedToday()` suma lo consumido desde la medianoche del Pacífico
  por los runs `enrich_artist` y `yt_api_sync`; sin margen no se llama.
  Reintento con backoff para 5xx/429 en `YouTubeDataApi.request`; 403/400 son
  terminales.

Criterios de salida: ✅ sync completa sobre la unión —no sobre 520 IDs, que
era el universo supuesto, sino sobre 648— en lotes con reintentos; ✅ ningún
álbum creado por videos y conteo de `albums` idéntico antes y después del
sync (40 antes, 40 después; `artists` 29 y `tracks` 278, sin mover);
✅ disponibilidad proyectada en `albums.youtube_status` (2026-09-13): los 10
discos que tenían URL del canal pero conservaban el `unknown` del DDL toman
el estado del video hidratado, auditado. Queda `unknown` solo
`nUNxlo6cTbc` (Tributo a CDC), que la API no devuelve: borrado o privado.

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
el título). A ellas se suma **Rock De Vzla** (54.143 claims: 1.108 artistas,
1.815 discos, 9.908 pistas, 1.775 portadas), que necesitó abrir un canal
nuevo: las etiquetas del feed (`entry.category`) ahora llegan al parser,
porque 1.110 de sus 1.113 entradas traen el título vacío y el nombre de la
banda solo existe ahí. Con **Rockzuela** (5.326 claims: 475 artistas, 549
discos, 543 portadas) y **RHV Blogspot** (126 claims, 18 discos) quedan
cubiertas las cinco Blogspot. Cada una lee un canal distinto y ninguna
comparte extractor: Rockzuela decide por la etiqueta de SECCIÓN si el post es
una publicación (`Musica` sí, `Videos` no), y RHV, que es un blog de prensa,
solo por el título terminado en año — sus etiquetas son secciones
editoriales y no nombran bandas. Ver SOURCES.md §3.2.
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

## Plan restante (reestructurado el 2026-09-14)

Las antiguas F7 (API + CLI), F8 (frontend) y F9 (endurecimiento) se
reordenaron contra el plan de implementación original (fases 6–11) y contra
lo que la base mostraba el 2026-09-14. Del plan original ya estaban hechas la
aceptación Caramelos y casi toda la reconciliación del canal (649 videos
inventariados, 603 enlaces primarios, `yt:enrich-artist`). Faltaba:
`media.video_artists` y `media.video_tracks` en 0, 44 videos sin disco sin
explicación, ninguna API, interfaz, backup ni auditoría final. Para no
confundirlas con las F históricas, las etapas nuevas se numeran **E6–E11**.

| Etapa | Contenido | Modelo · effort recomendados |
|---|---|---|
| E6 | Relaciones video→artista/pista, reporte de reconciliación y aceptación Caramelos completa | Opus 5 · high |
| E7A | API de lectura | Sonnet 5 · medium |
| E7B | API de escritura y cola de revisión | Opus 5 · high |
| E8 | Interfaz React | Sonnet 5 · high |
| E9 | QA visual | Sonnet 5 · medium |
| E10 | Resolución de ambigüedades | Opus 5 · xhigh |
| E11 | Hardening y auditoría final | Opus 5 · xhigh |

### E6 — Reconciliación del canal (plan: fases 6 y 10A)

**Objetivo:** que todo lo identificable del canal quede relacionado con
artistas, discos y pistas, y que lo inseguro quede pendiente a la vista.

Entregables:
- `crv yt:reconcile [--dry-run]` (`src/youtube/reconcile.ts`): llena
  `media.video_artists` y `media.video_tracks` solo con identidades exactas o
  enlaces ya confirmados; clasifica cada video en MATCHED_HIGH,
  MATCHED_MEDIUM, AMBIGUOUS, UNMATCHED_VIDEO o CONFLICT, y cada disco sin
  video como UNMATCHED_ALBUM; lo medio, ambiguo o en conflicto va a
  `youtube_match`. Sin red, sin cuota, sin IA y sin tocar el core.
- `reports/youtube-reconciliation.{json,md}`.
- `docs/acceptance/caramelos-las-paticas.md` con los inicios de pista, los
  IDs reales y las consultas que prueban las relaciones.

Criterios de salida: segunda corrida con 0 relaciones y 0 revisiones nuevas;
muestra SQL de álbum↔video y pista↔video; conteo de `albums` y `tracks`
idéntico antes y después.

Estado al cierre (2026-09-14, base de desarrollo, runs 191 y 192):

| Criterio | Resultado |
|---|---|
| Videos clasificados | 649: MATCHED_HIGH 623 · MATCHED_MEDIUM 14 · AMBIGUOUS 1 · UNMATCHED_VIDEO 11 · CONFLICT 0 |
| Por tipo | full_album 603 · music_video 17 · live_concert 15 · documentary 3 · editorial 11 |
| `media.video_artists` | 638 (635 `performer`, 3 `subject`) |
| `media.video_tracks` | 6.580 en 609 videos, 6.562 con su claim; 6.569 de 6.602 entradas de tracklist casadas |
| Revisiones `youtube_match` | 15 nuevas (ids 191119–191133) |
| UNMATCHED_ALBUM | 4.158 discos sin video, 713 de artistas presentes en el canal (el resto no tiene videos) |
| Segunda corrida (run 192) | 0 relaciones nuevas, 0 revisiones; artistas, discos, pistas, personas, sellos, créditos, `video_albums` y `merge_audit` idénticos |
| `doctor` · typecheck · suite | todo verde · exit 0 · 256 pruebas pasan, 1 omitida |

Lo que quedó pendiente, a la vista en el reporte y en la cola:
- 11 piezas editoriales (reseñas, entrevistas, reposts) sin relación: varias
  nombran a un artista en prosa y no se adivina.
- 5 videoclips cuya canción está en varios discos: 4 con propuesta de la única
  versión de estudio y *Burrera* (Candy66), en dos discos `other`, ambigua.
- 5 conciertos con un disco homónimo del artista: se propone el vínculo
  `live_concert`, no se asume.
- 5 discos enlazados con pistas que no casan: 4 sin ninguna pista en el
  catálogo (*EtéreoPlay Sessions*, *Smells Like Teen Spirit*, *Desenchufado*,
  *Fabricado Acá*) y *Acústico En Bits Session* («Intro», «Cenizas»/«Ceniza»).
- «Cangrejo & Kreils» resuelve por un alias existente de Cangrejo; Kreils no
  queda relacionado con ese video.
- **Caso Caramelos: cumple entero desde el 2026-09-14.** Las cinco desviaciones
  de créditos heredadas de la ingesta se corrigieron con decisión del
  propietario (detalle e IDs en `docs/acceptance/caramelos-las-paticas.md` §4b):
  - `crv review persons --plan=docs/decisions/2026-09-14-personas-caramelos.json`
    (run 194): «Boris Milán» → «Boris Milan» (grafía del video, la anterior
    como alias); «Car» + «los Rondon» → Carlos Rondon (sin alias de
    fragmentos); Luis Barrios fusionado en Luis "Golding" Barrios; la
    «persona» Caramelos de Cianuro pasa al artista (17 créditos, 17 claims de
    nombre rechazados, nunca borrados); 9 créditos equivalentes unidos.
  - Parser: «Artwork & Illustration by», «Photography by», «Photos by»,
    «Graphic Design by» e «Illustrations by» se leen; foto y arte son un solo
    crédito por acreditado y obra (`creditEquivalenceKey`), y estudios de
    diseño/foto/web se reconocen como organización. `youtube api-claims`
    emitió 25 claims nuevos más los de la primera pasada; 20 obsoletos se
    rechazaron.
  - Identidades de los acreditados nuevos, decididas por el propietario: 12
    veredictos de ER (run 198; Bobby = Bobby Peru, Batoni = el de Zapato 3,
    Carlos Rondon, Eugenio Miranda y Vicente Corostola existentes; 7 personas
    nuevas), lote aprobado (runs 197 y 199) y
    `docs/decisions/2026-09-14-acreditados-arte-canal.json` (run 200): Killdom
    → organización Killdom Imaging, «Masserrati 2lts» → artista Masseratti
    2lts. «Lamarca+Batoni» son dos personas.
  - Resultado: 0 claims candidatos; 7 personas y 4 organizaciones nuevas; 18
    créditos de disco más (17.302); `doctor` en verde.

### E7A — API de lectura (plan: fase 7)

Fastify con búsqueda global (artista, persona, disco, pista, productor,
organización; los alias participan), fichas agregadas de artista, disco,
persona y organización según el plan, lectura de fuentes, claims, videos y
enlaces, paginación, Zod, errores consistentes y OpenAPI.

Criterios de salida: tests contra PostgreSQL de prueba, incluido el endpoint
de *Las Paticas De La Abuela* con pistas, créditos y videos.

Estado al cierre (2026-09-14): implementada en `src/api/` (Fastify 5 +
`fastify-type-provider-zod` + `@fastify/swagger`/`swagger-ui` + `@fastify/cors`).
Endpoints: `GET /health`; `GET /search` (artist/person/album/track/organization,
alias incluidos, filtro `types`); `GET|GET/:id` para `artists`, `albums`,
`persons`, `organizations` con fichas agregadas (discografía, tracklist +
créditos por pista, créditos de álbum agrupados por `credit_type`, formatos,
alias, enlaces de YouTube); `GET /sources`, `GET /sources/:id`; `GET /claims`
(exige `entity`+`id`, la tabla no se lista sin filtro); `GET /review-queue`,
`GET /review-queue/:id` (solo lectura; aceptar/rechazar queda en E7B);
`GET /youtube/videos`, `GET /youtube/videos/:id`. Paginación `limit/offset`
uniforme, errores homogéneos `{error:{code,message}}`, OpenAPI en `/docs`.
`npm run api` levanta el servidor en `HOST:PORT` (env, default
`127.0.0.1:8080`).

`test/contract/api-read.test.ts` (15 tests, PostgreSQL 15 desechable): siembra
el caso Caramelos De Cianuro/Las Paticas De La Abuela directamente en las
tablas core+media (sin pasar por el pipeline: esta suite prueba la API, no el
merge engine) y ejercita cada ruta con `app.inject()`, incluida la validación
de query/params, 404 y 400 consistentes, y OpenAPI servido. Probado además a
mano contra la base de desarrollo real (`npm run api` + `curl`): búsqueda de
"Caramelos"/"Paticas" y `GET /albums/57` (disco real) devuelven tracklist con
los 4 `youtube_start_seconds`, créditos por `credit_type` (incluye Mad Box's
Studios como organización) y el enlace primario a `Q-pRpO2sYSI`, igual que en
`docs/acceptance/caramelos-las-paticas.md`.

### E7B — API de escritura y cola de revisión (plan: fase 7)

CRUD transaccional de las 10 tablas del core **a través del merge engine**
(claims `created_by=human, confidence=high`; los controllers no duplican su
lógica), endpoints de la cola (listar, detalle, aceptar, rechazar, resolver
conflicto) con audit trail y autenticación local de operador.

Criterios de salida: CRUD de artista/álbum con auditoría; una corrección
manual de un dato conflictivo resuelve el conflicto y conserva el historial.

Estado al cierre (2026-09-14): implementada.

- **Autenticación**: lectura abierta; todo POST/PATCH/DELETE exige
  `Authorization: Bearer $CRV_OPERATOR_TOKEN` (mín. 24 caracteres, comparación
  en tiempo constante, nunca se registra). Sin token configurado la API es de
  solo lectura (403 `writes_disabled`). `X-CRV-Operator` firma con un nombre;
  por defecto, `CRV_OPERATOR_NAME`.
- **CRUD** (`src/api/routes/catalog-writes.ts`, `relation-writes.ts`):
  `POST`, `PATCH /:id` y `DELETE /:id` para `artists`, `persons`,
  `organizations`, `albums`, `tracks`, `artist-members`,
  `person-organizations`, `album-credits`, `track-credits` y `album-formats`.
  Los controllers solo validan (Zod) y llaman a `src/merge/operator.ts`.
- **A través del merge engine**: cada petición es UNA transacción y UN run
  `manual` (operador, nota, valores) de la fuente `crv-operador`; cada campo es
  un claim `created_by=human, confidence=high` que pasa por `mergeClaim`. Para
  eso `mergeClaim`, `resolveFieldConflict`, `mergeRelationClaim` y
  `persistClaim` aceptan la transacción de quien llama (sin ella se comportan
  como antes). Si el valor afirmado no queda en el core —había otro afirmado,
  o el motor lo guardó como alias— se aplica `overrideFieldByHuman`: escribe el
  valor, lo audita con el anterior, pasa los claims rivales a `superseded`,
  cierra los conflictos abiertos del campo (`resolved_a`/`resolved_b` si
  coincide con un lado, `dismissed` si no) y aprueba sus revisiones.
- **Altas**: si el ER reconoce la entidad, 409 con su id; con candidatos
  parecidos, 409 `needs_review`, y `allowSimilar: true` es la decisión humana
  de crear la ficha como distinta. Una pista en una posición ocupada, 409.
- **Relaciones**: el puente escribe ahora las cinco tablas puente; los
  extremos se eligen por id (`endpoints`, verificados, trazados como
  `explicit_fk`). `person_organization` y `album_format` solo se registran así
  (ninguna fuente los emite). Registrar una relación ya existente devuelve la
  fila (200, `created:false`). Las correcciones de filas puente
  (`correctRelationField`) auditan valor anterior y nuevo.
- **Retiros** (`src/merge/removals.ts`): no se borra en cascada — con
  dependientes en `public`/`media` responde 409 `has_dependents` con la lista.
  Los claims no se borran (quedan `rejected` sin destino); la fila, sus alias y
  su `merge_audit` completo se copian a la ficha padre (`removed_<tipo>`) y al
  run (`GET /runs/:id`).
- **Cola** (`src/review/operator-review.ts`): `POST /review-queue/:id/accept`,
  `/reject` y `/resolve-conflict`, con nota obligatoria. Careos de la Mesa →
  `review_decisions` firmada + `applyReviewDecisions` acotado a esa revisión
  (nueva opción `reviewIds`); `ambiguous_alias`/`ai_entity_resolution` → merge
  con anulación humana; `low_confidence`/`manual_review` → `approveEntity` /
  `dismissEntity`; `field_conflict` → elegir lado (`canonical`, `proposed`,
  `a`, `b`, `both`, `dismiss`) o afirmar `value`. `youtube_match` y
  `possible_duplicate` siguen en el CLI (422 con la indicación).
- **Historial**: `GET /audit?entity=&id=` (merge_audit con claims enlazados) y
  `GET /runs/:id`. Errores homogéneos: 404/409/422 para fallos esperados y
  restricciones del DDL (único, FK, CHECK, NOT NULL) — ninguna escritura las
  esquiva. OpenAPI con esquema de seguridad `operatorToken`.
- **Ajustes del motor**: el texto humano de `biography`/`description`/`notes`
  conserva párrafos (el de las fuentes sigue colapsado); `DATE` se lee como
  texto ISO para que `birth_date` sea comparable con el valor afirmado.

`test/contract/api-write.test.ts` (9 tests, PostgreSQL desechable): 401 sin
token y 403 sin token configurado; alta de artista y álbum con claims
human/high, run y auditoría; 409 por duplicado; corrección de un valor
afirmado (conflicto `resolved_b`, claim anterior `superseded`, rastro
1989→1990) y renombrado con alias; alta, corrección y retiro de pista,
créditos, miembro, persona-organización y formato (409 con dependientes,
historia copiada a la ficha padre); **criterio de salida**: dos fuentes
contradicen el año de un disco, `resolve-conflict` con `value: 1997` deja el
disco en 1997, el conflicto `dismissed` por una persona, los dos rivales
`superseded` con su fuente y el historial 1995→1997; elegir `proposed` usa el
lado del conflicto; aceptar/rechazar careos y claims candidatos; OpenAPI.

Límites conocidos: no se escribió contra la base de desarrollo (sus datos son
válidos y no se tocan para probar). Un claim `rejected` por el retiro de su
entidad vuelve a pasar por el ER si la misma fuente se re-ingiere; no es
distinto de lo que ocurre hoy con un claim rechazado y queda para E11.

### E8 — Interfaz React (plan: fase 8)

Buscador, fichas de artista, disco, persona y organización con todas las
entidades clicables, formularios CRUD y cola de revisión con evidencia
visible; estados de carga, vacío y error; responsive. Referencias visuales
existentes: `public/cotejo.html` y la web de CRV WordPress.

Criterios de salida: build de producción y recorrido Caramelos De Cianuro →
Las Paticas De La Abuela → 4 pistas → Asier Cazalis → volver → Mad Box's
Studios. El navegador solo habla con la API.

**Completada (2026-09-14).** La SPA vive en `web/`; incluye las seis áreas de
navegación, buscador global, fichas enlazadas, CRUD de entidades, pistas,
miembros, créditos, formatos y alias, cola con evidencia y estados de carga,
vacío y error. `web/tests/visual/smoke.mjs` automatiza el recorrido de salida.

### E9 — QA visual (plan: fase 9)

Capturas reales en escritorio y móvil, fixtures extremos (30 músicos, 50
créditos, 100 pistas, nombres y biografías largos) en base desechable,
correcciones solo de problemas demostrables y `docs/UI_QA.md`.

**Completada (2026-09-14).** Capturas antes/después y extremas en
`docs/ui-qa/`; el fixture se crea y destruye con `npm run test:visual-extreme`.
Resultados, defectos corregidos y comparación con ambos SVG en `docs/UI_QA.md`.

### E10 — Resolución de ambigüedades (plan: fase 10B)

Sobre la cola, nunca sobre todo el catálogo: las revisiones de E6, los pares
de discos dudosos y la pasada de identidades de personas (grafías distintas).
Primero reglas deterministas, después el árbitro configurado con JSON validado
(DeepSeek flash por decisión del propietario, o un archivo externo);
decisiones MATCH_HIGH_CONFIDENCE / KEEP_SEPARATE / NEEDS_HUMAN / CONFLICT; al
core solo llega lo que apruebe una persona.
`reports/ambiguity-resolution.md`.

**Completada y verificada (2026-09-14).** Se implementaron la migración
`0012_ambiguity_resolutions`, `src/ambiguity/` y los tres comandos
`ambiguity:scan`, `ambiguity:resolve` y `ambiguity:apply`. El resolutor solo
produce decisiones para las revisiones `possible_duplicate` creadas por su
barrido y las `youtube_match` que dejó E6; consulta el catálogo como evidencia
pero no abre casos adicionales ni lo modifica. Cada decisión persiste los
hechos, las citas, el hash del dosier, la regla, el árbitro y el destino exacto
que tendría una aprobación (`ambiguity-rules.v2`).

Estado de la base de desarrollo (runs 203, 217, 218, 220 y 222):

| Criterio | Resultado |
|---|---|
| Barrido | 104 pares de discos y 543 de personas con banda en común; 1.415 pares nominalmente parecidos sin banda común quedaron fuera y documentados |
| Dosieres resueltos | 662 revisiones, 663 preguntas: 363 MATCH_HIGH_CONFIDENCE · 31 KEEP_SEPARATE · 22 CONFLICT · 247 NEEDS_HUMAN (run 218). Tras el run 220, #193242 quedó sin objeto (sus dos personas ya se fusionaron en 1667 por #193149/#193150) y el run 222 la devolvió a NEEDS_HUMAN: 362 · 31 · 22 · 248 |
| Reglas / árbitro | 460 decisiones deterministas; 203 dosieres semánticos revisados por `claude-opus-5`: 124 MATCH · 7 KEEP_SEPARATE · 5 CONFLICT · 67 NEEDS_HUMAN; 0 propuestas rechazadas por citas o política inválidas |
| Evidencia e invariantes | 0 decisiones automáticas sin evidencia · 0 MATCH sin destino · 0 no-MATCH con destino · 0 decisiones de árbitro sin árbitro · 0 preguntas con dos decisiones vivas |
| Idempotencia | run 218: 0 filas nuevas, 663 reutilizadas, 0 sustituidas; 0 dosieres siguen esperando árbitro |
| Puerta humana | Preview: 263 decisiones deterministas aplicables en lote (239 MATCH + 24 KEEP); 131 decisiones de árbitro aplicables solo nombrando su revisión (124 MATCH + 7 KEEP); CONFLICT y NEEDS_HUMAN nunca entran. **Run 220 (Brian aprueba):** `ambiguity:apply --review=<258 revisiones> --confirm` con 259 decisiones deterministas: 258 aplicadas (234 MATCH + 24 KEEP), 257 revisiones cerradas, 0 fallidas, 1 saltada por obsoleta (#193242). Quedan fuera por decisión de Brian las 4 dudosas —#193433 conservaría «Pete Thomns» (errata), #192829 conservaría «EP» sobre «Claroscuro», #193436 «Tony King Studio» es un estudio, #193459 Gloria Marín/Martín— y las 131 del árbitro |
| Core y reconciliación | Sin cambios en los runs del resolutor (210/211 y 217/218): 4.761 discos · 27.439 pistas · 10.729 personas · 605 `video_albums` · 6.580 `video_tracks`. `yt:reconcile --dry-run`: 0 relaciones y 0 revisiones nuevas. Fuera de E10, el run 219 (`review sincopa-organizations`) retiró 84 falsos sellos de Sincopa: organizaciones 767→683 y `merge_audit` 116.727→116.559, porque la historia retirada pasa al run. El run 220 dejó discos 4.761→4.736 · pistas 27.439→27.221 · personas 10.729→10.530 · créditos de disco 17.302→17.240 · créditos de pista 12.247→12.195 · `video_tracks` 6.580→6.635 · `video_albums` 605→609 · `merge_audit` 116.559→117.149; artistas y organizaciones sin cambios. Sus 37 auditorías (títulos alineados, enlaces de video y 3 fusiones de filas cuya evidencia solo estaba en auditorías previas) nacieron sin claim y `doctor` las marcó: `apply.ts` y `mergeInto` ahora enlazan esa evidencia, y las 37 se enlazaron a 326 claims |
| Verificación | `doctor` todo verde; typecheck limpio; suite completa (tras el parser Sincopa 1.1.0 y la corrección de auditorías del run 220): 44 archivos, 335 pruebas pasan y 1 se omite, la integración opcional con DeepSeek real; el contrato de E10 exige que ninguna auditoría del apply quede sin claim; E10 31/31 y contrato PostgreSQL de E10 + subida/rollback de 0012 en verde |

El desempate de la ficha que queda respeta, en orden, el canal, el tipo, la
cobertura de pistas y el título menos truncado. Esto evita conservar, por el
solo hecho de tener un id menor, «Demo» en lugar de «Adh Seidh» o
«!!! Estás Triste» en lugar de «Déjala! ...Está Triste».

Las variantes pueden formar cadenas (A↔B y B↔C). Aplicar una pareja puede
volver obsoleto el destino de otra: `ambiguity:apply` bloquea y comprueba cada
ficha en su propia transacción, salta la decisión obsoleta en vez de fusionar
otro id y exige repetir `ambiguity:scan`/`ambiguity:resolve` sobre el catálogo
resultante. Por eso la aprobación se hace por pasadas y nunca se reutiliza a
ciegas un plan anterior.

**Cola de revisión resuelta (2026-09-15, Brian delega).** Se cerraron con evidencia las 405 revisiones
abiertas: 56 pares de discos, 344 de personas y 5 `youtube_match`. Antes se hizo el respaldo
`backups/crv-20260915T063612Z`. Cada cierre deja en `resolution_note` el motivo o la ficha
en que quedaron las dos.

| Paso | Resultado |
|---|---|
| Run 225 (operador) | 294 filas de `review_queue` desemparejadas antes de fusionar: `review persons` no lo hace y `review_queue_distinct_persons_chk` abortaría el plan. 4 estudios creados como organizaciones `recording_studio`. 15 créditos y 1 membresía reasignados a la persona correcta y 2 créditos copiados (Cebollas Ardientes). 37 fusiones de discos con mapeo explícito de pistas: 3 pistas retiradas que no están en el disco del canal («Igual», «Isyormain», «Las Gorditas De Mario») y títulos y años corregidos con fuente (Manavello 1982, Puah «Traición» 2008, Torre de Marfil 2001, Enkdenados 2010, Claroscuro, Frente de Ira, «Cárcel, Muerte o Rock n Roll»). 28 pistas creadas desde los tracklists de 4 videos del canal. «Burrera» enlazada a B-Sides (2003) |
| Run 226 | `ambiguity:apply` de las 105 propuestas verificadas tal cual (93 MATCH de personas, 5 MATCH de discos y 7 KEEP): 105 aplicadas y 0 saltadas |
| Run 228 | `docs/decisions/2026-09-15-cola-revision-personas.json`: 177 fusiones, con la dirección corregida donde la propuesta conservaba la errata, y 12 personas-estudio pasadas a organización; 105 créditos equivalentes unidos |
| Cierre | 313 revisiones cerradas: 253 aprobadas y 60 descartadas. Incluyen 13 `ambiguous_alias` que nacieron al crear pistas homónimas de otros discos. Se retiraron 2 alias basura de discos («!!! Estás Triste», «EP»). Cola abierta: 0 |
| `yt:reconcile` (run 232) | 638 MATCHED_HIGH · 0 MATCHED_MEDIUM · 0 AMBIGUOUS; 28 `video_tracks` nuevas; 0 revisiones nuevas |
| Deltas y verificación | Discos 4.736→4.694 · pistas 27.221→26.860 · personas 10.530→10.248 · organizaciones 683→687 · créditos de disco 17.240→17.184 · créditos de pista 12.195→12.126 · `video_tracks` 6.635→6.664 · `merge_audit` 117.149→118.111 · claims 509.849→509.954. `doctor` todo verde |

Quedan pendientes, anotados en las notas de cierre:
- «D. en D.»/«D.D.» y «Despecho Nº 2»/«Despecho 2» no son personas; hay que retirarlas.
- «Pete Thomns» podría ser «Pete Thoms».
- Gloria Martín/Marín sigue sin evidencia.
- Años con una fuente cada uno: Frente de Ira 2010/2011, Krueger en vivo 2002/2003, Decade of Perversion 2002/2003, Psicosis 2005/2007 y Morbus 2004/2005.
- Organizaciones duplicadas: «Estudio Andreazulado» (73) y «Andreazulado's Studio» (177).
- Algunos créditos de compositor en Grupo Pan podrían ser de Carlos «Nené» Quintero.

### E11 — Hardening y auditoría final (plan: fase 11)

Los 13 escenarios del plan, repetir el caso Caramelos, búsqueda de secretos en
git, linter real (antes de E11 `npm run lint` era `tsc`), backups con `pg_dump` + `data/raw`
con prueba de restauración y `docs/FINAL_AUDIT.md`, `OPERATIONS.md`,
`ADDING_A_SOURCE.md` y `DATABASE_BACKUP_RESTORE.md`, con matriz
requisito/implementación/test/estado respaldada por evidencia.

Criterios de salida: restauración desde backup probada; `doctor` y suite
completa en verde en la máquina de producción.

**Cierre (2026-09-15).** Criterios de salida cumplidos en esta máquina, que
es la de producción (sirve la API, la web y la Mesa):

| Criterio | Evidencia |
|---|---|
| Restauración probada | `db:backup` → `backups/crv-20260915T011708Z` (45 min, 7,29 GB + crudo); `db:restore-check` → `RESTORE VERIFICADO` (1 h 42 min; 44 tablas / 2.105.173 filas, índices y constraints idénticos, 1.830 hashes del crudo, doctor verde en la copia) |
| `doctor` verde | Sobre la base real después de aplicar `0013_fk_indexes` (41 s): TODO VERDE |
| Suite completa | `npm test` 45 archivos / 358 pruebas (1 integración DeepSeek opt-in omitida); `test:contract` 132/132; `test:matrix` PG 15.19 y 16.14; `lint`, `typecheck` y build de `web/` en verde |
| 13 escenarios y Caramelos | `test/contract/hardening-scenarios.test.ts` 13/13; consulta de solo lectura sobre la base real |
| Secretos | Historial (51 commits) y los 42 archivos de E11 sin secretos reales |

Cambios de E11:
- ESLint real;
- migración `0013_fk_indexes`: el chequeo de FK en la tabla ER pasó de 3.965 ms a 0,37 ms;
- propuesta de fuente atómica y redacción de secretos en logs;
- pruebas de reintentos, cortesía y cuota;
- scripts `db:backup`, `db:restore` y `db:restore-check`;
- `OPERATIONS.md`, `ADDING_A_SOURCE.md`, `DATABASE_BACKUP_RESTORE.md` y
  `FINAL_AUDIT.md`.

No se tocó el core ni se añadieron fuentes.

**Post-cierre, mismo día.** El propietario resolvió KI-08 y KI-09 fuera del
alcance de E11: retiró la Mesa de Funnel (queda solo en el tailnet, puerto
9444) y activó `CRV_OPERATOR_TOKEN` para que `/crv` pueda escribir. Verificar
`/crv` tras el cambio descubrió KI-10, un bug real de producto sin relación
con E11: sin barra final la SPA cargaba en blanco por un basename mal armado
en `web/src/main.tsx`. Se corrigió y se verificó con Claude in Chrome contra
el dominio público. Detalle de los tres en `FINAL_AUDIT.md`.

### Post-cierre: E11.1 — endurecer la fusión de duplicados (2026-09-15)

Plan de mejora del CRUD y fusión de personas (`~/Desktop/PLAN_MEJORA_CRUD_Y_FUSION_DE_PERSONAS.md`),
etapa E11.1. Resuelve P1 (crítica), P3, P4, P6, P7, P8 y P9 del diagnóstico:

| Fallo | Antes | Ahora |
|---|---|---|
| P1 | Fusionar un par que el ER careó abortaba con 23514 (`review_queue_distinct_persons_chk`); afecta a 41 revisiones | La revisión se suelta (`detachedReviews`) y la fusión termina |
| P3 | En colisión de `claims_dedupe_uk` se borraba el claim y su evidencia en cascada | El claim queda `superseded` sin destino; la evidencia sobrevive |
| P4 | La auditoría enlazaba solo los 50 primeros claims | Todos (`unnest`), sin recorte |
| P6 | La auditoría guardaba solo el número de referencias movidas | `movedRefs` (clave primaria de cada fila) + `discardedRows` + `detachedReviews`, `version: 2` |
| P7 | Las membresías equivalentes quedaban duplicadas tras fusionar | `mergeEquivalentMemberships`; períodos contradictorios → revisión |
| P8 | Un UPDATE por fila con SAVEPOINT y un INFORMATION_SCHEMA por columna | Un UPDATE masivo por columna; una sola sentencia para completar columnas |
| P9 | `is_venezuelan=true` del duplicado se perdía | Se conserva (los DEFAULT del core cuentan como «vacío») |

Evidencia: `reports/e11.1-merge-hardening.md`, `test/contract/merge-into-hardening.test.ts`
(7/7: personas y artistas) y la sonda `scripts/probes/merge-probe.mts` (par 14 ← 3617 en
134–262 ms, antes fallaba en 4,9 s). Sin migraciones y sin tocar `public`.

### Post-cierre: E11.2–E11.10 — CRUD y fusión de fichas (2026-09-16)

Plan: `/home/brian/Desktop/PLAN_MEJORA_CRUD_Y_FUSION_DE_PERSONAS.md`. Se
completaron las nueve etapas restantes sobre el motor ya endurecido en E11.1.

| etapa | qué quedó |
| --- | --- |
| E11.1 | (previa) la fusión guarda las filas movidas, las descartadas y las revisiones que suelta en la auditoría |
| E11.2 | `ingest.entity_redirects` (migración 0014): el id fusionado responde `404` con `details.movedTo` y la web navega con aviso. La cadena se comprime al escribir |
| E11.3 | `src/merge/entity-merge.ts`: previsualización con `previewHash`, conflictos, campos que se completan, avisos y fusión transaccional con correcciones humanas (`stale_preview` → 409) |
| E11.4 | `GET /persons/:id/merge-preview` y `POST /persons/:id/merge` (y los mismos verbos para organizaciones y artistas) |
| E11.5 | `ingest.review_kind.person_duplicate` (0015) + índice único por par vivo (0016); detector `person-candidates` (bloqueo + pesos explicables) y CLI `crv review person-candidates`; `GET /persons/duplicate-candidates` |
| E11.6 | Web: modal de fusión con previsualización, página `/personas/duplicados`, QA visual contra contenedor desechable (`npm run test:visual-merge`) |
| E11.7 | `classifyPersonName` (organización, duración, fragmento, varias personas), conversión de persona a organización/artista y operación `split` en el plan de correcciones; filtro «Sospechosas» y aviso en la ficha |
| E11.8 | `src/merge/unmerge.ts` + `POST /merge-runs/:runId/undo` + botón «Deshacer esta fusión»; test de ida y vuelta por instantáneas |
| E11.9 | índice de búsqueda en memoria (sin tildes) con invalidación al escribir, filtros `hasCredits`/`suspect`/`sort` y contadores en el listado |
| E11.10 | fusión de organizaciones y artistas con el mismo servicio y modal, P13 (queda la ficha con más referencias), detector de candidatos de organización con la clave sin palabras de estudio y esta documentación |

Evidencia y mediciones: `reports/person-candidates-dryrun.md`,
`reports/person-junk-dryrun.md`, `reports/persons-search-probe.md`. Las sondas
son de solo lectura (la de fusión revierte su transacción) y están descritas en
`docs/OPERATIONS.md` §9.
