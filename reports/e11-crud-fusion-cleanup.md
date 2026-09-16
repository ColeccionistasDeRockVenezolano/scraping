# E11.2–E11.10 — CRUD y fusión de fichas: cierre con evidencia

Plan: `~/Desktop/PLAN_MEJORA_CRUD_Y_FUSION_DE_PERSONAS.md`.
Fecha: 2026-09-16. Árbol de trabajo: `/home/brian/apps/Coleccionistas De Rock Venezolano`.

## 1. Archivos

Nuevos (código):

| archivo | etapa |
| --- | --- |
| `migrations/0014_entity_redirects.up/down.sql` | E11.2 |
| `migrations/0015_review_kind_person_duplicate.up/down.sql` | E11.5 |
| `migrations/0016_person_duplicate_pair_uk.up/down.sql` | E11.5 |
| `src/merge/redirects.ts` (`resolveRedirect`) | E11.2 |
| `src/api/repositories/redirects.ts` (404 `movedTo`) | E11.2 |
| `src/merge/entity-merge.ts` (servicio de fusión con previsualización) | E11.3 → E11.10 |
| `src/api/routes/entity-merge.ts` (rutas de fusión de las tres entidades + convert) | E11.4 → E11.10 |
| `src/review/person-names.ts` (apodos, apellido, palabras y clave de organización) | E11.3/E11.10 |
| `src/review/person-candidates.ts` (detector de personas) | E11.5 |
| `src/api/routes/person-candidates.ts` + `src/api/repositories/persons.ts` (listado) | E11.5 |
| `src/review/person-junk.ts` (`classifyPersonName`) | E11.7 |
| `src/merge/unmerge.ts` + `src/api/routes/merge-runs.ts` | E11.8 |
| `src/api/search-index.ts` (índice sin tildes + `warmSearchIndex`) | E11.9 |
| `src/review/organization-candidates.ts` | E11.10 |
| `web/src/components/MergeEntityModal.tsx`, `ConvertPersonModal.tsx`, `web/src/pages/PersonDuplicatesPage.tsx` | E11.6/E11.7 |
| `web/tests/visual/merge-qa.ts` | E11.6 |

Modificados principales: `src/review/duplicates.ts` (organización en el motor, P13, redirecciones, `MERGE_EMPTY_VALUES`), `src/api/repositories/persons.ts` (filtros, contadores, clasificación), `src/api/routes/persons.ts`, `src/api/routes/catalog-writes.ts`, `src/merge/operator.ts`, `src/review/person-corrections.ts` (convert/split), `src/cli/index.ts` (dos detectores), `web/src/lib/{api,types,labels}.ts`, `web/src/pages/*`, `web/tests/visual/capture.mjs`, docs y migraciones/README.

## 2. Suites (salidas reales)

| comando | resultado |
| --- | --- |
| `npm run typecheck` | sin errores |
| `npm run lint` | sin errores |
| `npm run test:unit` | **29 archivos / 245 tests en verde** |
| `npm --prefix web run build` | `✓ built` |
| `npm run test:contract` | **28 archivos / 175 tests en verde** (980 s) |
| `npm run test:visual-merge` | en verde: duplicados, modal (foco atrapado, Esc), aviso de enlace fusionado, «Fusionar con…», aviso de conversión + 2 capturas por viewport a 1280 y 400 px |

## 3. Checklist del plan (P1–P13) con evidencia

- [x] **P1** Fusionar un par careado ya no falla — `merge-into-hardening.test.ts` (10/10).
- [x] **P3** Ningún camino de fusión borra claims — `grep -rn "DELETE FROM ingest.claims" src/` → 0.
- [x] **P4** `grep "slice(0, 50)"` vacío → 0 (evidencia completa desde E11.2).
- [x] **P5** Los ids fusionados redirigen — `api-read` (404 con `details.movedTo`) y `merge-into-hardening` (cadena A←B, C←A ⇒ B→C).
- [x] **P6** Una fusión se deshace con igualdad de instantáneas — `unmerge-roundtrip.test.ts` (personas, alias, créditos, membresías, claims, revisiones y redirecciones vuelven al estado previo; las correcciones de campo se informan, no se revierten).
- [x] **P7** Membresías unificadas — `merge-into-hardening` (compatibles se unen; contradictorias abren revisión).
- [x] **P8** Fusión típica < 1 s — sonda en contenedor: **112 ms** moviendo 80 filas (60 créditos + 20 membresías).
- [x] **P9** `is_venezuelan` se conserva — `merge-into-hardening`.
- [x] **P10** Detector ≥ 100 pares sin estudios — **173 pares** de 10 248 personas (471 comparados), 0 estudios, 1,76 s → `reports/person-candidates-dryrun.md`.
- [x] **P11** Clasificador y conversión operativos — `test/unit/person-junk.test.ts` (4) + `person-junk-convert.test.ts` (convert a organización existente y nueva, dividir reutilizando una existente) + `reports/person-junk-dryrun.md` (488 organization_like vs 477 del plan, 22 duration exactos, 13 fragment, 97 multiple_people).
- [x] **P12** La búsqueda ignora tildes — `api-persons-filters.test.ts` (`q=jose` encuentra «José», ordena primero los que empiezan, filtros y contadores) + `reports/persons-search-probe.md` (**26 ms**, criterio < 300 ms).
- [x] **P13** La ficha que queda es la más rica — `review-duplicates.test.ts` (el disco con más pistas sobrevive) y `api-entity-merge.test.ts` (el artista con más discos sobrevive, no el de id menor).
- [x] `public` sin cambios de esquema — `core-and-schema.test.ts` (0001–0016 aplican y revierten; la tabla nueva vive en `ingest`).

