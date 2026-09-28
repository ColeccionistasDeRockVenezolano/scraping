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
  Desde el 20/09 los 21 se corrigen desde la tarjeta con `fijar_tipo_de_organizacion` (nivel 1, inversa `field_restore`):
  la acción no vuelve a inferir el tipo —usa el `suggestedType` que ya decidió el detector— y se bloquea (`stale`) si
  alguien clasificó la ficha entretanto, porque entonces la premisa del hallazgo caducó.
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

## Deshacer cualquier cambio

Cada lote, corrección, fusión, división o edición es un run del diario (migración 0028):

```bash
npm run cli -- runs list                     # los más recientes, con su estado de deshecho
npm run cli -- runs show 812                 # qué tocó y qué haría deshacerlo
npm run cli -- runs undo 812 --note="motivo"            # vista previa, no escribe
npm run cli -- runs undo 812 --note="motivo" --confirm  # deshace (otro run: se rehace deshaciéndolo)
```

En la web: la barra «Deshacer» aparece tras cada cambio y la página **Historial** lista todo. Deshacer un lote de Curaduría desde su pantalla sigue funcionando y, con diario, devuelve también las divisiones y conversiones.

## Deshacer lo anterior al diario (decisión por decisión)

Un proceso de entonces podía fusionar cientos de fichas de una vez, así que se
deshace **una decisión a la vez**, desde su fila del historial:

```bash
npm run cli -- audit show 127140                    # qué fue y si se puede deshacer
npm run cli -- audit undo 127140 --note="motivo"            # vista previa, no escribe
npm run cli -- audit undo 127140 --note="motivo" --confirm  # deshace (queda como run del diario)
```

Las **conversiones** (persona → artista u organización) se deshacen solo con su
auditoría. Las **fusiones anteriores al 15-09-2026** necesitan que se les
reconstruya el rastro desde un respaldo anterior al cambio, restaurado en una
base desechable:

```bash
npm run cli -- merges rebuild-traces --snapshot='postgresql://crv:…@127.0.0.1:55499/crv_snap' --label='crv-20260915T063612Z'
```

**Solo se deshace lo verificado**: si lo reconstruido no cuadra exactamente con
lo que la fusión registró haber movido, queda marcada como no reversible y se
dice cuántas filas faltan. En desarrollo (23-09-2026): 209 de 1.717 fusiones
viejas quedaron verificadas y las 15 conversiones se pueden deshacer; los runs
144–220 no tienen ningún respaldo anterior del cual reconstruirlas.

En la web, esas filas del **Historial de campos** de la ficha (`merged_duplicate`,
`absorbed_person`) traen su botón «Deshacer».

## Medir la cobertura sin base de datos

```bash
npm run curation:coverage
```

Analiza la foto congelada (`catalog-2026-09-16` + `relations-2026-09-20`) y aplica la **misma regla que
`/curation/summary`** —nivel del hallazgo = el mínimo de sus acciones, informativos fuera del denominador—
para publicar el KPI de §4 del plan por categoría y por detector, y decir si cumple. No toca PostgreSQL:
sirve para verificar el criterio de cierre sin acceso a la base de desarrollo.

Última corrida (2026-09-20): 5.414 accionables + 1.670 informativos; **≤N1 84,7 %** (exige ≥30 %) y
**≤N2 87,0 %** (exige ≥70 %).

El script **imprime**; quien defiende el criterio es `test/unit/curation-coverage.test.ts`, que corre en CI
sobre la misma foto y con la misma regla (`src/curation/coverage.ts`, compartida con `/curation/summary`:
tenerla escrita tres veces fue el defecto §3.1 del cierre). Exige los mínimos de §4, un piso de regresión por
debajo de lo medido y —la guardia que faltaba— que **todo detector que declara una acción la ofrezca en algún
hallazgo real**: declarar no es ofrecer.

## Pruebas de aceptación

- `test/unit/curation-e11.test.ts`: 11 claves, positivos, negativos y alcance local/global.
- `test/unit/curation-precision.test.ts`: corpus real, umbrales y guardia E11.
- `test/unit/curation-coverage.test.ts`: KPI de acciones de §4 sobre la foto, con piso de regresión.
- `test/unit/curation-metrics.test.ts`: fórmula, n mínimo e informativos.
- `test/unit/curation-cli.test.ts`: seguridad y parseo de `curation fix --preview`.
- `test/contract/curation-metrics.test.ts`: valores SQL exactos de precisión, alerta, cobertura y lotes.
- `test/contract/curation-e11-local.test.ts`: `corregir → análisis dirigido → cerrar`.

Verificado en local sobre la v6: typecheck y lint limpios, **44 archivos / 382 unitarias** y los contratos de curaduría contra PostgreSQL real en verde.

## Géneros (PLAN_GENEROS etapa 2)

Todo cambio pide `--by` y `--reason`; sin `--confirm` corre entero dentro de una
transacción que se deshace e imprime el antes/después.

