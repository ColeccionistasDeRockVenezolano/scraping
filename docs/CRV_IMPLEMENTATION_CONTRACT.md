# CRV — Contrato Técnico de Implementación

> Documento de gobierno del proyecto **Coleccionistas de Rock Venezolano**.
> Toda fase posterior se ejecuta contra este contrato. En caso de conflicto
> entre documentos, este contrato manda; en caso de conflicto con el usuario,
> manda el usuario.

---

## 1. Auditoría del workspace (estado cerrado)

Archivos presentes en el workspace al momento de la auditoría (sin `.git`):

| Archivo | Rol | SHA-256 |
|---|---|---|
| `crv_simple_v1.sql` | **CORE CANÓNICO** (PostgreSQL 15+) | `b7e7d35ac517d44f3be04ac1b8b70892e16f7e4cf1aa9d3f7260fd929fdf3a3a` |
| `crv_simple_conceptual.svg` | Diagrama conceptual del core | `507ec62d8e6d4785b02d9a9157d7aa36b1a8143f97451ca68b401ebf8fad34bb` |
| `crv_simple_relational.svg` | Diagrama relacional del core | `593cb5caf03553b2f2e0a1ee3ee6bd23568c31d3e1176e64cb64cf85f429b21f` |
| `README.md` | Notas del modelo v1 | `03b3a835a63121e1317164a15d54c47575b198b5c3b2f7cbb6f628c714259bbc` |
| `crv_schema_v1.dbml` | Modelo amplio **anterior** (works/recordings/events/videos…) | `4a0b9a7a612b4b9c3d674c7c2b1e4c2efcd8564a1162355faf2f48a251f7f6a9` |
| `YT Master Spreadsheet.xlsx` | Seed del catálogo audiovisual (606 filas) | `3a3455a45f4187492c20beebc2bdd8788986e8ca1464933c145cf09ed54cafbd` |
| `Links for Data Scrapping.xlsx` | Registro de 11 fuentes autorizadas | `5bd54bdf2bda4f425fa53d0a058d7e108e4bf8c59e6e61c3a8a661bde0318e04` |
| `docs/` (este contrato y anexos) | Normativa técnica | — |

**Discrepancia registrada:** el `README.md` menciona `crv_simple_v1.dbml`, pero
el archivo real es `crv_schema_v1.dbml` y su contenido corresponde al modelo
amplio anterior, **no** al esquema simplificado. Resolución normativa:
`crv_simple_v1.sql` es el único núcleo canónico; el `.dbml` queda como
referencia histórica (no gobernante) y `README.md` no se modifica en esta
fase sin autorización (está fuera del alcance de `docs/`).

**Anomalías del seed YT (catálogo cerrado, no se corrigen en archivo).**
Re-verificadas programáticamente el 2026-09-07 sobre el XLSX real:
- 606 filas de datos; Upload Order 1..607 con el **9 ausente**, sin
  duplicados de orden.
- 2 filas con artista y álbum literales `EMPTY` (órdenes 97, 440; sin
  año/tipo/URL; Status Unlisted).
- 86 filas sin URL — **todas** con Status `Unlisted`. Hay además 1 fila
  `Unlisted` **con** URL (total 87 `Unlisted`).
- 19 filas sin año = 17 `Music Video` + las 2 `EMPTY`. Rango de años real:
  **1964–2023**.
- 520 URLs → 496 `watch?v=`, 24 `youtu.be/`; **520 video IDs, todos
  distintos** (ninguno repetido entre filas).
- 93 URLs con `&t=` y **60 con `&pp=`** (ambos parámetros de UI: se ignoran
  al derivar el ID y la URL canónica).
- 8 pares (artist, album) repetidos, de los cuales **7 son lanzamientos
  reales duplicados** y 1 es el par `EMPTY`/`EMPTY`.
- Colisiones de identidad de artista: `'Soleà '` con espacio final (orden
  593) y **`'Pacifica'` vs `'Pacífica'`** (difieren solo en la tilde). Con
  `artists.name` UNIQUE en el core, una importación ingenua crearía dos
  entidades: ambos casos son trabajo obligatorio de entity resolution.
- Conflicto **interno** del propio seed: el par duplicado
  `Metrozubdivision / 'CCS'` afirma **2007** (orden 24) y **2006** (orden
  584) para el mismo lanzamiento.
- Las celdas numéricas del XLSX llegan como flotantes (`'350.0'`,
  `'2009.0'`): el importador debe convertirlas a entero sin perder el valor
  crudo.

---

## 2. Núcleo canónico (reglas de inmutabilidad)

