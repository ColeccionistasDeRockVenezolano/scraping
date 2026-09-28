# Auditoría de cierre 20/20 — sistema de Curaduría completo

- **Etapa:** E12.4 de `~/Desktop/PLAN_CURADURIA_20_DE_20.md` («Auditoría de cierre independiente contra la
  checklist de §4»).
- **Fecha:** 2026-09-20. **Rama:** `master`. **Punto de partida auditado:** `3b12f73` (merge de E11–E12).
- **Alcance:** el sistema entero, no una etapa: `src/curation/**` (11.069 líneas), `src/api/routes/curation*.ts`,
  migraciones `0017`–`0024`, `web/src/pages/Curation*.tsx`, la CLI `crv curation *`, los 13 archivos de
  pruebas unitarias y 9 de contrato del módulo, y la documentación.
- **Método:** verificación contra el **código y las pruebas ejecutadas**, no contra los documentos de etapa.
  Cada punto de §4 se comprobó leyendo el mecanismo que lo cierra y ejecutando la prueba que lo demuestra.
  Las cifras de cobertura y precisión se **midieron** sobre la foto congelada
  (`catalog-2026-09-16.json.gz` + `relations-2026-09-20.json.gz`) con `npm run curation:coverage`; las de
  rendimiento, contra PostgreSQL desechable con el doble del catálogo real.
- **Escrituras contra la base de desarrollo:** ninguna (regla 0.1.5 del plan). No se ejecutó ninguna consulta
  contra `127.0.0.1:5433` en esta auditoría.

> **Desviación de procedimiento declarada.** El plan (§7) pide que esta auditoría la haga un modelo distinto
> del que implementó la mayor parte (Fable 5.1). La hizo Opus 5, que también implementó etapas anteriores. Se
> compensó con el método: nada se dio por bueno por estar escrito en un documento de etapa, y la auditoría
> encontró y corrigió un defecto que ningún cierre anterior había visto (§3.1).

---

## 1. Veredicto

**La checklist §4 se cumple: 13 de 13.** El sistema pasa de ≈11/20 a cumplir todos los criterios de cierre
declarados. Quedan dos salvedades documentadas (§4), ninguna dentro de la checklist.

| # | Criterio §4 | Veredicto |
|---:|---|---|
| 1 | Detector que lanza no resuelve nada (C1); `&#xFFFFFF;` no rompe (C2) | **cumple** |
| 2 | Grupo = filtro visible (C3); escritura obsoleta → 409 (C4) | **cumple** |
| 3 | Fallo de base no tumba la API (C5); foto en una transacción (A3); lock entre procesos (A4) | **cumple** |
| 4 | «No es un problema» y «son distintas» sobreviven; ignorados obsoletos se cierran (A5) | **cumple** |
| 5 | Precisión ≥90 % por detector; falsos positivos de A6 eliminados (A6) | **cumple** |
| 6 | ≥70 % de abiertos con acción ≤N2 y ≥30 % con ≤N1 (A1) | **cumple** (86,6 % / 84,3 %) |
| 7 | Todo lote con vista previa, resultado por ítem y deshacer con instantánea idéntica (A8, M6) | **cumple** |
| 8 | Verificación dirigida <1 s; completo <5 s con el doble de datos (A9) | **cumple, sin holgura** |
| 9 | `resolved` siempre con motivo y run (M1); encadenados se dan por revisados (M2) | **cumple** |
| 10 | Conflictos y cola se deciden desde la tarjeta (M7) | **cumple** |
| 11 | QA visual escritorio/móvil y triaje con teclado documentados (M10) | **cumple** (documentado en esta auditoría) |
| 12 | `typecheck`, `lint` y `npm test` en verde; `core-and-schema` en verde | **cumple** |
| 13 | Documentación y runbook actualizados | **cumple** (completado en esta auditoría) |

---

## 2. Punto por punto, con su evidencia

### 2.1 · C1 y C2 — un análisis parcial no miente

