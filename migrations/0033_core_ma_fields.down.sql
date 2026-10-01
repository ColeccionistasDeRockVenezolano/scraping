-- ============================================================================
-- CRV · Migración 0033_core_ma_fields (DOWN)
-- Quita los 12 campos añadidos al core (artists ×4, persons ×5, albums ×3).
-- Se PIERDE lo que se haya poblado en esas columnas; el resto del core no se
-- toca.
-- ============================================================================

BEGIN;

SET LOCAL crv.journal = 'off';

ALTER TABLE public.artists DROP COLUMN IF EXISTS status;
ALTER TABLE public.artists DROP COLUMN IF EXISTS themes;
ALTER TABLE public.artists DROP COLUMN IF EXISTS years_active;
ALTER TABLE public.artists DROP COLUMN IF EXISTS logo_url;

ALTER TABLE public.persons DROP COLUMN IF EXISTS real_name;
ALTER TABLE public.persons DROP COLUMN IF EXISTS birth_city;
ALTER TABLE public.persons DROP COLUMN IF EXISTS death_cause;
ALTER TABLE public.persons DROP COLUMN IF EXISTS trivia;
ALTER TABLE public.persons DROP COLUMN IF EXISTS gender;

ALTER TABLE public.albums DROP COLUMN IF EXISTS release_date_text;
ALTER TABLE public.albums DROP COLUMN IF EXISTS catalog_id;
ALTER TABLE public.albums DROP COLUMN IF EXISTS media_format;

COMMIT;
