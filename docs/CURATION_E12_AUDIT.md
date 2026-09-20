# Auditoría de cierre · PLAN_CURADURIA E11–E12

Fecha de implementación: 2026-09-20  
Rama: `feat/curaduria-e11-e12`  
PR: #2

> Esta auditoría pertenece al plan de Curaduría E11/E12. `docs/FINAL_AUDIT.md` es una instantánea histórica de otro ciclo del proyecto y no sustituye este cierre.

## Matriz de cierre

| Requisito | Implementación | Evidencia |
|---|---|---|
| 11 detectores E11 | `src/curation/detectors/advanced.ts` | `test/unit/curation-e11.test.ts` exige las 11 claves y un caso positivo por detector |
| Datos relacionales para E11 | snapshot completo en `src/curation/snapshot.ts` | una sola transacción `REPEATABLE READ`; E11 marcado global |
| No penalizar análisis dirigido | colecciones E11 vacías en snapshot enfocado + detectores globales | diseño E9 preservado |
| Precisión operativa | `src/curation/metrics.ts` | separada y rotulada como observada; corpus E2 sigue independiente |
| Alerta <80 % | `PRECISION_ALERT_THRESHOLD = 0.8` | API, CLI y panorama muestran alerta |
| Tiempo medio de corrección | `resolved_at - first_seen_at` para `fixed_by_curation` | `metrics.meanCorrectionSeconds` |
| Cobertura por nivel | acciones reales de cada hallazgo abierto | `level1OrLessPct`, `level2OrLessPct` |
| Lotes deshechos / auto revertidos | `curation_fix_batches` | `metrics.batches` |
| CLI preview | `curation fix --preview --detector=...` | crea lote previewed sin mutar catálogo |
| Panorama web | `CurationOverviewPage.tsx` | salud operativa + alertas + detalle por detector |
| Documentación | `docs/CURATION_OPERATIONS.md` | definiciones, comandos y límites |
| CI | PR #2 · run #90 · SHA `3d632522f8a6d8c9e71d62faa612e8c8e3714a0d` | **PASS** — Calidad (typecheck, lint, 43 archivos/375 unitarias + cobertura), Contratos PostgreSQL y build web en verde |

## Límites que se conservan explícitos

- Las heurísticas E11 detectan anomalías; no afirman por sí solas que el dato sea incorrecto.
- Los detectores sin una transformación inequívoca no reciben una acción automática.
- La precisión observada puede tener muestras pequeñas; por eso siempre incluye `reviewed`.
- Esta auditoría del repositorio no confirma el estado de una base de producción ni ejecuta migraciones sobre ella.

## Criterio de cierre

E11/E12 quedan técnicamente cerradas para el código validado en el SHA `3d632522f8a6d8c9e71d62faa612e8c8e3714a0d`: los tres jobs del CI #90 (Calidad, Contratos, Web) terminaron en verde, sin error de typecheck, lint, unitarias ni contratos. El commit posterior que actualiza esta auditoría es documental y debe conservar CI verde antes de fusionar.
