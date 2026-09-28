-- ============================================================================
-- CRV · Migración 0029_persons_venezuelan_tristate (UP)
-- `persons.is_venezuelan` pasa a tener tres estados: NULL = sin dato,
-- true = venezolano, false = extranjero afirmado.
--
-- POR QUÉ: con `NOT NULL DEFAULT false` el campo no distinguía «no es
--   venezolano» de «nadie lo dijo»; la fusión y la reversión trataban false
--   como vacío y ninguna fuente lo alimentaba (las 10.532 personas estaban en
--   false). Con NULL como vacío, `crv persons derive-venezuelan` puede llenarlo
--   y una persona puede afirmar que alguien es extranjero.
--
-- DECISIONES:
--   * EXCEPCIÓN APROBADA AL CORE (2026-09-22, el propietario), la segunda tras
--     los disparadores de 0028: se altera una columna de `public.persons`.
--     `crv_simple_v1.sql` queda verbatim; el diff de `pg_dump --schema=public`
--     (tests/run_all.sh y test/contract/core-and-schema.test.ts) y la huella
--     de `crv doctor` (src/doctor/core-catalog.ts) aceptan solo esta forma.
--   * Los false existentes pasan a NULL salvo que un claim los afirme: el
--     DEFAULT era el único origen de esos false.
--   * El diario se apaga para este paso: es mantenimiento del esquema, no un
--     run, y el down lo revierte entero.
--
-- REGLAS DE GOBIERNO: idempotente y reversible (0029_…down.sql).
-- ============================================================================

BEGIN;

SET LOCAL crv.journal = 'off';

ALTER TABLE public.persons ALTER COLUMN is_venezuelan DROP DEFAULT;
ALTER TABLE public.persons ALTER COLUMN is_venezuelan DROP NOT NULL;

UPDATE public.persons p SET is_venezuelan = NULL
 WHERE p.is_venezuelan = false
   AND NOT EXISTS (
     SELECT 1 FROM ingest.claims c
      WHERE c.person_id = p.id AND c.field = 'is_venezuelan' AND c.status IN ('accepted', 'candidate', 'conflict'));

COMMIT;
