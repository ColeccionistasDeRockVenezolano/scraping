# CRV — Modelo de Datos

> Documento normativo. El esquema canónico del proyecto es `crv_simple_v1.sql`
> (PostgreSQL 15+, SHA-256 `b7e7d35ac517d44f3be04ac1b8b70892e16f7e4cf1aa9d3f7260fd929fdf3a3a`).
> Todo lo que se define aquí está subordinado a ese archivo. Véase
> `CRV_IMPLEMENTATION_CONTRACT.md` para las reglas de gobierno.

---

## 1. Principios

1. **El core no se toca.** Las tablas del esquema canónico no se eliminan,
   renombran ni rediseñan. No se añaden columnas, constraints ni índices sobre
   tablas core. Cualquier necesidad nueva se resuelve en el esquema auxiliar.
2. **Procedencia total.** Ningún dato llega a una tabla core sin una
   reclamación (`claim`) que diga quién lo afirmó, con qué confianza y con qué
   evidencia. El dato canónico es un *proyección* de claims aceptados.
3. **Hechos estructurados ≠ narrativa.** La biografía generada por IA vive
   fuera del core, separada de los hechos verificables.
4. **Configuración fuera del core.** Géneros aceptados, fuentes autorizadas y
   mapas de tipos viven en el esquema auxiliar.

---

## 2. Core canónico (esquema `public`) — inventario inmutable

Archivo: `crv_simple_v1.sql`. **7 enums, 10 tablas, 3 vistas y 23 índices**
(conteo verificado sobre el archivo el 2026-09-07). Se aplica *verbatim* como
migración baseline; nunca se regenera ni se "mejora".

### 2.1 Enums

| Enum | Valores |
|---|---|
| `artist_type` | band, solo_artist, duo, project, group, other |
| `album_type` | studio_album, live_album, ep, single, compilation, demo, soundtrack, collaboration_album, remix, other |
| `publication_status` | published, unlisted, unpublished, copyright_blocked, unknown |
| `archive_quality` | HQ, LQ, unknown |
| `archive_status` | published, unpublished, unknown |
| `organization_type` | record_label, production_company, recording_studio, distributor, management, other |
| `credit_type` | musician, guest, writer, composer, producer, recording, mixing, mastering, photography, artwork, other |

### 2.2 Tablas y qué información les corresponde

| Tabla core | Contenido legítimo (solo hechos verificados con claim aceptado) |
|---|---|
| `artists` | Identidad canónica de un artista venezolano o con proyecto venezolano: nombre canónico (UNIQUE), tipo, biografía factual, foto (URL), origen, años de formación/disolución, notas. |
| `persons` | Personas físicas (músicos, productores, escritores...). `nationality` opcional, `is_venezuelan` default false. **Personas extranjeras son válidas sin biografía exhaustiva** — solo identidad mínima. |
| `artist_members` | Membresía de persona en banda con rol y período. **Un crédito en un álbum NO genera membresía** (regla del merge engine). |
| `organizations` | Sellos, estudios, productoras, distribuidoras, managers. |
| `person_organizations` | Vínculo persona ↔ organización (rol + período). |
| `albums` | Lanzamiento canónico: título, año, tipo, género (string), sello (`label_id`), portada, descripción, **URLs externas primarias** (youtube/instagram/wordpress) con su estado de publicación. |
| `tracks` | Canciones de un álbum: número de disco/pista (UNIQUE por álbum), título, duración, `youtube_start_seconds` (timestamp de YouTube). |
| `album_credits` | Créditos a nivel de álbum. Exactamente UNO de person/artist/organization (CHECK). `credit_type` + `role`. |
| `track_credits` | Créditos a nivel de canción. Misma regla de exactamente-un-destino. |
| `album_formats` | Formatos del archivo digital del coleccionista (CD, Vinyl, Cassette, WAV, FLAC, MP3...), calidad, estado de archivo, `file_path` futura. |

### 2.3 Vistas core

`person_band_history`, `person_album_credits`, `person_track_credits` — son
proyecciones de lectura; se conservan tal cual.

---

## 3. Qué NO cabe en el core y dónde vive