1. `crv_simple_v1.sql` define el esquema canónico: **7 enums, 10 tablas**
   (`artists`, `persons`, `artist_members`, `organizations`,
   `person_organizations`, `albums`, `tracks`, `album_credits`,
   `track_credits`, `album_formats`), **3 vistas y 23 índices**. Conteo
   verificado sobre el archivo el 2026-09-07. Inventario completo y
   semántica por tabla en DATA_MODEL.md §2.
2. **Prohibido** sobre las tablas core: eliminar, renombrar, rediseñar,
   añadir/eliminar columnas, cambiar constraints, o añadir índices únicos.
   La unicidad no expresada en el core se garantiza en la capa de merge
   (advisory locks), no con DDL (DATA_MODEL.md §6).
3. El core se aplica **verbatim** como migración baseline. La suite de
   contract tests compara el catálogo real de `public` contra el hash del
   archivo en cada ejecución.
4. Todo lo nuevo vive en los esquemas auxiliares `ingest` y `media`
   (DATA_MODEL.md §4). Ningún objeto nuevo se crea en `public`.

---

## 3. Decisiones cerradas (no abiertas a reconsideración)

Transcritas de la directiva del propietario; cada una con su implementación
en la matriz (§10):

1. Tablas core: no eliminar, renombrar ni rediseñar.
2. Se permiten esquemas/tablas auxiliares para ingestión, evidencia, alias,
   conflictos, auditoría y medios si son imprescindibles, manteniendo el core
   compatible.
3. Merge híbrido: alta confianza → automático; media → solo información
   nueva no conflictiva; conflicto/posible duplicado → revisión; baja → no
   modificar datos canónicos.
4. Los conflictos entre fuentes conservan ambas afirmaciones y evidencias.
5. Biografías generadas con IA separadas de los hechos estructurados.
6. Los géneros aceptados son configurables.
7. Personas extranjeras pueden existir si participaron en proyectos
   venezolanos, sin biografía exhaustiva.
8. Imágenes: almacenar URL, fuente y metadatos; no descargar masivamente.
9. Scraping masivo por fuente + enriquecimiento dirigido por artista.
10. Nuevas fuentes requieren aprobación manual.
11. Fuentes almacenadas internamente; no es requisito mostrarlas públicamente.
12. IA solo para ambigüedad, extracción narrativa compleja, entity resolution
    o conflictos. Nunca como extractor universal.
13. Álbumes, EP, singles, canciones, músicos, productores, colaboradores,
    sellos, estudios y créditos son datos críticos.
14. Un crédito en un álbum NO implica membresía permanente en una banda.
15. El sistema es idempotente: re-importar no puede duplicar entidades.
16. YouTube es fuente de primera clase.
17. El YT Master Spreadsheet funciona como seed inicial del catálogo
    audiovisual.
18. No depender del scraping visual de la búsqueda de YouTube; diseñar sobre
    YouTube Data API y los IDs existentes.
19. Music Video / Live Concert / Documentary no crean álbumes
    automáticamente.
20. Browser → Backend/API → PostgreSQL; el navegador nunca conecta directo a
    PostgreSQL.
21. Arquitectura simple y modular: sin microservicios, Kafka, Kubernetes ni
    Elasticsearch.

---

## 4. Política de merge híbrido

| Confianza | Comportamiento |
|---|---|
| `high` | Aplica automáticamente. Campo vacío → se escribe; campo distinto → se sobrescribe con auditoría (el claim anterior queda `superseded`). |
| `medium` | Solo **información nueva no conflictiva**: campos vacíos se rellenan; campos con valor distinto → **conflicto** (no se toca el core). |
| conflicto / posible duplicado | Se conservan ambas afirmaciones (`ingest.conflicts` + evidencias) y se abre `review_queue`. El core queda suspendido en ese campo hasta resolución. |
| `low` | **Nunca** modifica datos canónicos. El claim queda `candidate` y va a revisión. |

Reglas adicionales: `created_by=human` equivale a high (el operador es
autoridad); `created_by=ai` nunca supera low sin aprobación humana.
Dedupe previo por el índice real `claims_dedupe_uk` sobre
`ingest.claims` (source + página/seed + `entity_kind` + destino + `field` +
`raw_hash`).

---

## 5. Política de conflictos

- Un conflicto = dos claims aceptables, valores distintos, mismo campo de la
  misma entidad resuelta.
- **Ambas afirmaciones y ambas evidencias se conservan siempre** en
  `ingest.conflicts`; el core no se modifica mientras el conflicto esté
  `open`.
