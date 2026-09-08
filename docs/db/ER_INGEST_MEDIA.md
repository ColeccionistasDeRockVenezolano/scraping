# CRV · Documentación ER — schemas `ingest` y `media`

> Documentación autoritativa de la capa auxiliar de PostgreSQL (migraciones
> `migrations/0001…0003`). El core canónico (`crv_simple_v1.sql`, schema
> `public`) no forma parte de esta capa y **no fue modificado**: las
> migraciones solo crean objetos en `ingest` y `media`.
> Verificación automática: `tests/run_all.sh` (diff de `public` antes/después
> = vacío, incluido rollback).

---

## 1. Convenciones

- **Esquemas:** `ingest` (proceso de datos) y `media` (medios/YouTube).
- **FKs reales al core** (`public.*`) en todas las tablas cuyo destino es una
  entidad core concreta. El patrón anti-polimorfismo usado (mismo que el core
  usa en `album_credits`) es "N columnas FK + CHECK de exactamente un destino";
  solo `claims` permite también el caso "cero destinos" (propuesta de entidad
  nueva, justificado en §4).
- **JSONB** solo donde la naturaleza del dato lo exige: payloads originales
  (`raw_pages.headers`, `youtube_videos.metadata`), valores de campos libres
  (`claims.raw_value/normalized_value`, `merge_audit.old/new_value`,
  `conflicts.value_a/b`), parámetros/conteos de runs y extras de review.
  Todo lo estructurado vive en columnas tipadas con CHECK.
- **Nombres:** snake_case, tablas en plural, FKs `<entidad>_id`, PK `id
  BIGINT GENERATED ALWAYS AS IDENTITY`.
- **Orden de migración:** 0001 (ingest base) → 0002 (media) → 0003 (claims/
  identidad). Reversibles: down en orden inverso. Cada up es transaccional e
  idempotente a nivel DDL.

## 2. Enums nuevos

| Enum | Valores |
|---|---|
| `ingest.trust_level` | high, medium, low, api |
| `ingest.run_kind` | scrape_source, seed_yt, yt_api_sync, enrich_artist, merge_run, manual |
| `ingest.run_status` | running, ok, partial, failed |
| `ingest.confidence_level` | high, medium, low |
| `ingest.claim_status` | candidate, accepted, rejected, conflict, superseded |
| `ingest.claim_entity_kind` | artist, person, organization, album, track, artist_membership, person_organization, album_credit, track_credit, album_format, youtube_video |
| `ingest.actor_kind` | system, ai, human |
| `ingest.review_kind` | **0003:** possible_duplicate, field_conflict, ambiguous_alias, album_match, person_match, organization_match, youtube_match, manual_review · **0004:** missing_url, seed_incomplete, media_type_no_album, genre_unknown, new_source, low_confidence, ai_biography, ai_entity_resolution |
| `ingest.review_status` | open, in_progress, approved, dismissed |
| `ingest.alias_type` | name_variant, spelling_variant, former_name, stage_name, acronym, misspelling, alternate_title, other |
| `ingest.conflict_status` | open, resolved_a, resolved_b, both_kept, dismissed |
| `media.video_relation_kind` | performer, channel, subject, other |
| `media.video_album_kind` | full_album, music_video, live_concert, documentary, other |

Nota: `media.youtube_videos.publication_status` **reutiliza** el enum core
`public.publication_status` (uso de lectura; el enum core no se modifica).

## 3. Diagrama ER (resumen)

```
                    public (CORE, inmutable)
 artists ─┬─ persons ── organizations ── albums ── tracks ── album/track_credits
          │                                    ▲  ▲  ▲
          └────────────── FKs reales ──────────┘  │  │
                                                  │  │
 ingest                                             │  │
 ┌──────────────────────────────────────────┐      │  │
 │ sources 1─∞ raw_pages 1─∞ claim_evidence │      │  │
 │   ▲                    ▲                  │      │  │
 │ scrape_runs ──∞ scrape_errors            │      │  │
 │   ▲                                       │      │  │
 │ seed_uploads ─────────┐                   │      │  │
 │ genres                │                   │      │  │
 │   claims ─────────────┼─∞ claims─∞ conflicts (a/b) │
 │     │        └───────►│ (source_id, raw_page_id,  │
 │     │                 │  seed_upload_id, run_id)  │
 │     ├─∞ claim_evidence│                           │
 │     ├─ artist_aliases ├ person_aliases            │
 │     ├─ organization_aliases ├ album_aliases       │
 │     └─ track_aliases (FK reales al core)          │
 │ review_queue (FKs a claims/conflicts/core/media)  │
 │ merge_audit ─∞ merge_audit_claims ─∞ claims       │
 └──────────────────────────────────────────┘
 media
 ┌──────────────────────────────────────────┐
 │ youtube_videos ◄─∞ video_artists ─► artists      │
 │      ▲           video_albums ─► albums (1 prim.)│
 │      └────────── video_tracks ─► tracks (occur.) │
 │ media_links ─► artist|person|organization|album  │
 └──────────────────────────────────────────┘
```