| Necesidad | Por qué no cabe en core | Dónde vive |
|---|---|---|
| Registro de fuentes autorizadas | Las fuentes son metadatos de proceso, no hechos musicológicos | `ingest.sources` |
| HTML crudo descargado | Volumen, no es dato canónico | disco (`data/raw/`) + `ingest.raw_pages` |
| Reclamaciones (quién dijo qué) | El core guarda hechos, no afirmaciones | `ingest.claims` |
| Evidencia (dónde exactamente se vio) | Idem | `ingest.claim_evidence` |
| Aliases / variantes de nombre | El core solo tiene nombre canónico UNIQUE | `ingest.artist_aliases`, `person_aliases`, `organization_aliases`, `album_aliases`, `track_aliases` |
| Conflictos entre fuentes | Deben conservarse ambas afirmaciones sin tocar el canónico | `ingest.conflicts` |
| Cola de revisión humana | Proceso, no dato | `ingest.review_queue` |
| Géneros aceptados (configurables) | El core guarda `albums.genre` como string libre | `ingest.genres` |
| Biografías generadas por IA | Separadas de hechos estructurados | `ingest.ai_biographies` |
| Registro de videos de YouTube | La URL/estado en `albums` es la proyección; el video es una entidad de ingestión | `media.youtube_videos` (+ `media.video_albums`/`video_artists`/`video_tracks`) |
| Filas originales del seed (spreadsheet) | Inmutables, verbatim, incl. Upload Order | `ingest.seed_uploads` |
| Medios (imágenes) | Solo URL + fuente + metadatos, sin descarga masiva | `media.media_links` |
| Auditoría de cambios en core | Append-only | `ingest.merge_audit` (+ `merge_audit_claims`) |
| Ejecuciones de importación | Idempotencia | `ingest.scrape_runs` (+ `scrape_errors`) |
| Registro de llamadas a DeepSeek | Trazabilidad y caché de prompts | `ingest.ai_runs` |

---

## 4. Esquemas auxiliares `ingest` y `media` — especificación

Esquemas PostgreSQL separados (`ingest` y `media`). La separación física
hace **verificable** que el core queda intacto: el baseline solo crea objetos
en `public`; todas las migraciones posteriores solo crean objetos en `ingest`.
Los FKs hacia tablas core son válidos entre esquemas.

Las tablas marcadas `(especificación)` son el diseño objetivo; el DDL se
escribirá en la fase de implementación correspondiente (no en esta fase).

> **REALIZACIÓN (migraciones 0001–0007, verificadas contra PostgreSQL 16
> el 2026-09-08: `tests/run_all.sh` en verde, diff de `public` vacío).**
> Los nombres reales **mandan** sobre los provisionales de esta sección; la
> tabla de equivalencia normativa está en CONTRACT §11 y el detalle en
> `docs/db/ER_INGEST_MEDIA.md`. En resumen: `youtube_videos` y `media_links`
> viven en el schema **`media`**; `evidence` → `ingest.claim_evidence`;
> `entity_aliases` → 5 tablas con FK reales; `import_runs` →
> `ingest.scrape_runs` (+ `scrape_errors`); `audit_log` →
> `ingest.merge_audit` (+ `merge_audit_claims`); el enlace video↔álbum es la
> tabla N:N `media.video_albums`, no una columna. Estados de claim:
> `candidate/accepted/rejected/conflict/superseded`. La migración 0007 añade
> auditoría de ER, runs de DeepSeek y biografías editoriales trazables; el
> audit del CRUD humano sigue diferido a F7.
>
> La migración **`0004`** completa `ingest.review_kind` con los tipos de
> revisión que exige F2 (`missing_url`, `seed_incomplete`,
> `media_type_no_album`, `genre_unknown`, `new_source`, `low_confidence`,
> `ai_biography`, `ai_entity_resolution`).

### 4.1 `ingest.sources` — fuentes autorizadas

| Columna | Tipo | Notas |
|---|---|---|
| id | bigint identity PK | |
| slug | varchar(80) UNIQUE | identificador estable |
| name | varchar(200) | nombre humano |
| url | text | URL raíz autorizada |
| site_type | varchar(40) | blogspot \| wordpress \| website \| database \| instagram \| spreadsheet \| youtube_api |
| access_strategy | text | estrategia esperada (ver SOURCES.md) |
| requires_js | boolean | verificado empíricamente |
| trust_level | varchar(16) | high \| medium \| low (inicial; ver SOURCES.md) |
| enabled | boolean default false | **una fuente solo se scrapea si está enabled y aprobada** |
| public_display | boolean default false | no es requisito mostrar fuentes públicamente |
| notes | text | |

