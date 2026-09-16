# CRV · Migraciones PostgreSQL

Migraciones auxiliares del proyecto Coleccionistas de Rock Venezolano.
**El core canónico (`crv_simple_v1.sql`, schema `public`) no se modifica nunca**
desde aquí: estas migraciones solo crean objetos en los schemas `ingest` y
`media`, y se aplican después de instalar el core.

## Estructura

| Archivo | Contenido |
|---|---|
| `0001_ingest_core.up/down.sql` | Schema `ingest`: enums base, `sources`, `raw_pages`, `scrape_runs`, `scrape_errors`, `seed_uploads`, `genres` |
| `0002_media.up/down.sql` | Schema `media`: `youtube_videos`, `video_artists`, `video_albums`, `video_tracks`, `media_links` |
| `0003_ingest_claims_identity.up/down.sql` | Claims/evidencia, aliases ×5, `conflicts`, `review_queue`, `merge_audit` (+ `claim_id` en tablas de media) |
| `0004_review_kinds.up/down.sql` | Extiende `ingest.review_kind` con los 8 kinds de ingestión/IA que exige F2 (`missing_url`, `seed_incomplete`, `media_type_no_album`, `genre_unknown`, `new_source`, `low_confidence`, `ai_biography`, `ai_entity_resolution`) |
| `0005_raw_pages_run.up/down.sql` | Añade `raw_pages.run_id` + FK/índice para saber qué run descargó cada snapshot |
| `0006_youtube_pipeline.up/down.sql` | Estado y auditoría auxiliar del import/sync de YouTube |
| `0007_entity_resolution_ai.up/down.sql` | Identidad original+claves derivadas, decisiones ER explicables, runs DeepSeek y biografías trazables |
| `0008_media_link_claims.up/down.sql` · `0009_media_link_constraints.up/down.sql` | Claims `media_link` y restricciones de `media.media_links` |
| `0010_review_decisions.up/down.sql` | Decisiones humanas provisionales de la Mesa de Cotejo (`review_decisions`) |
| `0011_album_classifications.up/down.sql` | Todas las clasificaciones que la hoja maestra da a un disco |
| `0012_ambiguity_resolutions.up/down.sql` | Decisiones explicables del resolutor de ambigüedades (E10), con evidencia obligatoria en el DDL |
| `0013_fk_indexes.up/down.sql` | Un índice (parcial si la columna admite nulos) por cada FK de `ingest`/`media` que no tenía uno, para que retirar o fusionar filas del core no recorra tablas enteras (E11) |
| `0014_entity_redirects.up/down.sql` | Redirecciones de ids fusionados (`ingest.entity_redirects`): `/persons/<id>` de una ficha fusionada responde 404 con `movedTo` a la que quedó (E11.2) |
| `0015_review_kind_person_duplicate.up/down.sql` | `person_duplicate` en `ingest.review_kind`: el kind con el que el detector de candidatos propone un par (E11.5). El down es irreversible (no se pueden quitar valores de un enum) y lo documenta |
| `0016_person_duplicate_pair_uk.up/down.sql` | Índice único parcial: un solo careo vivo por par de personas (`person_duplicate` en open/in_progress), para que repetir el detector no duplique propuestas (E11.5) |
| `0017_curation_findings.up/down.sql` | Detector de conflictos de Curaduría: `ingest.curation_scans` (cada análisis del catálogo) y `ingest.curation_findings` (hallazgos por categoría con huella estable; abiertos, resueltos solos al corregirse o ignorados por una persona) |

Documentación ER completa: `../docs/db/ER_INGEST_MEDIA.md`.

## Aplicación

1. Instalar el core en una base PostgreSQL 15+ (una sola vez):
   `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f ../crv_simple_v1.sql`
   (`npm run db:bootstrap` lo hace solo si la base aún no tiene el core).
2. Aplicar migraciones con `npm run db:migrate` (runner TS,
   `src/db/migrate.ts`) o con el harness de `../tests/migrate.sh`. Ambos
   rastrean versiones en `ingest.schema_migrations`. Antes de migrar la base
   real, sacar un respaldo: `npm run db:backup`
   (`../docs/DATABASE_BACKUP_RESTORE.md`).

## Pruebas

| Script | Qué cubre |
|---|---|
| `../tests/run_all.sh` | Suite completa: core + todas las migraciones (2 pasadas), idempotencia DDL, fixtures, tests negativos de constraints, rollback completo y diff vacío de `public` |
| `../tests/test_0004_review_kinds.sh` | Prueba específica de 0004: los 16 valores del enum, los 8 kinds nuevos usables, `up` idempotente, `down` que **aborta** si hay filas usándolos, `down` correcto sin ellas y reversibilidad completa |
| `../tests/lib_pg.sh` | Utilidades compartidas (`pg_start`, `wait_for_pg`, `pg_dump_filter`). No se ejecuta: se hace `source` |

Ambas suites levantan un contenedor `postgres:16-alpine` desechable y lo
eliminan al salir. `PG_WAIT_TIMEOUT` ajusta la espera de arranque (120 s por
defecto) y `PG_IMAGE` la imagen.

Cada archivo `.up.sql` es una transacción atómica (`BEGIN…COMMIT`), usa
`IF NOT EXISTS`/guards `DO $$` y es **idempotente a nivel DDL**: re-ejecutar
el mismo archivo sobre una base ya migrada no destruye datos ni recrea el
core. El mecanismo normal (tabla `schema_migrations`) evita además
re-aplicar versiones ya registradas.

## Rollback

Aplicar los `.down.sql` en orden inverso (0013 → 0012 → … → 0002 → 0001;
`npm run db:migrate -- down` los recorre todos y existe para desarrollo y
pruebas, no para operar la base real, donde se restaura un respaldo). Cada
down elimina únicamente los objetos de su schema auxiliar; los FKs protegen
contra borrados peligrosos (p. ej. no se puede dropear `ingest.sources`
mientras `raw_pages`/`claims` la referencien sin `CASCADE` explícito en el
orden correcto). El schema `public` no participa en ningún down.

**Caso especial 0004.** PostgreSQL no permite eliminar valores de un enum, así
que su down **recrea** `ingest.review_kind` con los 8 valores de 0003 y
reescribe las columnas que lo usan. Para no destruir datos en silencio, aborta
con un error explícito (indicando kind y número de filas) si alguna revisión
está usando uno de los 8 valores que se van a retirar: primero hay que
resolver o reclasificar esas revisiones. Si el enum no existe o los valores de
0004 no están presentes, el down no hace nada.

Nota de PostgreSQL para `0004.up`: desde PG 12 `ALTER TYPE ... ADD VALUE` puede
ir dentro de una transacción, pero el valor añadido **no puede usarse hasta el
COMMIT**. Por eso 0004 va en un archivo propio y no contiene ningún `INSERT`
que utilice los valores nuevos.
