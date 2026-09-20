# Curaduría · Operación E11–E12

Este documento describe la implementación de `PLAN_CURADURIA` E11/E12. No debe confundirse con las etapas E11 históricas de `PHASES.md`.

## E11 · cobertura profunda

Los once detectores de E11 viven en `src/curation/detectors/advanced.ts` y son **globales**. El análisis completo carga créditos, membresías, aliases, redirecciones y enlaces de medios dentro de la misma fotografía `REPEATABLE READ`; el análisis dirigido de E9 no carga esas colecciones y no ejecuta estos detectores.

| Detector | Qué comprueba |
|---|---|
| `creditos_duplicados` | filas de crédito exactamente repetidas sobre el mismo disco/pista y destino |
| `rol_contra_tipo_de_credito` | un rol con marcador fuerte que contradice `credit_type` |
| `periodo_de_membresia_imposible` | intervalos invertidos, futuros, actuales con fin o anteriores a la formación |
| `tipo_de_organizacion_contra_nombre` | marcadores fuertes de estudio/productora/distribuidora/management/sello |
| `sello_que_es_artista` | sello usado por discos cuyo nombre coincide con una ficha de artista |
| `disco_sin_pistas` | discos sin tracklist |
| `pistas_sin_duracion_en_disco_con_duraciones` | tracklists que mezclan duraciones presentes y ausentes |
| `mayusculas_sostenidas` | nombres/títulos largos completamente en mayúsculas; ofrece `capitalizar` |
| `alias_que_choca_con_otra_ficha` | alias que coincide con el nombre canónico de otra ficha del mismo tipo |
| `redireccion_en_cadena` | `from → via → final` no comprimido |
| `enlace_de_medio_a_ficha_fusionada` | `media_links` que todavía apunta a un id redirigido |

Los detectores nuevos no escriben el catálogo. Donde no existe una corrección determinista y reversible, el hallazgo queda para revisión humana.

## E12 · observabilidad

`GET /curation/summary` añade `metrics`:

- **precisión observada por detector**: `fixed_by_curation / (fixed_by_curation + falso_positivo + correcto_a_proposito)`;
- `fuera_de_alcance` no entra en el denominador porque no decide si la regla acertó;
- **alerta** cuando esa precisión observada es menor de 80 %; el número de decisiones se devuelve junto al porcentaje para no ocultar muestras pequeñas;
- **tiempo medio hallazgo → corrección**, usando solo resoluciones `fixed_by_curation`;
- **cobertura de acciones** sobre hallazgos abiertos: porcentaje con una acción recomendada de nivel ≤1 y ≤2;
- **lotes deshechos** y **autocorrecciones revertidas**.

La precisión observada es una métrica operacional. La prueba de precisión de reglas sigue siendo el corpus etiquetado de E2 (`test/unit/curation-precision.test.ts`).

## CLI de previsualización

```bash
npm run cli -- curation fix --preview --detector=mayusculas_sostenidas
npm run cli -- curation fix --preview --detector=tipo_de_disco_contra_titulo --signature=sin_clasificar --limit=25
npm run cli -- curation fix --preview --detector=caracteres_invisibles --action=limpiar_texto
```

El comando crea un lote `previewed` y muestra su `previewHash`, acciones, niveles y bloqueos. **No modifica el catálogo.** La metadata de la vista previa sí se persiste para auditoría. Aplicar sigue requiriendo revisar el lote desde la web/API y aportar nota.

## Comandos de operación

```bash
npm run cli -- curation scan --dry-run
npm run cli -- curation scan
npm run cli -- curation summary
npm run cli -- curation autofix
npm run cli -- curation prune --dry-run
```

`curation summary` muestra las nuevas métricas y escribe en stderr los detectores por debajo del umbral de 80 %.

## Validación

La puerta normal sigue siendo GitHub Actions:

1. TypeScript + ESLint + unitarias/cobertura.
2. Contratos con PostgreSQL desechable.
3. Build de la web.

E11 añade `test/unit/curation-e11.test.ts`, que obliga a registrar los once detectores y a que cada uno reconozca un caso sintético. E12 añade `test/unit/curation-metrics.test.ts` para el cálculo y el umbral. Las métricas SQL y el snapshot pasan además por typecheck y por los contratos que levantan el esquema real.