Seed: las 11 filas de `Links for Data Scrapping.xlsx` + `youtube_data_api` +
los dos XLSX como fuentes internas (`yt_master_seed`, `links_seed`).

### 4.2 `ingest.raw_pages` — almacenamiento crudo
*(realizado en 0001 + procedencia `run_id` en 0005)*

`id` PK · `source_id` FK → `ingest.sources` · `url` (URL solicitada) ·
`canonical_url` (tras redirects) · `http_status` (CHECK 100–599) ·
`content_type` · `sha256` (CHECK `^[0-9a-f]{64}$`) · `byte_size` ·
`stored_path` (disco, `data/raw/<source>/<sha>.html`) · `fetched_at` ·
`headers` JSONB (payload HTTP original) · `run_id` FK NULL →
`ingest.scrape_runs` (último run que descargó ese contenido; un cache hit no
lo cambia) · `created_at`.

**La clave de deduplicación es `UNIQUE(source_id, sha256)`, no la URL.** Es
deduplicación *por contenido*: si una página vuelve idéntica byte a byte, no
se crea una fila nueva, solo se actualiza `fetched_at`
(`src/cache/raw-pages.ts`). Consecuencia aceptada y documentada: dos URLs
distintas de la misma fuente que devuelvan bytes idénticos comparten una sola
fila, y la segunda URL no queda registrada como tal. La frescura se decide por
`fetched_at` contra `CRAWL_CACHE_TTL_DAYS` buscando por `url`/`canonical_url`.

### 4.3 `ingest.seed_uploads` — filas verbatim del YT Master Spreadsheet

Copia inmutable 1:1 de las 606 filas de datos:

| Columna | Notas |
|---|---|
| id | PK |
| upload_order | smallint, **se conserva exacto** (rango 1..607; el 9 no existe en el archivo) |
| artist_name_raw | varchar — valor original sin tocar |
| album_name_raw | varchar |
| album_year_raw | smallint NULL (19 filas sin año, todas Music Video o EMPTY) |
| type_raw | varchar — valor compuesto original (19 variantes) |
| url_raw | text NULL (86 filas sin URL, todas con Status=Unlisted) |
| status_raw | varchar — 'Unlisted' o vacío (87 filas 'Unlisted') |
| video_id | varchar(11) NULL — extraído de `watch?v=` o `youtu.be/` (520 filas) |
| row_number | smallint — fila física del XLSX (para trazabilidad) |
| row_hash | varchar(64) — sha256 de la fila completa (nombre real: `row_hash`, no `sha256`) |
| run_id | FK NULL → `ingest.scrape_runs` — qué import trajo la fila |
| imported_at | timestamptz |

Reglas de importación del seed (ver §6): las filas `EMPTY` (órdenes 97 y 440)
no generan entidades; van directas a `review_queue` (kind `seed_incomplete`).

### 4.4 `media.youtube_videos` — YouTube como fuente de primera clase

Realizada en el schema `media`:
`id` PK · `video_id` varchar(11) **UNIQUE** (CHECK `^[A-Za-z0-9_-]{11}$`) ·
`url` · `title` · `description` · `channel_id` · `channel_title` ·
`published_at` · `duration_seconds` · `thumbnail_url` ·
`publication_status` (**reutiliza el enum core `public.publication_status`**) ·
`metadata` JSONB (snapshot sin procesar de la Data API) · `first_seen_at` ·
`last_fetched_at` · `seed_upload_id` FK → `ingest.seed_uploads` ·
`created_at` · `updated_at`.

El `upload_order` **no se duplica aquí**: se obtiene por
`seed_upload_id → ingest.seed_uploads.upload_order`, que es su única fuente.

**Enlace video ↔ core: tres tablas N:N, ninguna columna directa.**

| Tabla | Une | Campos propios |
|---|---|---|
| `media.video_albums` | video ↔ `albums` | `album_kind` (`full_album \| music_video \| live_concert \| documentary \| other`), `is_primary_link`, `confidence`, `source_id` |
| `media.video_artists` | video ↔ `artists` | `relation_kind` (`performer \| channel \| subject \| other`) |
| `media.video_tracks` | video ↔ `tracks` | posición/marca temporal |