Etapas: E11.2 redirecciones · E11.3 servicio · E11.4 API · E11.5 detector + 0015/0016 · E11.6 web + QA · E11.7 basura (clasificador, convert, split) · E11.8 deshacer · E11.9 búsqueda y filtros · E11.10 organizaciones/artistas, P13, detector de organizaciones y documentación.

## 4. Discrepancias entre el plan y el código (y cómo se resolvieron)

1. **`split` con `allowSimilar: false` no podía crear los destinos**: los nombres nuevos siempre se parecen a la ficha combinada que aún existe, así que el ER respondía `needs_review` y el plan abortaba (justo el caso de uso del paso). Se reintenta con `allowSimilar: true` —el plan `into` *es* la decisión humana de que son personas distintas— y el reintento queda registrado; cualquier otro error sigue abortando.
2. **La previsualización y el motor debían vaciar lo mismo**: el motor define «vacío» con reglas SQL (`album_type='other'`, `is_venezuelan=false`). Se exporta `MERGE_EMPTY_VALUES` junto a ellas para que la previsualización no prometa completar un campo que el motor considera lleno (ni al revés).
3. **La lectura tiene que tolerar una base sin migrar**: el detector compara `kind::text` (no el literal del enum nuevo) para poder correr en solo lectura contra la base de desarrollo sin 0015; el INSERT sí exige el valor.
4. **`capture.mjs` estaba atado a la base de desarrollo** (rutas por id y `networkidle` sin tope). Se le añadieron `CRV_CAPTURE_ROUTES`, `CRV_CAPTURE_EDIT_ROUTE` y `CRV_CAPTURE_VIEWPORTS` (por defecto, comportamiento idéntico) y una navegación con tope y diagnóstico; así el mismo capturador sirve contra un contenedor de prueba a 1280 y 400 px, como pide E11.6.
5. **`sincopa-organizations.ts` (paso previo de E11.7)** no se duplica: aquél *retira* organizaciones falsas por re-extracción del crudo; el nuevo trabajo *convierte* fichas-basura por decisión humana. Comparten `removeEntity`, el run `merge_run` y la transacción única.
6. **`person-merge.ts` se generalizó a `entity-merge.ts`** (E11.10): el archivo y los nombres del plan se mantienen donde el plan los fija (rutas, `previewHash`, `fieldChoices`), pero el servicio y los campos comparables salen de `ENTITY_SPECS`, así que las tres entidades usan el mismo camino.
7. **La base de desarrollo no tiene 0014–0016**: `mergeInto` escribe redirecciones, así que la sonda de fusión contra `127.0.0.1:5433` falla hasta que se apliquen las migraciones. No se aplicaron (regla 0.1.6); la medición de P8 se hizo en contenedor desechable. **Antes del próximo `crv review duplicates` sobre la base real hay que migrarla** (`npm run db:migrate`). _(Actualizado 2026-09-16: aplicadas — ver §7.)_

## 5. Defectos encontrados al verificar (y su arreglo)

Los encontró la propia verificación, no una lectura:

1. **Buscador de discos y pistas sin comodines** (`src/api/repositories/search.ts`): al pasar la consulta
   cruda al índice, las consultas `ILIKE` de discos y pistas perdieron el `%…%` (`q=Paticas` dejaba de
   encontrar «Las Paticas De La Abuela»). Ahora cada searcher arma su patrón.
2. **Doble aviso de enlace fusionado** en modo desarrollo (StrictMode ejecuta el efecto dos veces): el hook
   `useMovedTo` guarda el error ya atendido y avisa una sola vez.
3. **QA visual frágil**: `vite` huérfano de una corrida fallida se reutilizaba (la página hablaba con una API
   muerta y mostraba «No se pudo cargar») y `networkidle` sin tope colgaba con la máquina ocupada. El QA ahora
   usa puerto libre, mata el grupo de procesos, espera a que la SPA pinte y, si algo falla, dice qué muestra la
   página.
