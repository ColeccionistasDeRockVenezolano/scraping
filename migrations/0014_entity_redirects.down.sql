-- ============================================================================
-- CRV · Migración 0014_entity_redirects (DOWN) — reversible y no destructiva
-- Elimina únicamente la tabla de redirecciones (dato derivado: si se
-- reconstruye, mergeInto vuelve a llenarla con las fusiones nuevas; las
-- anteriores se pierden, pero eso es preferible a dejar un objeto huérfano
-- que el up siguiente no reconocería).
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

DROP TABLE IF EXISTS ingest.entity_redirects;

COMMIT;
