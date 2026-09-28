-- ============================================================================
-- CRV · Migración 0029_persons_venezuelan_tristate (DOWN)
-- Devuelve `persons.is_venezuelan` a `boolean NOT NULL DEFAULT false`, como en
-- crv_simple_v1.sql. «Sin dato» (NULL) vuelve a ser false: se pierde la
-- diferencia entre «extranjero afirmado» y «sin dato», no los true.
-- ============================================================================

BEGIN;

SET LOCAL crv.journal = 'off';

UPDATE public.persons SET is_venezuelan = false WHERE is_venezuelan IS NULL;

ALTER TABLE public.persons ALTER COLUMN is_venezuelan SET DEFAULT false;
ALTER TABLE public.persons ALTER COLUMN is_venezuelan SET NOT NULL;

COMMIT;