## 4. Catálogo de tablas

### ingest

**sources** — fuentes autorizadas (conjunto cerrado).
`slug` UNIQUE · `url` · `site_type` (CHECK: blogspot/wordpress/website/
database/instagram/spreadsheet/youtube_api) · `access_strategy` ·
`requires_js` · `trust_level` · `enabled=false` por defecto (solo se scrapea
lo aprobado) · `public_display=false` por defecto.

**raw_pages** — páginas concretas procesadas.
`source_id` FK · `url` (solicitada) · `canonical_url` (tras redirects) ·
`http_status` (CHECK 100–599) · `content_type` · `sha256` (CHECK hex64) ·
`byte_size` · `stored_path` (snapshot crudo en disco) · `fetched_at` ·
`headers` JSONB (payload original). `UNIQUE(source_id, sha256)` = el mismo
contenido no se almacena dos veces por fuente; la re-descarga de una URL crea
fila nueva (historia, evidencia preservada).

**scrape_runs** — ejecuciones de scraping/importación.
`kind` · `source_id` FK NULL (SET NULL) · `status` · `started_at/finished_at`
(CHECK finished ≥ started) · `params` JSONB · `counters` JSONB · `error_log`.
Es el `import_runs` del contrato (DATA_MODEL §4.13), realizado aquí como
tabla única para todos los tipos de run.

**scrape_errors** — errores por página/run.
`run_id` FK CASCADE · `raw_page_id` FK NULL · `url` · `error_kind` (CHECK) ·
`message` · `retry_count` · `occurred_at`.

**seed_uploads** — copia verbatim e inmutable del YT Master Spreadsheet.
`upload_order` UNIQUE (se conserva exacto) · `*_raw` (valores originales) ·
`video_id` (CHECK `^[A-Za-z0-9_-]{11}$`) · `row_number` · `row_hash` hex64 ·
`run_id`. Base de procedencia de los claims del seed.

**genres** — géneros aceptados, configurables. `name` UNIQUE · `active`.
`albums.genre` (core) se valida contra esta tabla; desconocido → review, no
bloqueo.

**claims** — "la fuente X afirma el valor Y sobre el campo Z de la entidad E".
- `source_id` FK NOT NULL (RESTRICT) · `raw_page_id`/`seed_upload_id` FK NULL.
- Destino: 11 FKs reales (artist/person/organization/album/track/
  artist_membership/person_organization/album_credit/track_credit/
  album_format + media.youtube_videos) con CHECK **exactamente un destino o
  ninguno** y CHECK de coherencia `entity_kind`↔FK. El caso "ninguno" es la
  **propuesta de entidad nueva** (aún no canónica): justificación técnica del
  único uso polimórfico residual — una propuesta no puede tener FK porque la
  fila core no existe todavía; se identifica por `entity_kind` + valores.
- `field` · `raw_value` JSONB NOT NULL (valor estructurado original) ·
  `normalized_value` JSONB · `raw_hash` hex64 · `extractor` +
  `extractor_version` (parser/adaptador y versión) · `confidence` ·
  `status` (candidate/accepted/rejected/conflict/superseded) · `created_by` ·
  `run_id` · timestamps.
- Dedupe (idempotencia): índice único sobre (source_id, COALESCE(raw_page_id),
  COALESCE(seed_upload_id), entity_kind, COALESCE(destinos), field, raw_hash).
  Limitación documentada: dos propuestas del mismo source+página+campo con
  raw_value idéntico colisionan; el pipeline lo evita incluyendo contexto
  (sección/posición) en `raw_value`.
- Conservación de contradicciones: dos claims sobre el mismo campo pueden
  coexistir (status `conflict` vs `accepted`); el dato canónico solo cambia
  por decisión del merge engine, nunca por la mera existencia de un claim.

