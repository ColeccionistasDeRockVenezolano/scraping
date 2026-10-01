# Revisión de ingesta — cotejo de los avisos `low_confidence` y `genre_unknown`

Fecha: 2026-09-23 · operador de los lotes: `Hermes` · respaldo: `/mnt/datos/backups/crv/crv-20260923T230235Z` (sumas 4/4 verificadas; prueba de restauración en curso).

## 1. Cifras antes / después

### Personas (`person.name`)

| | antes | después |
|---|---|---|
| avisos abiertos | 976 | 236 |
| enlazados en esta sesión (nombre exacto + mismo disco + misma función) | 0 | 726 |
| fichas creadas (nombres completos con crédito real, aprobado 2026-09-23) | 0 | 12 |
| personas del catálogo | 11179 | 11191 |

De los 236 pendientes: 77 de una sola palabra, 26 con iniciales o abreviatura, 64 con un casi-homónimo por acento/puntuación (p. ej. «Henry Martinez» vs «Henry Martínez»), 39 con homónimo exacto sin crédito en ese disco, 19 versiones corta/larga de una ficha existente (apodo), 6 nombres de artista/banda y 5 con artefactos en el texto. Ninguno se forzó.

### Organizaciones

| | antes | después |
|---|---|---|
| avisos abiertos (name/type/country) | 87/87/71 | 80/80/69 |
| nombres enlazados a organización existente | 0 | 7 |
| tipos resueltos según la política del propietario | 0 | 7 (2 pasan a `recording_studio` por el texto —CD Box «recorded at», Producciones de La Montaña «mixed at»— y 5 conservan `record_label`) |

Los conflictos de tipo que creó el propio cotejo (7) se resolvieron por la vía auditada (`resolveOpenConflict`, runs 3826–3832), no quedó ninguno abierto. El país se adjuntó como lugar literal donde el core ya decía lo mismo (2 casos, no-op); los 69 avisos restantes de país pertenecen a organizaciones que no están en el catálogo y siguen abiertos.

### Géneros (`genre_unknown`, fase separada)

| clase | casos |
|---|---|
| termino_nuevo (pieza sin equivalente en la taxonomía) | 284 |
| revision (texto vacío/ilegible (discrepancias entre fuentes)) | 4 |
| aplicable (todo el texto cubierto por términos vigentes) | 4 |
| no_genero (la pieza no es un género) | 2 |
| **abiertos tras la fase** | 290 |

## 2. Qué se aplicó, con trazabilidad

- Enlaces de persona aplicados: **726** — cada uno con su run propio (`merge_run`/`manual`), nota firmada `[Hermes] …` en la revisión y fila de `merge_audit`.
- Enlaces de organización aplicados: **7** (solo el nombre; tipo y país quedan pendientes).
- Descartes de persona: **0** (el clasificador no halló falsos candidatos demostrables).

Ejemplos verificables:

- review 193809 · claim 512455 · «Angelo Sebastiano» → persona 12886 · Aire y Mar · «lyrics written»
- review 193840 · claim 512486 · «Mariela Romero» → persona 12887 · Aire y Mar · «lyrics written»
- review 193888 · claim 512534 · «Jorge Troconis» → persona 12888 · Aire y Mar · «graphic design»
- review 193911 · claim 512557 · «A. Londoño» → persona 12577 · Cultura 3 · «lyrics written»
- review 193944 · claim 512590 · «Antonio J. Guzman» → persona 12578 · Cultura 3 · «band pictures»
- review 194505 · claim 513151 · «ProgRock Records» → organización 538 · Future Awaits · «executive producer»
- review 194597 · claim 513243 · «Ojo Rabioso Records» → organización 597 · B-Sides: A.T.C. · «executive production»

### Bloqueados / no aplicados por el aplicador

- 31 · «sin careo fresco con el destino; queda abierto» (el ER vigente no propone la persona esperada; NO se forzó el enlace). Detalle por review en `reports/ingesta-review-2026-09-23/trazabilidad-aplicado.jsonl`.
- 2 · revisiones ya cerradas entre el plan y la ejecución (carrera con otras sesiones): no se reprocesan.
- 7 · el primer intento del lote de organizaciones no cerró los avisos por un fallo de verificación del propio aplicador (miraba `person_id`); corregido y reaplicado con éxito (7/7).

## 3. Patrones detectados

