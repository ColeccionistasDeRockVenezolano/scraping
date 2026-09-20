# Curaduría · Operación E11–E12

Este documento describe la implementación endurecida de `PLAN_CURADURIA` E11/E12. No debe confundirse con las etapas E11 históricas de `PHASES.md`.

## E11 · cobertura profunda

Los once detectores viven en `src/curation/detectors/advanced.ts`. La versión vigente es `curation-rules.v5`.

| Detector | Alcance | Comportamiento |
|---|---|---|
| `creditos_duplicados` | global | crédito exactamente repetido |
| `rol_contra_tipo_de_credito` | global | rol inequívoco contra `credit_type` |
| `periodo_de_membresia_imposible` | global | intervalo temporal imposible |
| `tipo_de_organizacion_contra_nombre` | local | solo `other` + un marcador inequívoco |
| `sello_que_es_artista` | global | sello cuyo nombre coincide con artista |
| `disco_sin_pistas` | local · informativo | ausencia de tracklist; visible, pero no accionable |
| `pistas_sin_duracion_en_disco_con_duraciones` | local | duraciones parcialmente cargadas |
| `mayusculas_sostenidas` | local | frases inequívocas; evita marcas y siglas |
| `alias_que_choca_con_otra_ficha` | global | alias contra nombre canónico |
| `redireccion_en_cadena` | global | redirección no comprimida |
| `enlace_de_medio_a_ficha_fusionada` | global | media link que conserva un id fusionado |

Los cuatro detectores locales participan en la verificación dirigida de E9; los siete relacionales permanecen globales.

### Calibración con `catalog-2026-09-16`

La misma foto congelada usada por E2 dejó esta calibración v5:

- `tipo_de_organizacion_contra_nombre`: **60 → 21**. `Grabaciones Silvestres` y `Record Plant` son regresiones protegidas.
- `mayusculas_sostenidas`: **26 → 1**. `DIESEL`, `MARSHALL` y formas de sigla quedan fuera.
- `disco_sin_pistas`: **1.670** condiciones reales, ahora **informativas** y excluidas del KPI de acciones.
- `pistas_sin_duracion_en_disco_con_duraciones`: **56** condiciones objetivas.

El corpus de E2 contiene **513 casos**. Todo E11 que emite sobre la foto histórica debe tener muestra etiquetada y umbral **≥90 %**. El CI falla si vuelve a aparecer un E11 evaluable sin esa cobertura. Los siete relacionales que la fixture histórica no contiene siguen cubiertos por pruebas sintéticas hasta disponer de una foto real con esas relaciones.

## E12 · observabilidad

`GET /curation/summary` publica:

- precisión observada: `fixed_by_curation / (fixed_by_curation + falso_positivo + correcto_a_proposito)`;
- `fuera_de_alcance` fuera del denominador;
- alerta de precisión <80 % **solo con n≥20** decisiones concluyentes;
- tiempo medio hallazgo → corrección;
- cobertura ≤N1 y ≤N2 **solo sobre hallazgos accionables**;
- `excludedInformational` para lo visible que no debe degradar ese KPI;
- lotes `total`, `previewed`, `applied`, `undone`;
- autocorrecciones `autoApplied` y `autoReverted`.

La precisión observada es operacional; el corpus etiquetado de E2 sigue siendo la regresión de reglas.

### Coste de `/curation/summary`

Las métricas tienen caché de **10 s** aislada por pool PostgreSQL. Además, el SELECT que calcula cobertura excluye los detectores informativos antes de cargar `related` y `evidence`; en la foto auditada eso evita cargar las 1.670 filas de `disco_sin_pistas` para el KPI.

## CLI segura

```bash
npm run cli -- curation fix --preview --detector=mayusculas_sostenidas
npm run cli -- curation fix --preview --detector=tipo_de_disco_contra_titulo --signature=sin_clasificar --limit=25
npm run cli -- curation fix --preview --detector=caracteres_invisibles --action=limpiar_texto
```

`--preview` es obligatorio. El parser rechaza detector desconocido y `--limit` fuera de 1–50000. Se crea un lote auditado `previewed`, pero **no se modifica el catálogo**.

## Pruebas de aceptación

- `test/unit/curation-e11.test.ts`: 11 claves, positivos, negativos y alcance local/global.
- `test/unit/curation-precision.test.ts`: corpus real, umbrales y guardia E11.
- `test/unit/curation-metrics.test.ts`: fórmula, n mínimo e informativos.
- `test/unit/curation-cli.test.ts`: seguridad y parseo de `curation fix --preview`.
- `test/contract/curation-metrics.test.ts`: valores SQL exactos de precisión, alerta, cobertura y lotes.
- `test/contract/curation-e11-local.test.ts`: `corregir → análisis dirigido → cerrar`.

CI #98 sobre `2b66213025decf54f446b154010c1048f07453f4`: typecheck, lint, **44 archivos / 382 unitarias**, **42 archivos / 259 contratos PostgreSQL** y build web en verde.