**claim_evidence** — dónde se vio el claim. `claim_id` FK CASCADE ·
`raw_page_id`/`seed_upload_id` · `url` · `excerpt` · `selector` · `position` ·
`evidence_hash` hex64 · UNIQUE(claim_id, evidence_hash).

**artist_aliases / person_aliases / organization_aliases / album_aliases /
track_aliases** — identidad: variantes ortográficas, nombres anteriores,
nombres artísticos, siglas, títulos alternativos. Cinco tablas simétricas con
**FK real** a su entidad core (CASCADE): `alias` · `alias_type` ·
`normalized_alias` (para búsquedas) · `is_primary` · `confidence` ·
`source_id`/`raw_page_id`/`claim_id` (evidencia de origen) · `notes`.
Constraints: UNIQUE(entidad, alias); índice parcial único = un solo alias
primario por entidad; índice sobre `normalized_alias` para entity resolution.

**conflicts** — desacuerdos entre fuentes.
`claim_a_id`/`claim_b_id` FK (CHECK a≠b) · `entity_kind` · `field` ·
`value_a`/`value_b` JSONB (snapshots: **ambas afirmaciones se conservan**
aunque los claims cambien) · `status` (open/resolved_a/resolved_b/both_kept/
dismissed) · `resolution_note` · `resolved_by` · `resolved_at`.
UNIQUE(claim_a_id, claim_b_id, field). Invariante del contrato: mientras esté
`open`, el campo canónico no se modifica.

**review_queue** — cola de revisión. `kind` · `status` (open/in_progress/
approved/dismissed) · `priority` 1–10 · FKs por kind (ver §5) · `payload`
JSONB (extras específicos del kind) · `resolved_by` · `resolution_note`.
CHECKs de par distinto (claims/artists/persons/organizations).

**merge_audit** — TODA modificación automática del pipeline sobre el core.
`run_id` · `entity_kind` + 10 FKs reales con CHECK **exactamente un destino**
(siempre apunta a una fila core existente) · `field` · `old_value` JSONB
(NULL = inserción) · `new_value` JSONB (NULL = borrado) · `reason` ·
`confidence` · `performed_by` · `at`. CHECK `old IS DISTINCT FROM new`.
Append-only.

**merge_audit_claims** — fuentes de cada modificación (N claims por entrada).

**schema_migrations** — bookkeeping del harness de migraciones (versión +
applied_at). Vive en `ingest`, nunca en `public`.

### media

**youtube_videos** — registro canónico de videos (fuente de primera clase).
`video_id` UNIQUE CHECK 11 chars · `url` · `title` · `description` ·
`channel_id` · `channel_title` · `published_at` · `duration_seconds` ·
`thumbnail_url` · `publication_status` (enum core, sin modificarlo) ·
`metadata` JSONB (snapshot original de la Data API) · `first_seen_at` ·
`last_fetched_at` · `seed_upload_id` FK NULL.

**video_artists** — N:N video↔artist. PK(video_id, artist_id, relation_kind) ·
`relation_kind` (performer/channel/subject/other) · `confidence` ·
`source_id` · `claim_id` (procedencia del vínculo). Un video puede
relacionarse con múltiples artistas y viceversa.

**video_albums** — N:N video↔album. PK(video_id, album_id) · `album_kind`
(full_album/music_video/live_concert/documentary/other) ·
**`is_primary_link`** (el video principal del álbum: se proyecta a
`albums.youtube_url`, core) · `confidence` · `source_id` · `claim_id`.
- Un álbum puede tener múltiples videos; un video múltiples álbumes.
- Índice parcial único `(album_id) WHERE is_primary_link` = **a lo sumo un
  enlace principal por álbum** (protege la unicidad del campo core sin tocar
  el core).
- CHECK: un enlace principal no puede tener confianza `low`.
- Regla de gobierno: un video de tipo music_video/live_concert/documentary
  **nunca crea álbumes**; solo se vincula a álbumes existentes.

**video_tracks** — ocurrencias de tracks dentro de videos (N:N con datos de
ocurrencia). `video_id` FK · `track_id` FK · `start_seconds` ≥ 0 ·
`end_seconds` NULL o > start · `confidence` · `source_id` · `claim_id`.
UNIQUE(video_id, track_id, start_seconds).
- La MISMA canción puede aparecer en varios videos (el core
  `tracks.youtube_start_seconds` es solo el timestamp del video principal y
  **no** es la única fuente de timestamps).