- Resoluciones posibles: `resolved_a`, `resolved_b`, `both_kept` (dato
  múltiple consignado en notas/alias), `dismissed`. Toda resolución es
  humana y auditada (`ingest.merge_audit`).

---

## 6. Política de IA (DeepSeek gateway)

- Único punto de contacto: módulo `deepseek gateway` (ARCHITECTURE.md §4.11).
- Usos permitidos: ambigüedad en entity resolution, extracción narrativa
  compleja, triage de conflictos (sugerencia), normalización de créditos
  muy desordenados. **Nunca** extracción universal de datos estructurados.
- Productos de IA: claims `created_by='ai', confidence='low'` → revisión;
  biografías → `ingest.ai_biographies` (nunca el campo biography del core
  sin aprobación). Todo call registrado en `ingest.ai_runs` con prompt_hash
  (caché/idempotencia). El sistema opera sin IA.

---

## 7. Política de YouTube

- Fuente de primera clase vía **YouTube Data API** únicamente.
- IDs: se usan los existentes (520 extraídos del seed). `search.list` solo
  en enriquecimiento dirigido por artista, acotado por cuota.
- Prohibido el scraping visual de youtube.com.
- Tipos Music Video / Live Concert / Documentary → **jamás** crean álbumes;
  solo se registran en `media.youtube_videos` y pueden vincularse a álbumes
  existentes mediante la tabla de enlace `media.video_albums`
  (`album_kind` conserva el tipo: `music_video`, `live_concert`,
  `documentary`), con las propuestas pasando por revisión.
- El seed YT se preserva verbatim en `ingest.seed_uploads` (Upload Order
  intacto, sin renumerar, sin corregir valores crudos).

---

## 8. Política de fuentes

- Conjunto cerrado: 11 fuentes del XLSX + YouTube Data API + los dos seeds.
  Altas solo con aprobación manual (SOURCES.md §5).
- Dos modos: masivo por fuente y dirigido por artista.
- Almacenamiento interno obligatorio (`ingest.sources`); exposición pública
  opcional y apagada por defecto.
- Ningún dato extraído se publica sin claim + evidencia trazable al HTML
  crudo conservado.

---

## 9. Idempotencia y procedencia (invariantes operativos)

- Re-ejecutar cualquier importación N veces produce los mismos conteos de
  entidades core y claims (los `ingest.scrape_runs` sí crecen). Verificado en la
  suite con doble ejecución y en el acceptance `caramelos-las-paticas.md`.
- Claves naturales y advisory locks por entidad en DATA_MODEL.md §6.
- Cadena de procedencia obligatoria: fuente → `raw_pages`/`seed_uploads` →
  `claims` → core, con `ingest.merge_audit` en cada write del core.
- El merge engine es el **único** escritor de tablas core (incluido el CRUD
  humano, que emite claims high).

---

## 10. Matriz requisito → solución

Estado: **R** = realizado en `migrations/0001–0004` (verificado contra
PostgreSQL 16); **E** = especificado, pendiente de la fase indicada.