**C1.** `analyzeCatalog` (`src/curation/analyze.ts:201-217`) acumula en `completed` solo los detectores que
terminaron; el que lanza va a `failures`. La resolución filtra por esa lista en SQL
(`src/curation/scan.ts:499`) y otra vez en TypeScript (`looked.has(row.detector)`, `scan.ts:511`), así que los
hallazgos de un detector roto **quedan intactos** y el análisis se marca `status='partial'` (`scan.ts:730`,
CHECK ampliado en `0019`). «Otros» tampoco se da por mirado si falló un detector de forma
(`analyze.ts:219-224`): mostraría lo que ese detector explica.

**C2.** `decodeReference` (`src/curation/detectors/text-hygiene.ts:276-286`) valida el rango antes de
`String.fromCodePoint`: `code >= 1 && code <= 0x10FFFF` y fuera del bloque de surrogates (línea 281). Una
entidad con nombre desconocido no produce `suggestedValue`, así que ya no existe la «corrección» que no
cambia nada. Usa la tabla HTML5 (`decodeHTMLStrict`) y trata 128–159 como Windows-1252, como un navegador.

**Pruebas:** `test/unit/curation-analyzer.test.ts:119,127,140,153`; contrato
`test/contract/curation-scan.test.ts:180` («una referencia HTML fuera de rango no resuelve de golpe los
hallazgos de su detector») y `:195` («un detector que falla deja intactos sus hallazgos y los de "Otros"»).

### 2.2 · C3 y C4 — lo que escribe, escribe lo que se ve

**C3.** `ignore-group`, `fix-group` y la acción de grupo por confianza comparten `groupFilterSchema`
(`src/api/routes/curation.ts:147-151`): categoría, detector, subgrupo, **gravedad, tipo de ficha, texto,
análisis y encadenados**. El mismo filtro va a `POST /curation/fixes/preview` con `mode: "group"`
(`curation-actions.ts:141`), y el recuento que muestra el diálogo es el del lote, no el del listado.

**C4.** Aplicar exige el `previewHash` de la vista previa; si el hash cambió, o si al recalcular lo pendiente
la vista previa ya no da lo mismo, responde **409 `stale_preview` sin escribir nada** y devuelve
`details.changedItemIds`. Dentro del lote, un ítem cuya ficha cambió queda `skipped_stale` y el resto sigue
(`CurationErrorCode` en `repository.ts:320`).

**Pruebas:** `curation-scan.test.ts:417` (grupo filtrado por tipo de ficha no toca lo que el filtro deja
fuera), `:445` (409 y no escribe), `:464` (varios hallazgos sobre la misma ficha se encadenan sin pisarse);
`curation-fixes.test.ts:232,269,318`.

### 2.3 · C5, A3, A4 — robustez operativa

- **C5:** `process.on("unhandledRejection")` registrado en `src/api/server.ts:15`; `notifyCatalogWrite` no
  deja promesas sueltas y `executeScan` no tiene nada fuera del `try`.
- **A3:** la foto va en **una sola transacción** `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`
  (`snapshot.ts:30` para la completa, `:274` para la dirigida), sobre un cliente único.
- **A4:** `pg_try_advisory_lock(hashtext('crv:curation:scan'))` alrededor del análisis (`scan.ts:689`); quien
  no consigue el candado deja el análisis en `status='skipped'` y reintenta.
- **M11 (relacionado):** solo dispara análisis una **lista explícita** de prefijos de catálogo
  (`curation.ts:199-204`); `PATCH /review-queue/:id/priority` ya no provoca un análisis completo.
- **A9 (retención):** `crv curation prune` conserva los últimos 500 análisis y los resueltos de 180 días
  (`retention.ts:13-14`); nunca toca abiertos ni ignorados.

**Pruebas:** `curation-scan.test.ts:219` (base caída durante la verificación de una escritura), `:242` (dos
procesos a la vez: uno guarda, el otro se omite), `:282` (poda); `test/unit/curation-scan-failures.test.ts`.

### 2.4 · A5 — la decisión humana dura

- La huella de un hallazgo de **par** es solo el par ordenado (`analyze.ts:150-154`): ni el valor, ni el
  subgrupo, ni el resto del grupo. Un tercer miembro o un renombrado no borran lo decidido.
- `ingest.curation_distinct_pairs` (`0020`) guarda «son distintas» con quién y nota obligatoria, y entra en
  `handledPairs` de la foto para artistas, organizaciones, personas, discos y pistas.