- `media.video_albums` es el **único** mecanismo que conecta videos con
  álbumes. **Nunca se crea un álbum a partir de un video** (decisión de
  gobierno 19): no existe ninguna ruta de escritura video → `INSERT albums`.
- Garantías realizadas: PK (video_id, album_id) impide enlaces duplicados;
  el índice parcial `video_albums_one_primary_per_album_uk` admite **un solo
  enlace primario por álbum**; `video_albums_primary_confidence_chk` impide
  que un enlace `low` sea el primario.
- La sincronización usa **solo YouTube Data API** (`videos.list` con los IDs
  ya conocidos, hasta 50 por llamada; `search.list` opcional y acotado para
  enriquecimiento por artista). Prohibido el scraping visual de YouTube.

### 4.5 `ingest.claims` — reclamaciones (corazón del sistema)
*(realizado en 0003: destinos como FKs reales por tipo de entidad, no un
`core_id` genérico)*

`id` PK · `source_id` FK → `ingest.sources` · `raw_page_id` FK NULL ·
`seed_upload_id` FK NULL · `entity_kind` `ingest.claim_entity_kind` (artist \|
person \| organization \| album \| track \| artist_membership \|
person_organization \| album_credit \| track_credit \| album_format \|
**youtube_video**) · **11 columnas FK reales** (`artist_id`, `person_id`,
`organization_id`, `album_id`, `track_id`, `artist_membership_id`,
`person_organization_id`, `album_credit_id`, `track_credit_id`,
`album_format_id`, `video_id`) · `field` varchar(80) (release_year, title,
genre, biography...) · `raw_value` JSONB NOT NULL (valor estructurado
original) · `normalized_value` JSONB · `raw_hash` varchar(64) ·
`extractor` + `extractor_version` (parser/adaptador y versión) ·
`confidence` `ingest.confidence_level` (**high \| medium \| low**) ·
`status` `ingest.claim_status` (**candidate** \| accepted \| rejected \|
conflict \| superseded) · `created_by` `ingest.actor_kind` (system \| ai \|
human) · `run_id` FK NULL → `ingest.scrape_runs` · `notes` · `created_at` ·
`updated_at`.

La migración `0007_entity_resolution_ai` añade `identity_raw` (identidad
recibida intacta), `identity_key` (normalización primaria con tildes) e
`identity_secondary_key` (forma sin diacríticos, solo señal secundaria). Las
claves derivadas nunca sustituyen `raw_value` ni la evidencia original.

Constraints de destino (mismo patrón anti-polimorfismo que `album_credits` en
el core):

- `claims_one_target_chk`: exactamente **una** FK de destino, o **ninguna** —
  el caso "cero destinos" es una propuesta de entidad todavía inexistente.
- `claims_kind_matches_target_chk`: la FK llena tiene que corresponder al
  `entity_kind` declarado.

**Dedupe (idempotencia):** índice único `claims_dedupe_uk` sobre
`(source_id, COALESCE(raw_page_id,0), COALESCE(seed_upload_id,0), entity_kind,
COALESCE(<cada FK de destino>,0), field, raw_hash)`, con
`raw_hash = sha256(canonical_json(raw_value))`. Incluye la página y el destino
porque dos páginas distintas de la misma fuente **sí** pueden afirmar lo mismo
y ambas evidencias importan.

### 4.6 `ingest.claim_evidence` — dónde exactamente se vio el claim

*(realizado en 0003)*

`id` PK · `claim_id` FK · `raw_page_id` FK NULL · `seed_upload_id` FK NULL ·
`url` · `excerpt` text (fragmento textual) · `selector` varchar(300) ·
`position` int · `evidence_hash` varchar(64) (de excerpt+url; nombre real, no
`sha256`) · `captured_at` · `UNIQUE(claim_id, evidence_hash)`.

Un claim puede tener N evidencias. En conflictos **ambas afirmaciones y sus
evidencias se conservan** (§7).

### 4.7 Tablas de alias — variantes de nombre para resolución
*(realizado en 0003 como 5 tablas: `ingest.artist_aliases`, `person_aliases`,
`organization_aliases`, `album_aliases`, `track_aliases`. No hay
`entity_kind`/`core_id`: cada tabla tiene la FK real a su tabla core)*