| # | Requisito / decisión | Módulo(s) | Tabla(s) / mecanismo realizado | Est. | Documento |
|---|---|---|---|---|---|
| 1 | Core intacto | migración baseline + contract tests | `public` verbatim; diff de `pg_dump` vacío | **R** | DATA_MODEL §2, PHASES F0 |
| 2 | Auxiliares permitidos | — | esquemas `ingest` + `media` (nada en `public`) | **R** | DATA_MODEL §4 |
| 3 | Merge híbrido | merge engine | `ingest.claims.confidence` (`high/medium/low`) + advisory locks | E (F5) | CONTRACT §4, ARCH §4.8 |
| 4 | Conflictos conservan ambas afirmaciones | conflict engine | `ingest.conflicts` (claim_a/claim_b) + `ingest.claim_evidence` | **R** (tablas) / E (motor, F5) | CONTRACT §5, ARCH §4.9 |
| 5 | Bios IA separadas | deepseek gateway | `ingest.ai_biographies` ≠ `artists.biography` | E (F6) | DATA_MODEL §4.11 |
| 6 | Géneros configurables | normalization | `ingest.genres` (`active`) + revisión si no listado | **R** (tabla) / E (validación, F5) | DATA_MODEL §4.10 |
| 7 | Extranjeros sin bio exhaustiva | ER/merge | `persons.nationality`, `is_venezuelan=false` por defecto; `biography` nullable | **R** (core) | DATA_MODEL §2 |
| 8 | Imágenes: URL+fuente+metadatos | media handling | `media.media_links` (url+source_id+meta); prohibida descarga masiva | **R** | DATA_MODEL §4.12 |
| 9 | Masivo por fuente + dirigido por artista | scraper adapters, CLI | `ingest.scrape_runs.kind` (`scrape_source` / `enrich_artist`) | **R** (tabla) / E (F4) | SOURCES §1, ARCH §4.4 |
| 10 | Fuentes nuevas con aprobación | review queue | `ingest.sources.enabled=false` + ítem de revisión | **R** (tabla) / E (flujo, F1) | SOURCES §6 |
| 11 | Fuentes internas, display opcional | API | `ingest.sources.public_display` (default `false`) | **R** | SOURCES §1 |
| 12 | IA limitada | deepseek gateway | `ingest.ai_runs`; claims `created_by='ai'` nunca > `low` | E (F6) | CONTRACT §6, ARCH §4.11 |
| 13 | Créditos críticos | core + adapters | `album_credits`/`track_credits`/`organizations`/`album_formats` | **R** (core) | DATA_MODEL §2 |
| 14 | Crédito ≠ membresía | merge engine (regla dura) | prohibido derivar `artist_members` de un crédito | E (F5, test obligatorio) | CONTRACT §4, ARCH §4.8 |
| 15 | Idempotencia | merge engine + runs | `claims_dedupe_uk`, `seed_uploads.upload_order` UNIQUE + `row_hash`, advisory locks | **R** (constraints) / E (motor, F5) | DATA_MODEL §6, ARCH §4.8 |
| 16 | YouTube primera clase | youtube ingestion | `media.youtube_videos` (+`metadata` JSONB con el snapshot de la API) | **R** | SOURCES §2, ARCH §4.12 |
| 17 | Seed YT inicial | seed import (F2) | `ingest.seed_uploads` verbatim + `upload_order` | **R** (tabla) / E (importador, F2) | DATA_MODEL §4.3/§5 |
| 18 | Sin scraping visual YT | youtube ingestion | solo Data API; `search.list` acotado | E (F3) | SOURCES §2 |
| 19 | Videos no crean álbumes | youtube ingestion (gating) | enlace **solo** vía `media.video_albums` (N:N, `album_kind`); no existe ninguna ruta video→INSERT álbum | **R** (estructura) / E (gating, F2-F3) | DATA_MODEL §5, ARCH §4.12 |
| 20 | Browser→Backend→PG | API Fastify | PG solo en localhost; API en `127.0.0.1` | E (F7) | ARCH §2 |
| 21 | Simple y modular | arquitectura monoproceso | sin infra extra; la cola es una tabla PG | **R** (decisión) | ARCH §9 |

---

## 11. Realización: reconciliación de nombres y deuda abierta

Las migraciones `0001–0003` ya realizan buena parte del esquema auxiliar. Sus
nombres reales **mandan** sobre los nombres provisionales usados en las
primeras versiones de estos documentos. Tabla de equivalencia normativa:

| Nombre en la especificación inicial | Nombre real (vinculante) |
|---|---|
| `ingest.youtube_videos` | `media.youtube_videos` |
| `ingest.media_links` | `media.media_links` |
| `ingest.evidence` | `ingest.claim_evidence` |
| `ingest.entity_aliases` (una tabla) | 5 tablas con FK real: `ingest.artist_aliases`, `person_aliases`, `organization_aliases`, `album_aliases`, `track_aliases` |
| `ingest.import_runs` | `ingest.scrape_runs` (+ `ingest.scrape_errors`) |
| `ingest.audit_log` | `ingest.merge_audit` (+ `ingest.merge_audit_claims`) |
| `youtube_videos.linked_album_id` (1:N) | `media.video_albums` (N:N, con `album_kind`, `is_primary_link`, `confidence`) |
| `youtube_videos.upload_order` | vía `seed_upload_id` → `ingest.seed_uploads.upload_order` |
| `claims.status = 'pending'` | `ingest.claim_status = 'candidate'` (+ `conflict`) |

La realización es **más estricta** que la especificación en tres puntos, y se
adopta como norma: FKs reales en lugar de `core_id` genérico; enlace video↔
álbum N:N con un único enlace primario por álbum
(`video_albums_one_primary_per_album_uk`, índice parcial); y
`video_albums_primary_confidence_chk`, que impide que un enlace de confianza
`low` sea el primario.

### 11.1 Deuda resuelta: migración `0004_review_kinds`

