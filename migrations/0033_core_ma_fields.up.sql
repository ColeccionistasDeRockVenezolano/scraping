-- ============================================================================
-- CRV · Migración 0033_core_ma_fields (UP)
-- Campos nuevos al core para la captura de Metal Archives (VE, 2026-10-01):
--   artists:  status · themes · years_active · logo_url
--   persons:  real_name · birth_city · death_cause · trivia · gender
--   albums:   release_date_text · catalog_id · media_format
--
-- POR QUÉ: la captura de MA trae datos que el core no sabía guardar y que
--   se perderían o acabarían en `notes` (sin estructura): el estatus de la
--   banda, sus temas líricos, los años activos como texto («1977-1981 (as
--   Power Age), 1981-present»), el logo (distinto de picture_url = foto), el
--   nombre real de una persona, ciudad de nacimiento, causa de fallecimiento,
--   trivia, género; y en discos: fecha literal, ID de catálogo y formato.
--
-- DECISIONES:
--   * CUARTA EXCEPCIÓN AL CORE (Brian, 2026-10-01, «debes modificar el core
--     de la base de datos para que metas las nuevas informaciones en nuevos
--     campos»), tras 0028, 0029 y 0032: se AÑADEN columnas a `public.artists`,
--     `public.persons` y `public.albums`. `crv_simple_v1.sql` queda verbatim;
--     el diff de `pg_dump --schema=public` (tests/run_all.sh,
--     test/contract/core-and-schema.test.ts) y la huella de `crv doctor`
--     (src/doctor/core-catalog.ts, APPROVED_CORE_ADDITIONS) aceptan solo estas
--     columnas.
--   * Todas NULLables: NULL = sin dato; nada se afirma por omisión.
--   * Vocabularios canónicos (en minúsculas) que el aplicador deriva de la
--     fuente, sin CHECK para no romper fusiones ni futuras fuentes:
--       artists.status  → active | split_up | on_hold | unknown | changed_name
--       persons.gender  → female | male | unknown
--   * `albums.release_date_text` guarda la fecha LITERAL de la fuente
--     («2006», «March 15th, 1993»); `release_year` sigue siendo el canónico
--     numérico (smallint) y no se toca.
--   * `albums.media_format` (CD, MC, LP, Digital…) no choca con
--     `album_formats.format`, que describe el archivo de archivo (calidad,
--     archive_status, file_path).
--   * `artists.logo_url` es el logo; `artists.picture_url` sigue siendo la
--     foto.
--   * Sin datos nuevos aquí: poblarlos es un run aparte (captura MA →
--     claims → merge), reversible con el diario.
--
-- REGLAS DE GOBIERNO: idempotente y reversible (0033_…down.sql).
-- ============================================================================

BEGIN;

SET LOCAL crv.journal = 'off';

ALTER TABLE public.artists ADD COLUMN IF NOT EXISTS status character varying(20);
ALTER TABLE public.artists ADD COLUMN IF NOT EXISTS themes text;
ALTER TABLE public.artists ADD COLUMN IF NOT EXISTS years_active text;
ALTER TABLE public.artists ADD COLUMN IF NOT EXISTS logo_url text;

ALTER TABLE public.persons ADD COLUMN IF NOT EXISTS real_name character varying(200);
ALTER TABLE public.persons ADD COLUMN IF NOT EXISTS birth_city character varying(120);
ALTER TABLE public.persons ADD COLUMN IF NOT EXISTS death_cause text;
ALTER TABLE public.persons ADD COLUMN IF NOT EXISTS trivia text;
ALTER TABLE public.persons ADD COLUMN IF NOT EXISTS gender character varying(10);

ALTER TABLE public.albums ADD COLUMN IF NOT EXISTS release_date_text character varying(40);
ALTER TABLE public.albums ADD COLUMN IF NOT EXISTS catalog_id character varying(80);
ALTER TABLE public.albums ADD COLUMN IF NOT EXISTS media_format character varying(50);

COMMIT;