Columnas de cada una (`<entidad>_id` es `artist_id`, `person_id`,
`organization_id`, `album_id` o `track_id`):

`id` PK · `<entidad>_id` FK NOT NULL → tabla core (ON DELETE CASCADE) ·
`alias` varchar(200) · `alias_type` `ingest.alias_type` (**name_variant \|
spelling_variant \| former_name \| stage_name \| acronym \| misspelling \|
alternate_title \| other**) · `normalized_alias` varchar(200) NOT NULL (forma
comparable, la que usa entity resolution) · `is_primary` boolean ·
`confidence` `ingest.confidence_level` · `source_id` FK NULL ·
`raw_page_id` FK NULL · `claim_id` FK NULL (evidencia de origen) · `notes` ·
`created_at` · `UNIQUE(<entidad>_id, alias)` + índice parcial único de un solo
alias primario por entidad.

### 4.8 `ingest.conflicts` — desacuerdos entre fuentes

*(realizado en 0003)*

`id` PK · `claim_a_id` FK · `claim_b_id` FK · `entity_kind`
`ingest.claim_entity_kind` · `field` varchar(80) · `value_a` JSONB ·
`value_b` JSONB · `status` `ingest.conflict_status` (open \| resolved_a \|
resolved_b \| both_kept \| dismissed) · `resolution_note` text ·
`resolved_by` `ingest.actor_kind` · `created_at` · `resolved_at` ·
CHECK `claim_a_id <> claim_b_id` · `UNIQUE(claim_a_id, claim_b_id, field)`.

No lleva `core_id`: la entidad afectada se obtiene de los propios claims, que
ya tienen FK real al core.

**Invariante:** mientras un conflicto está `open`, el campo canónico afectado
no se modifica; ambas afirmaciones quedan citadas con evidencia.

### 4.9 `ingest.review_queue` — cola de revisión

Realizada con FKs reales a cada entidad implicada (`claim_a_id`/`claim_b_id`,
`conflict_id`, `artist_a_id`/`artist_b_id`, `person_*`, `organization_*`,
`album_id`, `track_id`, `video_id`) más `payload` JSONB, `priority` (1-10),
`status` (`open \| in_progress \| approved \| dismissed`), `resolved_by`
(`system \| ai \| human`) y `resolution_note`.

`kind` es el enum `ingest.review_kind`, con 16 valores. **De la migración
0003** (resolución de identidad y conflictos): `possible_duplicate`,
`field_conflict`, `ambiguous_alias`, `album_match`, `person_match`,
`organization_match`, `youtube_match`, `manual_review`. **De la migración
0004** (ingestión del seed e IA, exigidos por F2 y por el escenario de
aceptación): `missing_url`, `seed_incomplete`, `media_type_no_album`,
`genre_unknown`, `new_source`, `low_confidence`, `ai_biography`,
`ai_entity_resolution`. Qué columnas llena cada kind:
`docs/db/ER_INGEST_MEDIA.md` §5.

### 4.10 `ingest.genres` — géneros aceptados (configurables)

`id` PK · `name` varchar(100) UNIQUE · `active` boolean default true · `notes`.

`albums.genre` (core, string) se valida contra esta tabla en la capa de
normalización. Valor no listado → no bloquea la ingesta: se acepta el claim
pero se abre `review_queue(genre_unknown)`.

### 4.11 `ingest.ai_biographies` — narrativa generada por IA (separada)
*(realizado en 0007)*

`id` PK · `entity_kind` (ARTIST \| PERSON) · FKs reales `artist_id` /
`person_id` con CHECK de exactamente un destino · `ai_run_id` FK RESTRICT ·
`body` · `facts_snapshot` JSONB · `model` · `prompt_version` · `status`
(draft \| approved \| rejected) · `review_queue_id` FK · `created_at`.
`ingest.ai_biography_claims` enlaza cada borrador con todos los claims
aceptados que la respuesta citó. El generador excluye claims conflictivos y
rechaza IDs no suministrados. Aprobar un borrador solo cambia este artefacto y
su review: **nunca** copia texto a `artists.biography`/`persons.biography` ni
modifica hechos estructurados.

### 4.12 `media.media_links` — imágenes y medios (sin descarga masiva)

*(realizado en 0002)*

