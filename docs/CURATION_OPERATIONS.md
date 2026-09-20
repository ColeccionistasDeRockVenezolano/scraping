# Curaduría · Operación E11–E12

Este documento describe la implementación endurecida de `PLAN_CURADURIA` E11/E12. No debe confundirse con las etapas E11 históricas de `PHASES.md`.

## E11 · cobertura profunda

Los once detectores viven en `src/curation/detectors/advanced.ts`. La versión vigente es `curation-rules.v6`.

| Detector | Alcance | Comportamiento |
|---|---|---|
| `creditos_duplicados` | global | crédito exactamente repetido |
| `rol_contra_tipo_de_credito` | global | rol inequívoco contra `credit_type` |
| `periodo_de_membresia_imposible` | global | intervalo temporal imposible |
| `organizacion_sin_clasificar` | local | solo `other` + un marcador inequívoco |
| `sello_que_es_artista` | global | sello cuyo nombre coincide con artista |
| `disco_sin_pistas` | local · informativo | ausencia de tracklist; visible, pero no accionable |
| `pistas_sin_duracion_en_disco_con_duraciones` | local | duraciones parcialmente cargadas |
| `mayusculas_sostenidas` | local | frases inequívocas; evita marcas y siglas |
| `alias_que_choca_con_otra_ficha` | global | alias contra nombre canónico |
| `redireccion_en_cadena` | global | redirección no comprimida |
| `enlace_de_medio_a_ficha_fusionada` | global | media link que conserva un id fusionado |

Los cuatro detectores locales participan en la verificación dirigida de E9; los siete relacionales permanecen globales.

### La foto ahora incluye las relaciones

`catalog-2026-09-16.json.gz` solo tenía fichas, así que los siete detectores relacionales nunca se habían medido contra datos reales. `test/fixtures/curation/relations-2026-09-20.json.gz` (`npm run curation:relations`) añade **29.310 créditos, 1.367 membresías, 40.207 aliases, 2 redirecciones, 1.020 enlaces de medios y 53 discos con sello**, sin tocar las fichas ni, por tanto, las etiquetas de E2.

Medirlos cambió dos reglas que parecían correctas:

- `rol_contra_tipo_de_credito`: **49 hallazgos, 48 falsos positivos**. Los patrones no reconocían participios, así que «Recorded & Mixed by» parecía pertenecer a una sola familia y el detector acusaba una contradicción inexistente. Con las flexiones (v6) quedan **1 hallazgo y es real** («Trompets» clasificado como `other`).
- `alias_que_choca_con_otra_ficha`: **4.152 hallazgos**, casi todos discos y pistas homónimos de artistas distintos —normales en el catálogo— y desambiguaciones deliberadas por ciudad («Nemesis (Lara)» junto a «Nemesis»). La v6 limita el choque al mismo padre, respeta `handledPairs` como el resto de los detectores de repetidos e ignora el calificador entre paréntesis: **62 hallazgos**, todos sospechas reales de repetición.
- `creditos_duplicados`: **57 hallazgos** sobre 22 fichas. Comprobado en la base: ningún grupo difiere siquiera en `notes`, son filas idénticas.
- `periodo_de_membresia_imposible`, `sello_que_es_artista`, `redireccion_en_cadena` y `enlace_de_medio_a_ficha_fusionada` emiten **0**: con 2 redirecciones y 53 discos con sello, el catálogo todavía no tiene material para ellos. Siguen cubiertos por pruebas sintéticas.

Calibración de los locales (sin cambios desde v5):

- `organizacion_sin_clasificar`: **60 → 21**. `Grabaciones Silvestres` y `Record Plant` son regresiones protegidas.
- `mayusculas_sostenidas`: **26 → 1**. `DIESEL`, `MARSHALL` y las formas de sigla quedan fuera. El catálogo entero solo tiene 26 nombres en caja alta y 25 de ellos son marcas o siglas: el detector es una guardia contra futuras importaciones sucias, no una cosecha.
- `disco_sin_pistas`: **1.670** condiciones reales, ahora **informativas** y excluidas del KPI de acciones.
- `pistas_sin_duracion_en_disco_con_duraciones`: **56** condiciones objetivas.

El corpus de E2 contiene **648 casos**. Todo E11 que emite sobre la foto debe tener **≥20 decisiones etiquetadas** —la vara de E2— y umbral **≥90 %**; el CI falla si aparece un E11 evaluable sin esa cobertura.

## E12 · observabilidad

`GET /curation/summary` publica:

- precisión observada: `fixed_by_curation / (fixed_by_curation + falso_positivo + correcto_a_proposito)`;
- `fuera_de_alcance` fuera del denominador;
- alerta de precisión <80 % **solo con n≥20** decisiones concluyentes;
- tiempo medio hallazgo → corrección;
- cobertura ≤N1 y ≤N2 **solo sobre hallazgos accionables**;
- `excludedInformational` para lo visible que no debe degradar ese KPI;
- `totals.openInformational`: el total de abiertos sigue contándolo todo, pero dice cuánto de eso es informativo, para que 1.670 fichas sin tracklist no se lean como una regresión en el panorama;
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

Verificado en local sobre la v6: typecheck y lint limpios, **44 archivos / 382 unitarias** y los contratos de curaduría contra PostgreSQL real en verde.
