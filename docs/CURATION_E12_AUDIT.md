# Auditoría de cierre · PLAN_CURADURIA E11–E12

Fecha: 2026-09-20  
Rama: `feat/curaduria-e11-e12`  
PR: #2

> Esta auditoría pertenece al plan de Curaduría E11/E12. `docs/FINAL_AUDIT.md` es una instantánea histórica de otro ciclo y no sustituye este cierre.

## Problemas encontrados al auditar E11/E12 contra datos reales

La primera implementación era correcta estructuralmente, pero la foto `catalog-2026-09-16` mostró cinco defectos de cierre:

1. E11 ampliaba la superficie de reglas sin obligar a tener corpus/umbral de precisión.
2. `disco_sin_pistas` añadía 1.670 hallazgos sin acción y degradaba artificialmente el KPI de cobertura.
3. Cuatro E11 localizables estaban marcados globales, retrasando `corregir → verificar → cerrar`.
4. Las pruebas de E11/E12 eran demasiado superficiales y el CLI no tenía contrato unitario.
5. Dos heurísticas producían falsos positivos reales (`Grabaciones Silvestres`, `Record Plant`, `DIESEL`, `MARSHALL`).
6. `/curation/summary` recalculaba cobertura leyendo todos los abiertos en cada polling.

## Matriz de cierre endurecida

| Requisito | Estado | Evidencia |
|---|---|---|
| 11 detectores E11 | cerrado | `advanced.ts` + prueba de claves/positivos |
| Precisión E11 real | cerrado | corpus 513 casos; los 4 E11 que emiten en la fixture real tienen muestra + umbral ≥90 % |
| Regresión de falsos positivos | cerrado | `Grabaciones Silvestres`, `Record Plant`, `DIESEL`, `MARSHALL` etiquetados y protegidos |
| Ruido de `disco_sin_pistas` | cerrado | sigue visible como informativo; excluido del denominador accionable |
| Ciclo dirigido E9/E11 | cerrado | 4 locales / 7 globales + contrato PostgreSQL de cierre dirigido |
| Precisión operativa E12 | cerrado | fórmula separada del corpus; alerta <80 % solo desde n=20 |
| Cobertura ≤N1/≤N2 | cerrado | denominador accionable y `excludedInformational` explícito |
| Lotes | cerrado | `total`, `previewed`, `applied`, `undone` |
| Autocorrección | cerrado | `autoApplied`, `autoReverted` |
| CLI preview | cerrado | parser puro probado + `--preview` obligatorio |
| SQL de métricas | cerrado | contrato con resultados numéricos exactos |
| Coste de polling | cerrado | caché 10 s por pool + exclusión temprana de informativos |
| UI/API/tipos | cerrado | esquema Zod, tipos web y panorama sincronizados |

## Resultado de calibración

Sobre la misma foto real:

| Detector | Antes | v5 |
|---|---:|---:|
| `tipo_de_organizacion_contra_nombre` | 60 | 21 |
| `mayusculas_sostenidas` | 26 | 1 |
| `disco_sin_pistas` | 1.670 accionando contra el KPI | 1.670 informativos, fuera del KPI |
| `pistas_sin_duracion_en_disco_con_duraciones` | 56 | 56 |

No se redujo `disco_sin_pistas` ocultando datos: se corrigió su semántica. La ausencia de tracklist continúa visible para completar el catálogo, pero ya no se presenta como si existiera una corrección N1/N2 que no existe.

## Pruebas de aceptación

CI #98 sobre `2b66213025decf54f446b154010c1048f07453f4` terminó completamente verde:

- TypeScript: PASS.
- ESLint: PASS.
- Unitarias/cobertura: **44 archivos, 382 tests PASS**.
- Contratos PostgreSQL: **42 archivos, 259 tests PASS**.
- Web tipos/build: PASS.

Los contratos añadidos prueban específicamente valores de E12 y el cierre dirigido E11; no se limita a comprobar que un endpoint devuelve 200.

## Límites explícitos

- Esta auditoría valida el repositorio y PostgreSQL desechable de CI; no afirma el estado de una base desplegada fuera del repositorio.
- Los siete detectores E11 relacionales que no pueden evaluarse con la fixture histórica siguen exigiendo pruebas sintéticas y deberán incorporarse al corpus real cuando una nueva foto congelada contenga créditos, aliases, redirecciones y media links.
- Una alerta operacional de precisión requiere 20 decisiones; el porcentaje se sigue mostrando por debajo de ese tamaño, sin convertirlo en alarma.

## Criterio de cierre

Los puntos que mantenían el PR en 15/20 quedan convertidos en condiciones verificables por CI: precisión mínima, semántica de accionabilidad, alcance local/global, negativos reales, métricas SQL exactas, seguridad del CLI y ciclo de cierre dirigido. El código validado por CI #98 está verde; cualquier commit documental posterior debe conservar el mismo gate antes de fusionar.