`id` PK · `entity_kind` varchar(20) (CHECK artist \| person \| organization \|
album) · **4 FKs reales** (`artist_id`, `person_id`, `organization_id`,
`album_id`) con `media_links_one_target_chk` (exactamente un destino) y
`media_links_kind_matches_target_chk` (el destino corresponde al kind) ·
`url` text · `media_type` varchar(20) (cover \| artist_photo \| scan \| logo \|
other) · `source_id` FK NULL · `meta` JSONB (título, dimensiones si la fuente
las da) · `created_at` · índice único sobre
`COALESCE(<cada FK>,0) + url` (equivalente al viejo
`UNIQUE(entity_kind, core_id, url)`, pero con integridad referencial real).

Se almacena URL + fuente + metadatos. Prohibida la descarga masiva de
imágenes; solo `artists.picture_url` / `albums.cover_url` se proyectan al
core cuando un claim de media es aceptado.

### 4.13 `ingest.scrape_runs` — ejecuciones de importación
*(+ `ingest.scrape_errors`: un error de fila nunca aborta el run)*

*(realizado en 0001)*

`id` PK · `kind` `ingest.run_kind` (seed_yt \| scrape_source \| yt_api_sync \|
enrich_artist \| merge_run \| manual) · `source_id` FK NULL ·
`status` `ingest.run_status` (running \| ok \| partial \| failed) ·
`started_at` · `finished_at` (CHECK `>= started_at`) · `params` JSONB ·
`counters` JSONB (total, created, updated, skipped, failed, queued_review) ·
`error_log` text · `created_at`.

`ingest.scrape_errors`: `id` PK · `run_id` FK NOT NULL (ON DELETE CASCADE) ·
`raw_page_id` FK NULL · `url` · `error_kind` (CHECK http_error \| network \|
parse \| validation \| extraction \| other) · `message` · `retry_count` ·
`occurred_at`.

### 4.14 `ingest.ai_runs` — auditoría de llamadas a DeepSeek
*(realizado en 0007)*

`id` PK · `prompt_hash` varchar(64) UNIQUE (caché/idempotencia de costo) ·
`task_kind` · `model` · `schema_version` · `status` (validated \| rejected \|
failed) · `input_summary`/`output_summary` · payloads request/response ·
`raw_response` · tokens in/out · error · `created_at`. Solo una respuesta
`validated` puede reutilizarse desde caché.

La misma migración crea `ingest.entity_resolution_decisions`: tipo ARTIST /
PERSON / ALBUM / TRACK / ORGANIZATION, FKs reales opcionales al candidato,
nombre original y normalizado, contexto, score [0..1], acción
AUTO_MATCH/POSSIBLE_MATCH/REVIEW/NO_MATCH, `features`, candidatos, thresholds,
explicación y vínculo opcional al `ai_run`. Es el registro explicable de cada
resolución; una propuesta DeepSeek no cambia por sí sola la acción ni el core.

### 4.15 `ingest.merge_audit` — auditoría append-only
*(+ `ingest.merge_audit_claims`: qué claims respaldan cada escritura)*

*(realizado en 0003)*

`id` PK · `run_id` FK NULL → `ingest.scrape_runs` (qué run lo ejecutó) ·
`entity_kind` `ingest.claim_entity_kind` (restringido a las 10 entidades core;
`youtube_video` no aplica: el merge solo escribe en `public`) · **10 FKs
reales** al core con `merge_audit_one_target_chk` (exactamente un destino) y
`merge_audit_kind_matches_target_chk` · `field` varchar(80) ·
`old_value` JSONB (NULL = inserción) · `new_value` JSONB (NULL = borrado) ·
`reason` text NOT NULL · `confidence` `ingest.confidence_level` ·
`performed_by` `ingest.actor_kind` (system \| ai \| human) · `at` timestamptz ·
CHECK `old_value IS DISTINCT FROM new_value`.

Las **fuentes** de cada escritura no son una columna: son la tabla puente
`ingest.merge_audit_claims` (merge_audit ↔ claims), que permite N claims de N
fuentes respaldando un mismo cambio.

Todo write sobre tablas core pasa por el merge engine y deja su entrada aquí.

---

## 5. Mapeo del YT Master Spreadsheet

Hoja única `Sheet1`, cabecera en fila 1: `Upload Order | Artist Name |
Album Name | Album Year | Type of Album | URL | Status`. 606 filas de datos.