- Ignorar exige **motivo tipificado** (`falso_positivo`, `correcto_a_proposito`, `fuera_de_alcance`), y el
  ignorado **caduca**: si el problema desaparece pasa a `resolved`, y si vuelve, vuelve abierto.

**Pruebas:** `curation-scan.test.ts:321` (ignorar exige motivo), `:333` (un par ignorado en grupo sobrevive a
un tercer miembro), `:363` (el ignorado caduca y al volver vuelve abierto), `:380` (un par declarado distinto
se resuelve como tal y no vuelve; al retirarlo se reabre).

### 2.5 · A6 — precisión ≥90 %, medida

El corpus `test/fixtures/curation/corpus.json` tiene **648 casos etiquetados** (494 verdaderos positivos, 101
falsos, 53 discutibles) y **39 umbrales, todos ≥0,90**. `test/unit/curation-precision.test.ts` falla si:

1. un detector etiquetado no tiene umbral, o lo tiene por debajo de 0,90 (línea 65: el cierre 20/20 lo exige);
2. un E11 que emite sobre la foto real no tiene corpus con positivos reales;
3. **se pierde un verdadero positivo** o se va a otro subgrupo del esperado — subir la precisión escondiendo
   problemas reales no cuenta;
4. vuelve un falso positivo ya corregido (`fixedIn`);
5. la precisión de cualquier detector baja de su umbral.

Los falsos positivos concretos que nombra §1.3-A6 están en el corpus y marcados como corregidos:
«Dan Warner» (`persona_es_organizacion`, `fixedIn: curation-rules.v2`), «Intro» y «Presentación»
(`duracion_atipica`), «vol»/«rock» en `tipo_de_disco_contra_titulo` (618 → **523** sobre la misma foto),
camelCase estilizado degradado a subgrupo propio. Versión de reglas vigente: `curation-rules.v6`.

### 2.6 · A1 — cobertura de acciones, medida sobre la foto real

`npm run curation:coverage` (añadido por esta auditoría, `scripts/curation-coverage.ts`) analiza la foto
congelada y aplica la **misma regla que `/curation/summary`**: nivel del hallazgo = el mínimo de las acciones
que se le ofrecen; los detectores informativos quedan fuera del denominador.

```
Hallazgos: 7.084 (accionables 5.414 · informativos 1.670)
                            total     ≤ nivel 1      ≤ nivel 2   sin acción
TOTAL ACCIONABLE            5.414   4.564 (84,3 %)  4.691 (86,6 %)    723
```

| Criterio §4 | Exige | Medido | |
|---|---:|---:|---|
| Abiertos con acción de nivel ≤1 | ≥30 % | **84,3 %** | cumple con 2,8× de margen |
| Abiertos con acción de nivel ≤2 | ≥70 % | **86,6 %** | cumple |

Por categoría: fichas sin vínculos 100 %, ficha de otro tipo 98,9 %, nombres sucios 91,9 %, mal segmentados
90,8 %, datos incoherentes 72,9 %, fichas repetidas 63,5 %, «Otros» 0 % (por diseño: son anomalías sin regla,
nivel 3). Los 1.670 informativos (`disco_sin_pistas`) siguen visibles en el panorama, contados aparte en
`totals.openInformational`: es catálogo por completar, no un defecto con corrección.

### 2.7 · A8 y M6 — todo lote es un lote

`ingest.curation_fix_batches` + `curation_fix_items` (`0021`) cubren los cuatro modos (`individual`,
`selected`, `group`, `auto`) más `undo`. Cada ítem guarda acción, parámetros, vista previa con su hash,
estado, run, `before`/`after` y el motivo de lo que no se aplicó. Deshacer usa **CAS inverso**: solo restaura
si el valor actual sigue siendo el que dejó la corrección; si no, el ítem queda `not_undoable` con motivo.
Las colisiones se miran antes de renombrar: si el nombre limpio de un artista ya existe (`artists.name` es
`UNIQUE`), la vista previa **propone fusionar** en vez de renombrar (M6).

**Pruebas:** `curation-fixes.test.ts:116` («vista previa → aplicar → deshacer deja la instantánea idéntica,
con claims, conflicto, revisión y alias»), `:395` (colisión → fusión, aplicada y deshecha), `:489` (deshacer
no pisa un cambio posterior), `:360` (tope por llamada y continuación); `curation-autofix.test.ts:151,196`
(lote automático reversible e interruptor de emergencia).