```bash
npm run cli -- genres taxonomy-apply --by=<quién> --reason="<por qué>" [--confirm]   # data/genres/taxonomy.json
npm run cli -- genres backfill [--level=album|artist] --by=<quién> [--confirm]      # reports/genres-backfill-<modo>.{json,md}
npm run cli -- genres resolve "Thrash / Death Metal"
npm run cli -- genres alias-set "rock duro" hard-rock --by=… --reason=… [--confirm]
npm run cli -- genres alias-remove "rock duro" --by=… --reason=… [--confirm]
npm run cli -- genres rename hard-rock "Hard rock" --by=… --reason=… [--confirm]      # el slug no cambia
npm run cli -- genres deactivate glam-rock --replacement=hard-rock --by=… --reason=… [--confirm]
npm run cli -- genres confirm album <id> <slug> [--role=primary|secondary] --by=… --reason=…
npm run cli -- genres reject|revert album <id> <slug> --by=… --reason=…
```

- Un cambio de alias recalcula solo las entidades cuyo texto usa ese alias, y
  solo sus filas `rule`; las `human` reciben un aviso si su texto deja de
  resolver. Los reportes quedan en `reports/genres-taxonomy-<modo>.json`.
- Orden de puesta en marcha: `taxonomy-apply --confirm` → `backfill` (ensayo) →
  revisar el reporte → `backfill --confirm` → encender
  `GENRES_PROJECTION_ENABLED=true` → `backfill --confirm` otra vez para
  proyectar `albums.genre`. Apagar el interruptor devuelve la escritura de
  `albums.genre` al motor sin perder asignaciones.
- Revertir la 0027 exige el interruptor apagado.
- `confirm`, `reject` y `revert` del CLI abren su propio run (diario de cambios
  y `genre_assignment_log`), igual que la Mesa.

## Géneros en la Mesa de Cotejo (PLAN_GENEROS etapa 3)

Pestaña **Géneros** de la Mesa (`npm run cotejo:build` + `pm2 restart crv-cotejo`).
Guía para quien decide: `docs/curation/GUIA_EDITORIAL_GENEROS.md`.

- **Sesión de herra.** `POST /api/auth/login` con la SQLite de herra
  (`CRV_HERRA_DB_PATH`, `CRV_HERRA_PROJECT_SLUG`), en solo lectura, mismo scrypt
  y `session_version` que CRV Catálogo (`src/cotejo/auth.ts`). Cookie
  `crv_cotejo_session` HttpOnly SameSite=Strict; las escrituras llevan
  `X-CRV-CSRF`. Leer es libre; escribir géneros: 401 sin sesión o con sesión que
  herra invalidó, 403 si la cuenta no es admin del proyecto ni superadmin. El
  actor es `herra:<usuario>`; el servidor ignora `decidedBy`. Las demás
  escrituras de la Mesa (veredictos de careo) no cambian.
- **API** (`src/cotejo/genres-routes.ts`): `GET /api/genres/queue`
  (`category`, `kind`, `q`, `limit`, `offset`), `GET /api/genres/entity/:kind/:id`,
  `GET /api/genres/vocabulary`, `GET /api/genres/metrics`,
  `GET /api/genres/batches[/members]`, `POST /api/genres/decisions`
  (`confirm_primary`, `add_secondary`, `reject`, `revert`,
  `insufficient_evidence`, `reopen`, `request_new_term`) y `POST /api/genres/batch`.
- **Cola** (`src/genres/curation.ts`): sin clasificar, desconocido, compuesto,
  desacuerdo, contradice una decisión, término nuevo, sugerencia externa y de IA.
  Orden: discos con canciones en la radio → artistas con canciones en la radio →
  conflictos → discos con más pistas → resto.
- **Cada decisión es un run** (`withOperatorRun`): queda en el diario de cambios
  y se puede deshacer desde el historial; los casos que la motivaron se cierran
  a nombre de la persona (`resolved_by = human`).
- **Lotes**: solo casos abiertos con el mismo texto de fuente normalizado; el
  servidor exige que `expectedReviewIds` sea exactamente la lista vigente.
- **Términos nuevos**: casos con `origin = genres-editorial`; ningún recálculo los
  cierra. Se atienden con `crv genres alias-set`/`taxonomy-apply`.
- **Publicación**: la API del catálogo devuelve `primaryGenre`, `genres` y
  `genreStatus` en discos y artistas, `genreOrigin: "album"` en pistas, y filtra
  por `genre=<slug>` (una familia incluye a sus hijos) en `/albums`, `/artists`
  y `/tracks`; `/albums` también por `decade` y `albumType`.
- **Radio**: la radio en vivo (`herra/data/crv-radio-catalog.json`) la exporta
  herra (cron 04:00, `src/scripts/radio-export-cron.sh`). Ese mismo cron corre
  después `npm run radio:genres -- <ruta>` en este repo, que anota cada pieza con
  `albumId` y los géneros confirmados de su disco y sube el archivo a v3
  (`RADIO_CATALOG_VERSION = 3`). No agrega, quita ni reordena piezas; solo
  escribe si algo cambió y, si falla, la radio sigue con lo exportado. Para
  publicar una decisión antes del cron: `npm run radio:genres --
  /home/brian/apps/herra/data/crv-radio-catalog.json` (herra recarga sola por
  fecha de modificación; `--dry-run` solo cuenta). herra lee v2 y v3.