| Columna | Destino | Regla |
|---|---|---|
| Upload Order | `seed_uploads.upload_order` → `youtube_videos.upload_order` | Conservar exacto; no renumerar. Falta el 9 en el archivo: no se inventa. |
| Artist Name | claim sobre `artists.name` (nueva entidad si no existe) | Normalizar (NFC, trim — corrige 'Soleà ' con espacio final) sin alterar `*_raw`. `Various Artists` (50 filas) **no** crea un artist; se registra como compilación multi-artista en `notes` del claim. |
| Album Name | claim sobre `albums.title` | Solo si el tipo es de álbum (ver matriz §6). |
| Album Year | claim sobre `albums.release_year` | 587/606 filas lo tienen; 19 sin año son Music Video o EMPTY → no aplica. |
| Type of Album | controla el flujo (§6) | Valor compuesto se tokeniza por ', '. |
| URL | `seed_uploads.url_raw` + extracción de `video_id` | 520 URLs: 496 `www.youtube.com/watch?v=` y 24 `youtu.be/` cortas. Parámetros de UI presentes: **93 con `&t=`** y **60 con `&pp=`**; ambos se ignoran al derivar el ID y la URL canónica. Los 520 IDs extraídos son **todos distintos**. 86 filas sin URL → revisión `missing_url`. |
| Status | claim de disponibilidad | 'Unlisted' (87) → `unlisted`; vacío → `unknown` hasta que la Data API lo confirme. |

### Matriz Type of Album → flujo

El campo tiene **19 valores distintos no nulos** (más 2 filas sin valor, las
`EMPTY`), de los cuales **8 son compuestos** (contienen ', '). Al dividirlos
se obtienen **13 tokens distintos**:

| Token | Acción |
|---|---|
| Studio Album (378) · EP (51) · Compilation Album (55) · Live Album (34) · Single (23) · Demos (14) | → crean/actualizan álbum en core vía claim (seed = high confidence). Mapping a `album_type`: Studio Album→`studio_album`, EP→`ep`, Compilation Album→`compilation`, Live Album→`live_album`, Single→`single`, Demos→`demo`. |
| B-Sides (9) | → álbum con `album_type='other'`, valor original en `notes`/claim (el enum no tiene b-sides). |
| Unplugged (3) | → `live_album` con nota 'Unplugged' conservada. |
| Solo Artist (61, siempre en compuestos) | → claim de `artist_type='solo_artist'` sobre el artista; NO afecta al álbum. |
| Remix (4, en compuestos) | → `album_type='remix'` cuando acompaña a Single/Compilation como nota/claim secundario. |
| **Music Video (17) · Live Concert (17) · Documentary (5)** | → **NO crean álbum** (decisión de gobierno). Solo `youtube_videos` + intento de link a álbum existente por título/año. |
| Compuestos con token de video (`Live Concert, Single`, `Live Concert, Documentary`) | → regla conservadora: si hay token tipo video, NO se auto-crea álbum; se abre `review_queue(media_type_no_album)` con ambos tokens. |
| Filas `EMPTY` (2) | → `review_queue(seed_incomplete)`, sin entidades. |

`Solo Artist, X` → se aplican ambas reglas: artist_type para el artista +
acción del segundo token para el álbum.

### Anomalías de identidad detectadas en el seed (material para entity resolution)

**Pares (artist, album) repetidos: 8**, de los cuales **7 son lanzamientos
reales duplicados** y 1 es el par `EMPTY`/`EMPTY` (órdenes 97 y 440, que no
generan entidades). Los 7 reales, verificados el 2026-09-07:

| Artista | Álbum | Fila A | Fila B |
|---|---|---|---|
| Americania | Otra Tarde Más | 381 · 2009 · Single | 583 · s/año · Music Video |
| Caramelos De Cianuro | En Vivo | 370 · 2009 · Live Album | 553 · 2009 · Live Concert |
| Claroscuro | Miel | 403 · 2002 · Single, Remix | 575 · s/año · Music Video |
| Desorden Público | En Vivo En El Teresa Carreño | 135 · 2004 · Live Album | 574 · 2004 · Live Concert |
| Joudy Ju | Acústico | 512 · 2013 · Live Album | 573 · 2013 · Unplugged |
| Los Amigos Invisibles | En Una Noche Tan Linda Como Esta | 334 · 2008 · Live Album | 552 · 2008 · Live Concert |
| Metrozubdivision | CCS | 24 · **2007** · Live Album | 584 · **2006** · Live Concert |

