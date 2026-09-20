# Curaduría · Operación E11–E12

Este documento describe la implementación endurecida de `PLAN_CURADURIA` E11/E12. No debe confundirse con las etapas E11 históricas de `PHASES.md`.

## E11 · cobertura profunda

Los once detectores de E11 viven en `src/curation/detectors/advanced.ts`. La versión de reglas es `curation-rules.v5`.

| Detector | Alcance | Qué comprueba |
|---|---|---|
| `creditos_duplicados` | global | filas de crédito exactamente repetidas sobre el mismo disco/pista y destino |
| `rol_contra_tipo_de_credito` | global | un rol con marcador fuerte que contradice `credit_type` |
| `periodo_de_membresia_imposible` | global | intervalos invertidos, futuros, actuales con fin o anteriores a la formación |
| `tipo_de_organizacion_contra_nombre` | local | una organización `other` con un único marcador inequívoco de tipo |
| `sello_que_es_artista` | global | sello usado por discos cuyo nombre coincide con una ficha de artista |
| `disco_sin_pistas` | local · informativo | discos sin tracklist; describe una carencia, no un error corregible por sí solo |
| `pistas_sin_duracion_en_disco_con_duraciones` | local | tracklists que mezclan duraciones presentes y ausentes |
| `mayusculas_sostenidas` | local | frases claramente normalizables en mayúsculas; evita marcas y siglas ambiguas |
| `alias_que_choca_con_otra_ficha` | global | alias que coincide con el nombre canónico de otra ficha del mismo tipo |
| `redireccion_en_cadena` | global | `from → via → final` no comprimido |
| `enlace_de_medio_a_ficha_fusionada` | global | `media_links` que todavía apunta a un id redirigido |

Los cuatro detectores locales participan en la verificación dirigida de E9. Una corrección sobre la ficha puede cerrar su hallazgo inmediatamente sin esperar el siguiente análisis completo. Los siete relacionales permanecen globales porque requieren información que no cabe en una vecindad dirigida.

### Calibración con la foto real 2026-09-16

La misma fixture `catalog-2026-09-16` usada por E2 se ejecutó contra E11 antes de fijar las reglas. La calibración v5 dejó:

- `tipo_de_organizacion_contra_nombre`: **60 → 21**. Ya no contradice un tipo curado únicamente por el nombre. `Grabaciones Silvestres` y `Record Plant` quedan como regresiones de falso positivo.
- `mayusculas_sostenidas`: **26 → 1**. `DIESEL`, `MARSHALL` y formas de sigla quedan fuera; el detector exige una frase inequívoca.
- `disco_sin_pistas`: **1.670** condiciones reales, ahora marcadas como **informativas** y excluidas del KPI de cobertura de acciones.
- `pistas_sin_duracion_en_disco_con_duraciones`: **56** condiciones objetivas.

El corpus de E2 contiene ahora **513 casos**. Todo E11 que emite sobre la foto congelada debe tener muestra etiquetada y umbral de precisión **≥90 %**; el test falla si vuelve a aparecer un detector E11 evaluable sin esa cobertura. Los siete E11 relacionales que la fixture histórica no puede ejecutar siguen cubiertos por positivos/negativos sintéticos hasta disponer de una foto congelada que contenga esas relaciones.

## E12 · observabilidad

`GET /curation/summary` añade `metrics`:

- **precisión observada por detector**: `fixed_by_curation / (fixed_by_curation + falso_positivo + correcto_a_proposito)`;
- `fuera_de_alcance` no entra en el denominador porque no decide si la regla acertó;
- **alerta <80 % solo con n≥20 decisiones concluyentes**; muestras menores se publican, pero no generan una alarma;
- **tiempo medio hallazgo → corrección**, usando solo resoluciones `fixed_by_curation`;
- **cobertura de acciones** calculada sobre hallazgos accionables; los informativos siguen visibles y se reportan como `excludedInformational`;
- lotes separados en `total`, `previewed`, `applied` y `undone`;
- autocorrecciones separadas en `autoApplied` y `autoReverted`.

La precisión observada es operacional. El corpus etiquetado de E2 sigue siendo la prueba de regresión de reglas.

### Coste del panorama

Durante un análisis la web consulta el resumen con frecuencia. Las métricas tienen caché de **10 s**, aislada por pool PostgreSQL, y el SELECT de cobertura no carga los hallazgos informativos. En la foto auditada eso evita releer las 1.670 filas de `disco_sin_pistas` para calcular accionabilidad en cada refresco.

## CLI de previsualización

```bash
npm run cli -- curation fix --preview --detector=mayusculas_sostenidas
npm run cli -- curation fix --preview --detector=tipo_de_disco_contra_titulo --signature=sin_clasificar --limit=25
npm run cli -- curation fix --preview --detector=caracteres_invisibles --action=limpiar_texto
```

`--preview` es obligatorio. El parser rechaza detector desconocido y límites fuera de 1–50000. El comando crea un lote `previewed` y muestra su `previewHash`, acciones, niveles y bloqueos; **no modifica el catálogo**. Aplicar sigue requiriendo revisar el lote desde la web/API y aportar nota.

## Validación

La puerta normal sigue siendo GitHub Actions:

1. TypeScript + ESLint + unitarias/cobertura.
2. Contratos con PostgreSQL desechable.
3. Build de la web.

Cobertura específica de cierre:

- `test/unit/curation-e11.test.ts`: 11 claves, positivos, negativos y clasificación local/global.
- `test/unit/curation-precision.test.ts`: corpus real, umbrales y guardia para E11 evaluable.
- `test/unit/curation-metrics.test.ts`: fórmula, mínimo de muestra e informativos fuera del KPI.
- `test/unit/curation-cli.test.ts`: llave `--preview`, detector y límites del CLI.
- `test/contract/curation-metrics.test.ts`: valores exactos de precisión, alerta, cobertura y estados de lotes contra PostgreSQL real.
- `test/contract/curation-e11-local.test.ts`: demuestra `corregir → análisis dirigido → hallazgo cerrado`.

CI #98 sobre `2b66213025decf54f446b154010c1048f07453f4`: typecheck, lint, **44 archivos / 382 unitarias**, **42 archivos / 259 contratos PostgreSQL** y build web en verde.