**media_links** — URL + fuente + metadatos de medios (portadas, fotos,
scans) sin descarga masiva. `entity_kind` + 4 FKs reales (artist/person/
organization/album) con CHECK exactamente uno · `url` · `media_type` ·
`source_id` · `meta` JSONB. UNIQUE(COALESCE(destinos), url).

## 5. review_queue: qué columnas llena cada kind

| kind | Columnas FK usadas | payload (ejemplos) |
|---|---|---|
| possible_duplicate | artist_a/b_id · person_a/b_id · organization_a/b_id | detalle de similitud |
| field_conflict | conflict_id (+ claim_a/b_id) | — |
| ambiguous_alias | claim_a_id (propuesta de alias) | alias_candidates |
| album_match | claim_a_id + album_id | — |
| person_match | claim_a_id + person_id | — |
| organization_match | claim_a_id + organization_id | — |
| youtube_match | claim_a_id + video_id (+ album_id opcional) | sugerencia de album_kind |
| manual_review | claim_a_id (o ninguna) | nota libre |

Kinds añadidos por la migración `0004_review_kinds` (flujo de ingestión del
seed y de la IA):

| kind | Columnas FK usadas | payload (ejemplos) |
|---|---|---|
| missing_url | — | upload_order, artista/álbum crudos de la fila sin URL |
| seed_incomplete | — | upload_order de la fila `EMPTY` (97, 440) |
| media_type_no_album | video_id (+ album_id si se propone enlace) | tokens de `Type of Album` que impidieron crear álbum |
| genre_unknown | claim_a_id (+ album_id) | valor de género no listado en `ingest.genres` |
| new_source | — | URL, alcance y justificación de la fuente propuesta |
| low_confidence | claim_a_id | motivo por el que el claim no alcanza `medium` |
| ai_biography | claim_a_id (+ artist_a_id / person_a_id) | id del borrador en `ingest.ai_biographies` |
| ai_entity_resolution | claim_a_id (+ el par de entidades candidatas) | candidatos y puntuación devueltos por la IA |

## 6. Correspondencia con el contrato (DATA_MODEL §4)

| DATA_MODEL (especificación) | Realización |
|---|---|
| `ingest.sources` | `ingest.sources` (idéntico) |
| `ingest.raw_pages` | `ingest.raw_pages` (url + canonical_url; historia por re-descarga) |
| `ingest.seed_uploads` | `ingest.seed_uploads` (idéntico) |
| `ingest.youtube_videos` | **`media.youtube_videos`** (movido al schema media por la directiva ingest/media) |
| `ingest.claims` | `ingest.claims` (11 FKs reales; estados candidate/accepted/rejected/conflict/superseded) |
| `ingest.evidence` | `ingest.claim_evidence` |
| `ingest.entity_aliases` | 5 tablas con FK reales: `artist/person/organization/album/track_aliases` |
| `ingest.conflicts` | `ingest.conflicts` (idéntico + snapshots) |
| `ingest.review_queue` | `ingest.review_queue` (kinds actualizados por la directiva) |
| `ingest.genres` | `ingest.genres` (idéntico) |
| `ingest.ai_biographies` / `ai_runs` | **Diferido a F6** (fuera del alcance de esta capa de scraping) |
| `ingest.media_links` | `media.media_links` (FKs reales) |
| `ingest.import_runs` | `ingest.scrape_runs` (tabla única por tipo de run) |
| `ingest.audit_log` genérico | `ingest.merge_audit` + `merge_audit_claims` (auditoría del pipeline; el audit de CRUD humano queda para F7) |

## 7. Idempotencia e integridad (resumen)

- Mecanismo de migraciones: `ingest.schema_migrations` (harness) — aplicar dos
  veces = no-op; los `.up.sql` son además idempotentes a nivel DDL
  (`IF NOT EXISTS` / guards DO). Verificado en `tests/run_all.sh`.
- Dedupe natural: `sources.slug`, `raw_pages(source,sha256)`,
  `seed_uploads.upload_order`, `genres.name`, `claims` (índice compuesto),
  `claim_evidence(claim,hash)`, `conflicts(a,b,field)`, alias tables,
  `youtube_videos.video_id`, `video_tracks(video,track,start)`,
  `media_links(entity,url)`.
- Integridad referencial: 87 FKs reales (aux→aux, aux→core, aux→media),
  listadas por `run_all.sh` paso 12.
- Core intacto: diff `public` antes/después (y tras rollback) = vacío.