4. **La tabla del modal listaba campos de las tres entidades**: al generalizar el modal, una persona
   mostraba «Web», «Ciudad» o «País» (de organización y artista). Lo encontró la inspección de las capturas
   del QA, no un test; ahora las filas salen de los campos que trae la previsualización (los de esa entidad) y
   el QA visual falla si vuelve a colarse un campo ajeno.
5. **Textos con plural falso**: «1 revisiones», «1 referencias movidas», «1 créditos unificados» (modal,
   toast y salida del CLI de los detectores). Ahora hay un `plural()` en el modal y las dos líneas del CLI
   eligen singular o plural.
6. **Capturas a medio cargar**: la herramienta de capturas fotografiaba antes de que la página terminara de
   cargar (una ficha salió con «Cargando…»). Ahora espera a que desaparezca ese estado, y el QA de fusión
   comprueba además que la ficha de un nombre sospechoso muestra el aviso y los dos botones de conversión
   (E11.7), no solo que se pueda fotografiar.
7. **Precisión de `created_at` al deshacer**: el `old_value` de la auditoría se serializa desde un objeto JS,
   donde `pg` ya convirtió `timestamptz` a `Date`; al reinsertar, el sello vuelve con precisión de
   milisegundos. El contenido y la identidad de la fila se restauran enteros; es un límite conocido del ida y
   vuelta por JSON (documentado en el test de ida y vuelta).

## 6. Estado y siguiente paso

_(Histórico: escrito al cerrar la implementación, antes de la aprobación.)_

Sin commits: todo está en el árbol de trabajo a la espera de tu revisión (`git status` lista las migraciones
0014–0016, los módulos nuevos, los tests y los docs).

Antes del próximo run de fusión sobre la base real: **aplicar las migraciones 0014–0016** (`npm run db:migrate`).
Sin ellas `mergeInto` no puede escribir la redirección y el motor rechaza la fusión (a propósito: no hay
camino alternativo silencioso).

## 7. Cierre de puesta en marcha (2026-09-16)

Aprobada la implementación, se cerró todo lo que quedaba:

- **Commits**: el árbol quedó limpio en 18 commits locales (sin empujar) — la fase E11 de endurecimiento
  (ESLint real, escenarios, respaldos, 0013, auth de colaboradores, publicación bajo `/crv`), la nota de
  cierre del baseline (E11.0) y el plan por etapa: `(E11.2)` redirecciones → `(E11.3)` servicio →
  `(E11.4)` API → `(E11.5)` detector → `(E11.6)` web → `(E11.7)` conversión/división → `(E11.8)` deshacer →
  `(E11.9)` búsqueda y filtros → `(E11.10)` organizaciones, P13 y documentación. Nada quedó sin commitear.
- **Migraciones aplicadas** en la base de desarrollo: `0014_entity_redirects`,
  `0015_review_kind_person_duplicate` y `0016_person_duplicate_pair_uk` (`npm run db:migrate`, <2 s; el
  índice único real es `review_queue_person_duplicate_live_uk`).
- **Sonda de fusión** contra la base real: en frío 18,1 s (primer toque de la tabla de 19 GB de decisiones
  de ER); en caliente **746 ms → OK** (límite P8 de 2 s). El par 14←3617 se fusiona y se revierte entero.
- **Cola poblada**: `crv review person-candidates --confirm` → run 249: **173 revisiones `person_duplicate`
  abiertas, 0 preexistentes**; visibles en `/personas/duplicados` para que decidas.
- **Respaldo**: se guardó el respaldo dirigido `crv-20260916-cierre.dump` (todo menos
  `ingest.entity_resolution_decisions`, 19 GB — no la tocan estas migraciones; SHA-256 registrado junto al
  archivo); los respaldos viven desde ese día en `/mnt/datos/backups/crv/` (mudanza de 14,7 GB con
  verificación sha256 completa). El respaldo completo (`npm run db:backup`, ~6,8 GB) queda recomendado para la próxima ventana:
  tarda horas y la base no había cambiado desde sus respaldos del 2026-09-15; la migración fue DDL aditivo
  y reversible con sus `.down`.
- Suites sobre el árbol final: typecheck ✓, lint ✓, unit 245 ✓, contratos E11 27/27 ✓, prueba visual de
  fusión ✓.

### Correcciones del scoring 1–20

- E11.0: la corrida de `review-duplicates`/`person-corrections`/`api-write` quedó registrada en
  `reports/e11-baseline.md` (2/2, 4/4, 9/9).
- E11.7: `splitPerson` consolida los créditos equivalentes de **todos** los destinos (antes solo del
  primero); cubierto por test.
- E11.10: añadido el test de `albums.label_id` («dos sellos → los discos pasan al que queda»).
