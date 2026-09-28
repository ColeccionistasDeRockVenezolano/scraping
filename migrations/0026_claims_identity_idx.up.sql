-- ============================================================================
-- CRV · Migración 0026_claims_identity_idx (UP)
-- La aprobación y la herencia por grafo de claims buscan por
-- (entity_kind, identity_key) varias veces por claim; sin índice, cada
-- búsqueda recorría todos los claims del mismo tipo y estado (~35-50 ms).
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca.
-- ============================================================================

BEGIN;

CREATE INDEX IF NOT EXISTS claims_identity_idx ON ingest.claims (entity_kind, identity_key);

COMMIT;
