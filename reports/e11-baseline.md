# CRV · E11.0 — Línea base antes del endurecimiento de la fusión

- **Fecha:** 2026-09-15 (mediciones de solo lectura sobre la base de desarrollo `127.0.0.1:5433/crv`).
- **Alcance:** constancia del estado antes de tocar nada. Sin cambios en `src/`.
- **Plan de origen:** `~/Desktop/PLAN_MEJORA_CRUD_Y_FUSION_DE_PERSONAS.md` (§1 y E11.0).

## 1. Volumen (consultas ejecutadas hoy)

| Tabla | Filas | Del diagnóstico (§1.1) |
|---|---:|---:|
| `public.artists` | 1.982 | 1.982 |
| `public.persons` | 10.248 | 10.248 |
| `public.organizations` | 687 | 687 |
| `public.albums` | 4.694 | 4.694 |
| `public.tracks` | 26.860 | 26.860 |
| `public.artist_members` | 1.367 | 1.367 |
| `public.person_organizations` | 0 | 0 |
| `public.album_credits` | 17.184 | 17.184 |
| `public.track_credits` | 12.126 | 12.126 |
| `public.album_formats` | 744 | 744 |
| `ingest.claims` | 509.954 | 509.954 |
| `ingest.claims` de persona | 26.894 | 26.894 |
| `ingest.merge_audit` | 118.111 | 118.111 |
| `ingest.review_queue` abiertas | 0 | 0 |
| `ingest.review_queue` con las dos personas | 41 | 41 |
| Fusiones de persona ya hechas (`merged_duplicate`) | 471 | 471 |

Alias: `artist_aliases` 2.234 · `person_aliases` 10.099 · `organization_aliases` 837 · personas sin alias 1.093.

## 2. Calidad de la entidad Persona (consultas ejecutadas hoy)

| Medida | Hoy | §1.2 del plan |
|---|---:|---:|
| Con nacionalidad, biografía, foto o fecha de nacimiento | 0 | 0 |
| `is_venezuelan = true` | 0 | 0 |
| Sin crédito, membresía ni organización | 279 | 279 |
| Con un solo crédito o membresía | 6.042 | 6.042 |
| Nombre de estudio/sello/productora (`estudio|studio|records|producciones|…`) | 495 | 477 |
| Nombre idéntico al de un artista | 286 | 294 |
| Nombre idéntico al de una organización | 134 | 141 |
| Solo números o duración (`9'44`, `4:39`, `(66)`) | 22 | 22 |
| Más de 40 caracteres | 23 | 23 |
| Pares «nombre con apodo entre comillas» = «nombre sin apodo» | 27 | 117 |

Notas de medición:

- Las diferencias en «estudio/sello», «idéntico a artista/organización» y «pares con
  apodo» son de **método**, no de datos: el diagnóstico contó variantes (estudios
  abreviados, comparación sin mayúsculas) que estas consultas no reproducen. La
  cifra de pares con apodo de este informe exige coincidencia exacta del nombre
  restante; el §1.2 del plan usa una comparación más laxa. Ambas se moverán al
  detector de candidatos (E11.5), que es donde importa la definición.
- `length('José') = 5` y `lower('ÁNGEL') = 'Ángel'` siguen vigentes (base `SQL_ASCII`):
  toda comparación sin tildes se hace en TypeScript (regla 0.1.11).

## 3. Suite y tests de contrato antes del cambio

| Comando | Resultado |
|---|---|
| `npm run typecheck` | sin errores |
| `npm run lint` | sin errores |
| `npm run test:unit` | 27 archivos, **234 pruebas en verde** |
| `test/contract/merge-into-hardening.test.ts` | no existía (ningún test cubría P1) |

### Corrida de cierre (2026-09-16)

El paso 3 de esta línea base pedía ejecutar también los suites
`review-duplicates`, `person-corrections` y `api-write`; su resultado no quedó
registrado aquí en su momento. Re-ejecutados sobre el árbol final del plan
(E11 cerrado), en verde:

| Comando | Resultado |
|---|---|
| `vitest run test/contract/review-duplicates.test.ts` | 2/2 |
| `vitest run test/contract/person-corrections.test.ts` | 4/4 |
| `vitest run test/contract/api-write.test.ts` | 9/9 |
| lote de verificación del cierre (5 archivos) | 27/27 |

## 4. Datos que necesitan las etapas siguientes

- `public.persons.id` es `BIGINT GENERATED ALWAYS AS IDENTITY` (`attidentity = 'a'`):
  la reinserción de E11.8 necesita `OVERRIDING SYSTEM VALUE`.
- El runner de migraciones (`src/db/migrate.ts`) envía **cada archivo como una sola
  query** de texto plano: no envuelve los archivos en una transacción propia; cada
  `.up.sql` trae su `BEGIN; … COMMIT;`. E11.5 puede separar el `ALTER TYPE` del
  índice que usa el valor nuevo sin pelear con el harness.
- Índices de FK ya presentes (migración `0013`): `claims.person_id`, `merge_audit.person_id`,
  `review_queue.person_a_id`/`person_b_id`, `entity_resolution_decisions.person_id`,
  `ai_biographies.person_id`, `media.media_links.person_id`, créditos y membresías.

## 5. Fallo reproducido (P1) antes del cambio

- Par `14` («Carlos "Nene" Quintero») ← `3617` («Carlos Quintero») con la revisión
  `192925` (`possible_duplicate`, `dismissed`) careando ambos ids.
- `mergeInto` reapuntaba `review_queue.person_b_id` a `14` con `person_a_id = 14` y
  violaba `review_queue_distinct_persons_chk` (23514); el código solo atrapaba 23505.
- Medición previa del diagnóstico: fallo en 4,9 s. Tras E11.1: ver
  `reports/e11.1-merge-hardening.md`.
