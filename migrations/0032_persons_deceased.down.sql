-- ============================================================================
-- CRV · Migración 0032_persons_deceased (DOWN)
-- Quita `public.persons.is_deceased`. Se pierde la marca de fallecido (las
-- fechas de `death_date` no se tocan).
-- ============================================================================

BEGIN;

SET LOCAL crv.journal = 'off';

ALTER TABLE public.persons DROP COLUMN IF EXISTS is_deceased;

COMMIT;
