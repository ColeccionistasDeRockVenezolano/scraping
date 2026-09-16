-- ============================================================================
-- CRV · Migración 0015_review_kind_person_duplicate (DOWN) — IRREVERSIBLE
--
-- PostgreSQL no permite eliminar valores de un enum. 0004_review_kinds lo
-- resolvió recreando el enum entero, pero aquí no se hace:
--
--   * `person_duplicate` es el kind con el que el detector de candidatos
--     (E11.5) propone pares; las revisiones que ya lo usan quedarían
--     inválidas y el down tendría que abortar (como el de 0004) o destruir
--     trabajo humano.
--   * Un valor de enum de más no rompe nada: el core y las consultas
--     existentes ignoran los kinds que no conocen.
--
-- Por eso el down no hace nada y lo dice: revertir 0015 exige decidir antes
-- qué pasa con las revisiones `person_duplicate` (resolverlas o
-- reclasificarlas) y recrear el enum a mano. El schema `public` no se toca.
-- ============================================================================

-- Intencionadamente sin efecto (ver arriba).
SELECT 1;