`ingest.review_kind` se realizó con los valores
`possible_duplicate, field_conflict, ambiguous_alias, album_match,
person_match, organization_match, youtube_match, manual_review`. **No
incluye** los tipos de revisión que exigen PHASES F2 y el escenario de
aceptación: `missing_url`, `seed_incomplete`, `media_type_no_album`,
`genre_unknown`, `new_source`, `low_confidence`, `ai_biography` y
`ai_entity_resolution`.

**Resuelto:** `migrations/0004_review_kinds.up.sql` añade esos ocho valores
con `ALTER TYPE ingest.review_kind ADD VALUE IF NOT EXISTS ...` (no reabre
ninguna decisión cerrada; el core no participa). La migración va en un archivo
propio y sin `INSERT`s porque un valor añadido a un enum no puede usarse hasta
el COMMIT de la transacción que lo añade.

El down correspondiente recrea el enum con los 8 valores de 0003 (PostgreSQL
no permite eliminar valores) y **aborta con un error explícito** si alguna
fila está usando un kind de 0004, en lugar de destruir datos.

Verificado el 2026-09-07 contra `postgres:16-alpine` por
`tests/test_0004_review_kinds.sh` (23 comprobaciones): enum con 16 valores en
orden; los 8 nuevos insertables en `ingest.review_queue`; `up` re-ejecutable
sin efecto; `down` bloqueado con filas presentes (y datos intactos) y correcto
sin ellas; `down` idempotente; diff de `public` vacío. Además
`tests/run_all.sh` en verde con el rollback completo `0004 → 0001`.

La prueba se validó por mutación: al quitar un `ADD VALUE` del `up` y al
desactivar la guarda del `down`, la suite falla en ambos casos.

### 11.2 Verificación ejecutada (2026-09-07)

- SHA-256 de los 7 archivos de entrada recalculados: **coinciden** con los
  registrados en §1 → el core y los dos XLSX no han cambiado desde la
  auditoría inicial.
- `tests/run_all.sh` re-ejecutado contra `postgres:16-alpine` desechable:
  salida **0**. `pg_dump --schema=public --schema-only` antes y después de
  aplicar `0001–0004` produce un **diff vacío**; el diff tras el rollback
  completo también es **vacío**.
- Análisis estático de `migrations/*.sql`: **todos** los `CREATE` apuntan a
  `ingest.*` o `media.*`; los únicos `ALTER TABLE` son sobre `media.*`; no
  existe ninguna sentencia que cree, altere o elimine un objeto de `public`.
- Entorno: la máquina tiene **Node v20.20.2**; ARCHITECTURE.md exige
  **Node 22 LTS**. Debe resolverse en F0 antes de escribir código.
- **Cerrado (2026-09-07):** el hash del core solo vivía en la documentación;
  ningún script lo comprobaba, así que una edición del propio
  `crv_simple_v1.sql` no habría sido detectada (el diff de `pg_dump` solo
  prueba que las migraciones no tocan `public`, no que el archivo de origen
  sea el registrado). Resuelto con `crv_simple_v1.sql.sha256` (fuente única
  del hash) y `verify_core_hash()` en `tests/lib_pg.sh`, ejecutado como
  paso 0 de `tests/run_all.sh` y `tests/test_0004_review_kinds.sh`.
  Validado por mutación: alterar el hash registrado produce `EXIT=1` con
  mensaje explícito antes de tocar la base de datos.

---

## 12. Definiciones

- **Claim:** afirmación atribuible (fuente + valor crudo + valor normalizado
  + confianza + creador) sobre un campo de una entidad canónica.
- **Evidencia:** localización concreta del claim en el material crudo
  (URL + fragmento + selector + hash).
- **Confianza:** high/medium/low, asignada por fuente inicialmente y
  ajustable campo a campo por corroboración (SOURCES.md §1).
- **Entidad canónica:** fila en una tabla core, resultado de claims
  aceptados.
- **Review:** trabajo humano pendiente; único mecanismo para aceptar lo que
  el merge no pudo decidir.

---

## 13. Control de cambios y condiciones de parada

- Cualquier propuesta de cambio al core, a las decisiones §3 o a la lista de
  fuentes requiere aprobación explícita del propietario y enmienda de este
  contrato.
- **Parada obligatoria** (sin seguir implementando): si falta un archivo
  fundamental sin variante equivalente en el workspace, o si aparece una
  contradicción que haga imposible preservar el core cumpliendo un
  requisito obligatorio. En ese caso se reporta la contradicción con
  evidencia (archivo:línea) y se espera decisión.
- Los anexos normativos de este contrato son: `ARCHITECTURE.md`,
  `DATA_MODEL.md`, `SOURCES.md`, `PHASES.md` y `docs/acceptance/`.
  El contrato y sus anexos viven en `docs/`.
