-- ============================================================================
-- CRV · Migración 0010_review_decisions (UP)
-- Guarda la decisión HUMANA provisional sobre un ítem de la cola, tomada en
-- la Mesa de Cotejo, antes de que se aplique al catálogo.
--
-- POR QUÉ NO BASTA ingest.review_queue:
--   Resolver una revisión (`status='approved'`) es el acto final: dispara el
--   merge. Lo que registra esta tabla es anterior y reversible — "Brian dijo
--   que son el mismo disco" — de modo que el equipo pueda decidir en una
--   sesión, deshacer, y aplicarlo todo después en un solo paso auditado.
--   Mezclar las dos cosas obligaría a resolver revisiones a medias.
--
-- DESHACER: una decisión retirada NO se borra; pasa a `withdrawn`. Quién
--   decidió qué y cuándo es justamente lo que hay que poder mirar luego.
--
-- REGLAS DE GOBIERNO: el schema `public` NO se toca. Idempotente y reversible.
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS ingest.review_decisions (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  review_id BIGINT NOT NULL REFERENCES ingest.review_queue(id) ON DELETE CASCADE,
  -- 'same'/'different'/'unsure' en careos; 'canonical'/'proposed'/'unsure'
  -- en conflictos de campo; 'approve'/'reject'/'unsure' en grupos de la cola.
  verdict VARCHAR(20) NOT NULL CHECK (verdict IN ('same','different','unsure','canonical','proposed','approve','reject')),
  -- Quién decidió. Texto libre: el equipo se identifica al entrar, no hay
  -- cuentas y fingir que las hay sería peor que decirlo.
  decided_by VARCHAR(80) NOT NULL,
  note TEXT,
  -- Contexto de lo que se vio al decidir, para que la decisión siga siendo
  -- legible aunque la cola cambie debajo.
  context JSONB,
  status VARCHAR(12) NOT NULL DEFAULT 'active' CHECK (status IN ('active','withdrawn')),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  withdrawn_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  applied_run_id BIGINT REFERENCES ingest.scrape_runs(id) ON DELETE SET NULL,
  CONSTRAINT review_decisions_withdrawn_chk CHECK (
    (status = 'withdrawn') = (withdrawn_at IS NOT NULL)
  )
);

-- Una sola decisión viva por revisión y persona: decidir otra vez sustituye,
-- no acumula. El índice parcial deja pasar el historial retirado.
CREATE UNIQUE INDEX IF NOT EXISTS review_decisions_live_uk
  ON ingest.review_decisions(review_id, decided_by)
  WHERE status = 'active';

CREATE INDEX IF NOT EXISTS review_decisions_review_idx ON ingest.review_decisions(review_id);
CREATE INDEX IF NOT EXISTS review_decisions_pending_idx
  ON ingest.review_decisions(decided_at DESC) WHERE status = 'active' AND applied_at IS NULL;

COMMIT;
