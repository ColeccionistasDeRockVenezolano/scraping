-- ============================================================================
-- CRV · Migración 0032_persons_deceased (UP)
-- `public.persons.is_deceased`: NULL = sin dato, true = fallecido/a.
--
-- POR QUÉ: `death_date` está vacío en todas las personas (las fuentes no dan
--   fecha) y las que las fuentes marcan con una cruz («Tirone González
--   "Canserbero" (†)») la llevaban pegada al nombre. Hace falta un dato propio
--   para mostrar la marca de fallecido sin ensuciar el nombre.
--
-- DECISIONES:
--   * EXCEPCIÓN AL CORE (Brian, 2026-09-30, «columna persons.is_deceased»), la
--     tercera tras 0028 y 0029: se AÑADE una columna a `public.persons`.
--     `crv_simple_v1.sql` queda verbatim; el diff de `pg_dump --schema=public`
--     (tests/run_all.sh, test/contract/core-and-schema.test.ts) y la huella de
--     `crv doctor` (src/doctor/core-catalog.ts) aceptan solo esta columna.
--   * Tres estados como is_venezuelan: NULL no es «vivo», es «sin dato»; así la
--     fusión rellena desde el duplicado y nada se afirma por omisión.
--   * Se considera fallecida a una persona con is_deceased = true O con
--     death_date; no hay CHECK entre ambos para no romper fusiones.
--   * Sin datos nuevos aquí: marcar a quien corresponda es un run (`crv review
--     persons`, op `mark_deceased`) y se puede deshacer.
--
-- REGLAS DE GOBIERNO: idempotente y reversible (0032_…down.sql).
-- ============================================================================

BEGIN;

SET LOCAL crv.journal = 'off';

ALTER TABLE public.persons ADD COLUMN IF NOT EXISTS is_deceased boolean;

COMMIT;