### 2.8 · A9 — rendimiento

Medido con **el doble del catálogo real** (117.946 filas: 3.964 artistas, 20.496 personas, 9.388 discos,
53.720 pistas) contra PostgreSQL desechable, con la máquina en reposo:

| Escenario | Medido | Criterio |
|---|---:|---:|
| Verificación dirigida (la de una corrección) | **135 ms** | <1 s |
| Análisis completo de régimen | **4.746 ms** | <5 s |
| Análisis completo en frío (primera vez) | 7.746 ms | — (no es el caso de A9) |

Desglose del de régimen: foto 451 ms · vocabulario 717 ms · detectores 2.727 ms · guardar 823 ms.

> **Sin holgura.** El margen es del 5 %. Durante esta auditoría, la misma prueba corrida con la máquina
> ocupada dio **5.057 ms y falló**; repetida con la máquina en reposo, 4.746 ms y 4.765 ms en dos corridas
> independientes. El criterio se cumple, pero no sobra: cualquier detector nuevo pesado, o un tercer aumento
> del catálogo, lo rompe. Si vuelve a fallar en CI, lo primero que hay que mirar son los 2.727 ms de
> detectores, no el umbral.

### 2.9 · M1 y M2 — el porqué de cada cierre

`resolution` (`0019`/`0020`) toma uno de cinco valores: `fixed_by_curation`, `changed_elsewhere`,
`entity_removed`, `rules_changed`, `declared_distinct`, con `resolved_by_run_id` cuando se sabe qué run lo
resolvió. Un CHECK impide que un hallazgo abierto lleve motivo. `classifyResolution`
(`src/curation/resolution.ts:97-114`) decide con el lote aplicado, el estado de la ficha y la versión de
reglas. Lo encadenado (`evidence.triggeredBy`) se puede **dar por revisado** sin cerrarlo: la marca se mueve a
`evidence.triggeredHistory`, no se pierde quién lo desencadenó.

**Pruebas:** `curation-scan.test.ts:145` («una corrección desde Curaduría queda resuelta como tal, con su run
y quién la firmó»), `:161` (ficha retirada → `entity_removed`); `curation-triage.test.ts:71,110`.

### 2.10 · M7 — conflictos y cola se deciden en la tarjeta

La tarjeta ofrece **«Resolver»** (elegir A, B u otro valor con la evidencia de cada fuente: fuente,
`trust_level`, fecha) y **«Decidir»** (aceptar/rechazar/resolver la revisión sin salir de la lista)
— `web/src/pages/CurationFindingsPage.tsx:939-950`. Hay acción de grupo «aplicar la fuente de mayor
confianza» que **deja los empates sin tocar**, y la pestaña de posibles duplicados muestra su contador.

**Pruebas:** `curation-conflicts.test.ts` (6 casos, incluidos «elegir un lado cierra el conflicto sin afirmar
un valor nuevo» y «resuelve donde hay diferencia, deja los empates sin tocar»).

### 2.11 · M10 — QA visual y teclado

38 capturas reales en `docs/ui-qa/curaduria/` (19 escritorio a 1280 px + 19 móvil a 400 px), generadas por
`npm run test:visual-curation` contra un contenedor propio, nunca contra la base de desarrollo. El harness no
solo captura: falla si hay overflow horizontal, si la consola registra errores, si «No es un problema» no
exige motivo, si «Son distintas» no guarda el par, si el botón principal no lleva el nombre de la acción
recomendada o si los atajos no mueven el foco. En CI bloquea el PR. Triaje con teclado (`j/k`, `x`, `c`, `i`,
`o`, `?`) con chuleta en la propia pantalla.

La matriz de capturas **no estaba documentada**: esta auditoría la añadió a `docs/UI_QA.md` (§«QA visual de
Curaduría»).

### 2.12 · Verde de la suite

Ejecutado en esta auditoría sobre el árbol final:

| Comando | Resultado |
|---|---|
| `npm run typecheck` | **PASS** |
| `npm run lint` | **PASS** |
| `npm test` (unitarias + contratos) | **PASS** — 86 archivos y 644 pruebas en verde, 1 archivo / 1 prueba omitida (la integración DeepSeek, opt-in) |
| `test/contract/core-and-schema.test.ts` | **PASS** — 7 pruebas: el core sigue intacto |
| Solo Curaduría | 13 archivos unitarios (132 pruebas) + 9 de contrato (55 pruebas), todos en verde |

Las migraciones `0017`–`0024` solo crean objetos en `ingest`; ninguna toca `public`.

### 2.13 · Documentación

`docs/ARCHITECTURE.md` (acciones, registro, incremental, autocorrección), `docs/OPERATIONS.md` §«Detector de
conflictos» y §«Corregir desde Curaduría» (runbook triaje → vista previa → aplicar → verificar → deshacer,
autocorrección y poda), `docs/CURATION_OPERATIONS.md` (E11/E12), `docs/curation/BASELINE_2026-09-16.md` y
`E2_PRECISION_2026-09-16.md`.

Tres huecos que exigía E12.3 y no existían, **cerrados por esta auditoría**:

1. `docs/DATA_MODEL.md` §4.17 — las siete tablas de Curaduría no estaban en el modelo de datos.
2. `docs/PHASES.md` — no había fase de Curaduría con estado por etapa (ahora C-E0 … C-E12, con la nota de que
   su numeración es distinta de la `E6`–`E11` del plan original).
3. `docs/UI_QA.md` — la matriz de QA visual de Curaduría (§2.11).

---

## 3. Lo que encontró esta auditoría

### 3.1 Defecto corregido — el escaneo seco daba un KPI distinto del panorama

**Qué pasaba.** `recommendedActionLevels` (`scan.ts`) construía el hallazgo para contar acciones con
`evidence: finding.evidence`, pero el par de un hallazgo de duplicados viaja **fuera** de `evidence` en el
analizador y **dentro** al persistir (`scan.ts:272`). La acción `fusionar` lee `evidence.pair`
(`actions/merge.ts:40-49`), así que al contar no encontraba ninguna.

**Consecuencia medida sobre la foto real:** de los **108 hallazgos de par**, `/curation/summary` y la interfaz
ofrecían fusión de nivel 1 en los 108, mientras `crv curation scan --dry-run` y los contadores del análisis
los reportaban como «sin acción». Dos cifras del mismo KPI de cobertura del cierre: 82,9 %/84,7 % frente a
84,3 %/86,6 %.

**Corrección.** `actionFinding` compone la evidencia igual que `persist`. Regresión añadida en
`test/unit/curation-actions.test.ts` («un hallazgo de par cuenta su fusión, no "sin acción"»), verificada
fallando antes del arreglo (`expected { level1: 0 } to deeply equal { level1: 1 }`) y en verde después.

Ningún cierre anterior lo detectó porque el KPI se venía leyendo de `/curation/summary`, que sí estaba bien.

### 3.2 Desviación documentada — cinco detectores E11 sin acción declarada

E11 del plan pide que cada detector nuevo entre «con casos reales, subgrupos, **acciones (aunque sean nivel
3)** y entrada en el corpus», y asigna nivel a cada uno. Cinco de los que emiten sobre datos reales **no
declaran ninguna acción** en `detectors/advanced.ts`:

| Detector | Hallazgos en la foto | Acción que pide el plan |
|---|---:|---|
| `alias_que_choca_con_otra_ficha` | 62 | N2 |
| `creditos_duplicados` | 57 | N1 — retirar el duplicado |
| `pistas_sin_duracion_en_disco_con_duraciones` | 56 | N3 |
| `organizacion_sin_clasificar` | 21 | N1 — fijar el tipo |
| `rol_contra_tipo_de_credito` | 1 | N1 — fijar `credit_type` |
| **Total** | **197** de 5.414 accionables (3,6 %) | |

Y dos que hoy emiten 0 y también tendrían acción de nivel 0 según el plan: `redireccion_en_cadena` (aplanar)
y `enlace_de_medio_a_ficha_fusionada` (repuntar).