1. **El crédito ya está en el core; el claim quedó huérfano.** En los casos enlazados, una corrida de operador anterior (runs 326/327, 2026-09-22) ya creó la persona y su crédito desde el mismo video; el claim `person.name` seguía candidato. El cotejo correcto era comparar disco + función + estado del crédito, no el nombre solo.
2. **Careos obsoletos.** 1.050 de los careos `person_match` guardados apuntan a un candidato que dejó de ser el mejor cuando el catálogo creció; aceptarlos tal cual habría enlazado al homónimo equivocado. Se reejecutó el ER antes de aceptar.
3. **El texto de la fuente no sostiene el tipo de organización.** `organization_type` lo deriva el adaptador («by» ⇒ recording_studio aunque la entidad sea un sello): por eso queda pendiente.
4. **«País» es un lugar.** Los claims de país traen «Caracas, Venezuela»; convertirlo a país exige la vía de corrección, no inferencia.
5. **Géneros**: el texto real es una lista de la fuente; el 96 % de los casos (284/294) pide vocabulario nuevo o una regla de lectura («Black/Hard/Heavy/Death…» con sufijo compartido, textos truncados con «…»), no un género inventado.

## 4. Pendientes priorizados

Ver `reports/ingesta-review-anexo-pendientes.md` (listas completas).
1. **Personas sin homónimo exacto (186)** — decidir si se crean fichas (nombre completo, crédito real) o esperan evidencia.
2. **Personas con homónimo exacto pero sin crédito en ese disco (31)** — identidad no corroborada por contexto.
3. **Personas con careo no refrescable (31)** — el ER vigente no propone el destino esperado; quedan abiertas con el motivo registrado.
4. **Organizaciones sin homónimo exacto (80 de 89 identidades)** — no se fusionan por parecido; la mayoría son estudios/venues no catalogados.
5. **Tipo y país de las organizaciones (87 + 69 avisos)** — el texto de la fuente no sostiene el tipo derivado; el país viene como lugar.
6. **Géneros (284)** — términos nuevos propuestos (Fusion, Alternative, Female Metal, Shoegaze, New Age, Industrial Death Metal, etc.) y lecturas de listas truncadas. Cifras de esta fase aparte: 4 aplicados, 290 abiertos.

Total de avisos `low_confidence` abiertos al cierre: **484** (248 persona + 236 organización) partiendo de 1.221.

## 5. Pruebas y verificaciones

- `npm run doctor`: verde antes y después del trabajo (migraciones 0001–0031, huella del core exacta).
- Respaldo `crv-20260923T230235Z`: `SHA256SUMS` 4/4; contenidos: 65 tablas / 2.443.518 filas; `raw_missing=0`.
- Prueba de restauración (`db:restore-check`): **RESTORE VERIFICADO** — 1.830 `raw_pages` revisadas (0 sin archivo, 0 con hash distinto), filas por tabla idénticas, `doctor` en verde contra la copia restaurada (log `logs/restore-check-20260923.log`). El respaldo es de ANTES de los lotes: es el punto de vuelta atrás de esta sesión.
- Verificación del lote (por SQL): 733 claims aplicados — 726 `person.name` con `person_id` == destino y 7 `organization.name` con `organization_id` == destino; 0 destinos incorrectos.
- El lote NO crea créditos: solo adjunta el claim de nombre. Los grupos de crédito duplicado que muestra el core son anteriores (el detector `creditos_duplicados` de Curaduría los reporta desde E11); ninguno se originó en esta sesión.
- El enlace usa el aplicador auditado del proyecto (`acceptReview` → mesaVerdict → `applyReviewDecisions`, con `review_decision` firmada y run propio); el cierre del aviso usa `resolveReview` —la misma función que `operator-review` emplea para avisos sin efecto en el core— con nota firmada y fila de diario. Esa fila de diario no queda ligada a un run (igual que en las acciones existentes de ese módulo).
- Careos abiertos tras el lote: `person_match` 1.984 → 2.011 y `organization_match` 486 → 475 (≈27 careos nuevos, duplicados inofensivos de claims ya resueltos; el grueso de los 2.011 preexistía).
- Filas de auditoría humana en `merge_audit` (24 h): 3.743 (incluye el trabajo de las otras sesiones del repo).
- Cierre de sesión: **465** avisos `low_confidence` abiertos (236 persona + 229 organización) partiendo de 1.221; **290** `genre_unknown` abiertos partiendo de 294; `doctor` TODO VERDE; 756 revisiones cerradas con nota firmada `[Hermes]`; `field_conflict` abiertos = 2 (los mismos que al empezar: los 7 que creó el cotejo quedaron resueltos).

## 6. Preguntas para el usuario (por decisión editorial)

1. **Personas sin homónimo exacto:** ¿creo fichas para los nombres completos con crédito real (p. ej. los de Sincopa/Hippito con el mismo nombre y función), o quedan pendientes? (La ausencia en Sincopa no es prueba para rechazar.)
2. **Tipo de organización:** ¿confirmo `recording_studio` solo cuando el texto lo dice («recorded at…», «recording studios by…») y dejo `other` en el resto?
3. **País de organización:** ¿escribo el lugar tal cual («Caracas, Venezuela») o se deja vacío hasta la corrección con ciudad separada?
4. **Géneros:** ¿apruebo agregar los términos nuevos a la taxonomía (con familia) y una regla de lectura para listas con sufijo compartido («Black/Hard/Heavy… Metal»), o lo dejo a la Mesa de herra?