Regla: el par (artist, título normalizado) resuelve a **un único álbum**; cada
fila genera su propia fila en `media.youtube_videos`; si los años o tipos
difieren → conflicto conservado + revisión. El par `Metrozubdivision / CCS`
es un **conflicto de año interno al propio seed** (2007 vs 2006) y sirve como
fixture obligatorio del motor de conflictos.

**Colisiones de nombre de artista** (259 cadenas distintas → 257 tras
normalizar). Como `artists.name` es UNIQUE en el core, una importación
ingenua crearía entidades duplicadas:

| Caso | Valores crudos | Tratamiento |
|---|---|---|
| Espacio final | `'Soleà'` / `'Soleà '` (orden 593) | Normalización determinista (trim) → 1 artista + alias |
| Solo la tilde | `'Pacifica'` / `'Pacífica'` | **No se fusiona automáticamente**: candidato a `possible_duplicate` en revisión; una tilde puede distinguir dos bandas reales |

**Caveat de parsing:** las celdas numéricas del XLSX llegan como flotantes
(`'350.0'` para Upload Order, `'2009.0'` para año). El importador convierte a
entero y conserva el valor crudo. Rango real de años: **1964–2023** (encaja
en `SMALLINT` y en la validación 1900..2100).

---

## 6. Claves de idempotencia (resumen operativo)

| Entidad | Clave natural / mecanismo |
|---|---|
| artists | `name` UNIQUE (core). Búsqueda normalizada + alias table. |
| persons | sin UNIQUE en core → dedupe por (nombre normalizado + alias) en el merge engine bajo **advisory lock** `pg_advisory_xact_lock(hashtext('merge:person:<norm>'))` |
| organizations | ídem persons. |
| albums | candidato: (artist_id, title normalizado). El core solo tiene índice no-único → la unicidad se garantiza en el merge engine con advisory lock `merge:album:<artist_id>:<title_norm>`. **No se añade índice único a la tabla core** (regla de inmutabilidad). |
| tracks | UNIQUE(album_id, disc_number, track_number) (core) |
| artist_members | (artist_id, person_id); mismo par + mismo período → skip; período distinto → review |
| album_credits / track_credits | dedupe por (album/track_id, destino, credit_type, role normalizado) |
| album_formats | (album_id, format) |
| claims | índice real `claims_dedupe_uk`: (source_id, COALESCE(raw_page_id,0), COALESCE(seed_upload_id,0), entity_kind, destino, field, raw_hash) |
| raw_pages | UNIQUE(source_id, sha256): mismo contenido 1x por fuente; re-descarga de una URL = fila nueva (historia) |
| youtube_videos | `media.youtube_videos.video_id` UNIQUE (validado por CHECK `^[A-Za-z0-9_-]{11}$`) |
| video↔álbum | PK (video_id, album_id) en `media.video_albums` + índice parcial `video_albums_one_primary_per_album_uk`: **un solo enlace primario por álbum** |
| seed_uploads | `upload_order` UNIQUE + `row_hash` (sha-256 de la fila) |

Además: re-ejecutar una importación compara los `ingest.scrape_runs` previos
y salta lo ya procesado (skip); el contrato de aceptación exige ejecutar cada
importación 2 veces y verificar conteos idénticos.

---

## 7. Cadena de procedencia (de la fuente al dato canónico)

```
fuente (sources)
   │  GET con fetcher (política de cortesía + robots.txt)
   ▼
raw_pages (HTML crudo en disco, hash)
   │  scraper adapter por fuente → normalización (Zod)
   ▼
claims (raw_value + normalized_value + confidence + created_by)
   │  entity resolution (normalize → alias/contexto → fuzzy solo señal → DeepSeek propuesta)
   │  merge engine según confianza (ver CONTRACT §4)
   ▼
tablas core (artists, persons, organizations, albums, tracks, credits…)
   │  cada write deja entrada en ingest.merge_audit (+ merge_audit_claims)
   ▼
claim_evidence / conflicts conservan toda afirmación divergente
```

En un conflicto, la tabla core **nunca** se toca hasta resolución humana; las
dos afirmaciones viven en `ingest.conflicts` con sus evidencias.
