-- ============================================================================
-- CRV · Migración 0016_person_duplicate_pair_uk (UP)
-- Un solo careo vivo por par no ordenado de personas (PHASES E11.5).
--
-- POR QUÉ: el detector de candidatos puede correr todos los días; sin esta
--   restricción, cada corrida abriría otra revisión del mismo par y la cola
--   se llenaría de propuestas idénticas. Con el índice parcial, proponer dos
--   veces el mismo par mientras la revisión sigue viva es un no-op
--   (`ON CONFLICT DO NOTHING`).
--
-- ALCANCE: solo `person_duplicate` en estado vivo (open/in_progress). Un par
--   descartado («son distintas», `dismissed`) no bloquea nada aquí: que no
--   vuelva a proponerse lo decide el detector al leer las revisiones cerradas.
--
-- NOTA: el valor `person_duplicate` del enum lo añade 0015, que va en su
--   propio archivo para que el COMMIT ocurra antes de usar el valor (regla de
--   PostgreSQL para ALTER TYPE ... ADD VALUE).
--
-- REGLAS DE GOBIERNO: el schema `public` (core) NO se toca. Idempotente y
--   reversible.
-- ============================================================================

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS review_queue_person_duplicate_live_uk
  ON ingest.review_queue (LEAST(person_a_id, person_b_id), GREATEST(person_a_id, person_b_id))
  WHERE kind = 'person_duplicate' AND status IN ('open', 'in_progress');

COMMIT;