**Por qué no bloquea el cierre.** §4 no exige una acción por detector: exige ≥70 % de los abiertos con acción
≤N2, y se cumple con 86,6 % incluso contando estos 197 como sin acción. Son trabajo pendiente si se quiere
corregirlos desde la propia tarjeta, no un criterio incumplido. **Recomendación:** empezar por
`creditos_duplicados` (57 casos, filas idénticas ya comprobadas en la base, y `deleteRelation` ya existe) y
`organizacion_sin_clasificar` (21 casos, `updateEntity(organization_type)`); las dos son N1 sobre piezas que
el motor ya tiene.

**Después de la auditoría (2026-09-20).** Las cifras de arriba son las del cierre y se dejan como estaban; lo
que cambió desde entonces:

- `organizacion_sin_clasificar` **cerrado**: `fijar_tipo_de_organizacion` (`structural.ts` §1.8, nivel 1,
  inversa `field_restore`) cubre sus 21 hallazgos. La cobertura pasa de 84,3 %/86,6 % a **84,7 %/87,0 %** y la
  desviación baja de 197 a **176**. La acción no reinfiere el tipo —lee el `suggestedType` que el detector ya
  decidió— y se bloquea con `stale` si la ficha fue clasificada entretanto.
- La recomendación de empezar por `creditos_duplicados` **era optimista**: `deleteRelation` existe y guarda el
  snapshot, pero no hay inversa para una relación *retirada* (`relation_delete` deshace una creación y
  `entity_restore` pasa por `ENTITY_SPECS`, que no acepta tipos de relación). Necesita un `undoRelationRemoval`
  nuevo antes que la acción.
- Dos de los cuatro restantes no son deuda de implementación sino del plan: `pistas_sin_duracion…` (56) pide un
  N3 y **no existe ninguna acción de nivel 3 en el marco** —toda acción escribe—, y de los 62 choques de alias
  **56 son de pista o de disco**, que `mergeAction` no admite (solo `person`/`organization`/`artist`).
- El KPI **ya no depende de que alguien se acuerde de correr el script**: `test/unit/curation-coverage.test.ts`
  exige en CI los mínimos de §4 sobre la misma foto, un piso de regresión y que todo detector que declara una
  acción la ofrezca en algún hallazgo real —la forma general del defecto §3.1—. La regla del nivel, que estaba
  escrita tres veces, vive ahora en `src/curation/coverage.ts` y la usan el script, `/curation/summary` y la
  prueba. Verificado por mutación: al hacer que la acción deje de aplicar, fallan dos de las cinco pruebas.

---

## 4. Límites de esta auditoría

1. **Valida el repositorio y PostgreSQL desechable**, no una base desplegada. Las cifras de cobertura y
   precisión salen de la foto congelada del 16/09 (fichas) y del 20/09 (relaciones); si el catálogo se mueve
   mucho, hay que volver a tomarla entera y reetiquetar.
2. **El rendimiento se midió en esta máquina**, con el doble del catálogo real y sin carga. Bajo carga la
   prueba falla (§2.8); el criterio no tiene holgura.
3. **Cuatro detectores relacionales** (`periodo_de_membresia_imposible`, `sello_que_es_artista`,
   `redireccion_en_cadena`, `enlace_de_medio_a_ficha_fusionada`) emiten **0** sobre la foto real: su precisión
   sobre datos reales sigue sin medirse. Están cubiertos por pruebas sintéticas y la guardia del corpus los
   exigirá en cuanto empiecen a emitir.
4. **Las etiquetas del corpus las puso quien implementó las reglas**, no el propietario del catálogo. Conviene
   repasar a ojo las de `organizacion_sin_clasificar` y `alias_que_choca_con_otra_ficha` antes de apoyarse en
   esos umbrales para reglas futuras.
5. **La autocorrección sigue apagada** (`CRV_CURATION_AUTOFIX=false`) y con la lista blanca vacía: su
   comportamiento está probado en contrato, no en uso real.
6. El plan pedía esta revisión con un modelo distinto del que implementó (§7). No fue el caso; ver el aviso
   de la cabecera.

---

## 5. Cierre

Con los 13 puntos de §4 verificados, el defecto de §3.1 corregido con su regresión, y la documentación que
E12.3 exigía completa, **el plan `PLAN_CURADURIA_20_DE_20.md` queda cerrado**. Lo que sigue abierto está
escrito, medido y priorizado en §3.2 y §4: no son deudas ocultas, son la lista de lo próximo.
