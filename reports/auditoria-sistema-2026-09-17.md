# CRV — Auditoría profunda del sistema completo (2026-09-17)

- **Alcance:** todo el sistema — `src/**` (155 archivos, 31.750 líneas), `web/**` (6.042 líneas TS/TSX), `migrations/**` (21 pares), `scripts/**`, `test/**` (68 archivos), la base viva `crv-postgres` (puerto 5433) y el despliegue publicado bajo Funnel.
- **Método:** lectura del código real + sondas de solo lectura contra la base de desarrollo + mediciones en vivo de la API y del sitio público + suites de verificación corridas en el momento (`typecheck`, `lint`, `test:unit`, 4 contratos). Nada modificado en el sistema auditado.
- **Calificación global: 17/20.** Ingeniería de calidad alta y consistente (gobernanza de escritura única, auditoría completa, pruebas de comportamiento real); los frenos son el estado de enriquecimiento del catálogo, la ausencia de CI, la retención de la tabla ER y el rendimiento de la búsqueda bajo contención de E/S.

---

## 0. Lo que el sistema es, hoy, verificado

| Subsistema | Estado verificado |
|---|---|
| Base viva | 21 migraciones aplicadas (0001–0021); `doctor: TODO VERDE` con huella exacta del core (178 objetos, 7 enums / 10 tablas / 3 vistas) |
| Catálogo (core) | 1.982 artistas · 10.246 personas · 687 organizaciones · 4.694 álbumes · 26.860 pistas · 17.184 créditos de álbum · 12.126 de pista · 15.881 persona↔álbum · 1.367 membresías |
| Ingesta | 510.008 claims (377.395 aceptados, 94.570 rechazados, 38.043 superseded, 0 candidatos colgados); 1.830 páginas crudas; 15 fuentes registradas / 10 habilitadas |
| Cola de revisión | 192.240 filas totales; 175 abiertas (173 `person_duplicate` + 2 `ambiguous_alias`); 0 conflictos abiertos |
| Curaduría | 5.776 hallazgos (5.235 abiertos / 541 resueltos); análisis automáticos de ~3,6–4,1 s; 50 corridas registradas |
| YouTube | 649 videos, 609 enlaces a disco |
| API | 99 operaciones vivas (31 GET / 36 POST / 16 PATCH / 16 DELETE), OpenAPI en `/docs` |
| Web pública | `https://…/crv/` responde 200; búsqueda y fichas probadas end-to-end durante esta auditoría |
| Suite | `typecheck` 0, `lint` 0, `test:unit` 37 archivos/344 pruebas en verde (48 s); contratos de CRUD/curación/fusión: 31 pruebas en verde |

---

## 1. Notas por área (1–20)

| # | Área | Nota | En una línea |
|---|---|---|---|
| 1 | Arquitectura y organización del código | **18/20** | Capas limpias, un solo escritor del core, 152/155 archivos con importador de producción |
| 2 | Base de datos, modelo y migraciones | **16/20** | Modelo sólido y migraciones disciplinadas; la tabla ER (19 GB) sin retención y 1 FK sin índice |
| 3 | CRUD y superficie de API | **18/20** | CRUD completo por entidad a través del merge engine, con auditoría y semántica de errores; `GET /tracks` ausente |
| 4 | Ingesta y merge (gobernanza) | **19/20** | Reglas de confianza implementadas al pie de la letra y probadas; IA nunca ejecuta |
| 5 | Curaduría (detector + marco de acciones) | **18/20** | El subsistema más maduro; E5 en curso (WIP) |
| 6 | Catálogo (calidad del dato) | **15/20** | Relaciones fuertes y completas; enriquecimiento a medias (35,6 % de discos sin pistas, 60 % de pistas sin duración) |
| 7 | Web UI | **15/20** | Alta calidad donde existe; 27/99 operaciones sin UI (17 con cliente ya escrito y muerto) |
| 8 | Pruebas | **15,5/20** | 68 archivos / 495 pruebas de comportamiento real; sin CI ni cobertura, CLI y Sincopa sin probar |
| 9 | Herramientas y operación | **17/20** | CLI de ~20 grupos, doctor con huella, respaldo/restauración, deploy verificado; todo manual |
| 10 | Documentación | **18/20** | 5.448 líneas normativas + informes por etapa; `FINAL_AUDIT.md` desactualizado |
| 11 | Rendimiento y escalabilidad | **13/20** | API en ms; búsqueda fría 0,2–0,6 s en reposo pero **24–30 s bajo contención de E/S**; PG sobre HDD |
| 12 | Seguridad | **17/20** | scrypt validado, timing-safe, CSRF, rate-limit por cuenta e IP, roles; falta rate-limit de escrituras |

---

## 2. Evidencia por área

### 2.1 Arquitectura y organización del código — 18/20

- Un único escritor del core (`src/merge/engine.ts:1-2`), claims como único canal de entrada (`src/claims/persistence.ts`), auditoría obligatoria (`merge_audit` con trigger de `old_value != new_value`, `engine.ts:176`).
- Análisis de importadores propios: **152/155 archivos de `src` tienen importador de producción**; los 3 restantes son entrypoints (`api/server.ts`, `cli/index.ts`, `cotejo/server.ts`, este último vía `npm run cotejo:serve`). Sin módulos muertos.
- Convenciones consistentes: Zod + `fastify-type-provider-zod`, `OperatorError`/`CurationError` para fallos esperados, comentarios que explican el porqué, SQL parametrizado.
- Separación clara: `adapters/` (solo parseo), `ingest/` (runner), `claims/`, `er/`, `merge/`, `review/`, `curation/`, `api/{routes,repositories}`, `web/` como SPA aparte.
- Resta: `src/ambiguity/*` y `src/radio/*` son satélites con poca superficie de prueba (ver §8) y `src/api/routes/` contiene la lógica de composición, no solo HTTP (aceptable por tamaño, pero es donde vive el "framework" de rutas).

### 2.2 Base de datos, modelo y migraciones — 16/20

**Lo bueno**
- 21 migraciones con `.up.sql`/`.down.sql` pareadas, escritas de forma idempotente (`IF NOT EXISTS` / `DROP … IF EXISTS` en las 21); versionadas en `ingest.schema_migrations`; rollback completo probado (`test/contract/core-and-schema.test.ts:213`).
- `doctor` compara el `public` real **entrada por entrada** contra la huella commiteada (178 objetos) — detecta un ALTER, un CHECK borrado o una vista redefinida (`src/doctor/index.ts:82-121`). Hoy: verde.
- Integridad: **143 de 144 FKs de `public`/`ingest`/`media` tienen índice de cobertura**; 0 conflictos abiertos; 0 claims candidatos colgados.
- Espejos Drizzle tipados por esquema (`src/db/schema/*`) con enums fieles a la base.

**Hallazgos**
- **H-BD-1 (alto): `ingest.entity_resolution_decisions` — 469.445 filas en 9 días, 18 GB de TOAST + 561 MB de heap + 128 MB de índices.** Las filas recientes promedian **321 kB (máx. 1,47 MB)**: cada decisión guarda el dossier completo de candidatos (`candidates` + `features` JSONB, `src/er/repository.ts:147`). **No hay poda ni retención** (la única poda del sistema es la de Curaduría, `src/curation/retention.ts:13-14`). Consecuencias medidas: los respaldos completos tardan horas por esta tabla; lecturas en frío son caras.
- **H-BD-2 (bajo): `public.albums.label_id` es la única FK sin índice** (ON DELETE SET NULL); retirar una organización recorre álbumes.
- **H-BD-3 (medio): 12.908 filas de `merge_audit` sin `run_id`** (todas del 13–14 sep 2026, 10,9 % del total). Trazabilidad incompleta en ese tramo histórico.
- La base es `SQL_ASCII` por decisión del core; el sistema lo compensa con índices en memoria en Node (`src/api/search-index.ts:3-6`). Documentado y consistente, pero es la causa raíz de H-REND-1.

### 2.3 CRUD y superficie de API — 18/20

- **99 operaciones** (OpenAPI en vivo). CRUD completo de las 5 entidades resolubles + 5 relaciones + aliases de 5 entidades + fusión con previsualización y deshacer + conversión de personas + cola de revisión + curaduría completa.
- Toda escritura pasa por **una transacción = un run = un claim humano** (`src/merge/operator.ts:66-97`); los controllers solo validan (Zod `.strict()`), y borrar exige verificación de dependientes (`removals.ts`, `has_dependents` con lista).
- Semántica de errores honesta: 404/409/422 tipados (`OperatorError`, `http-errors.ts`), `stale_preview` para concurrencia optimista, `existingId` cuando el ER detecta que la ficha ya existe.
- Paginación estándar con topes (`src/api/pagination.ts:9-12`), filtros y orden en las listas.
- **Hallazgo H-API-1 (medio): no existe `GET /tracks` ni `GET /tracks/{id}`.** Las pistas se pueden crear, corregir, borrar y hasta escribirles aliases, pero no leerse por API (ni sus aliases); la web navega al disco (`web/src/lib/routes.ts:9`). Asimetría CRUD real.
- **Hallazgo H-API-2 (bajo): sin límite de tasa en escrituras** (solo en login, `auth.ts:220-243`). Un cliente autenticado puede saturar; en la práctica el alcance es el tailnet.

### 2.4 Ingesta y merge (gobernanza) — 19/20

- Reglas duras implementadas y verificables en el código vivo: `low`/`ai` → candidate + revisión y el core no se toca (`engine.ts:570-574`); `medium` solo completa vacíos; `high|human` crea; contradicción → conflicto conservado; crédito de álbum jamás crea membresía (`engine.ts:284-286`).
- ER determinista primero, DeepSeek solo en bandas de riesgo y **nunca ejecuta** (`src/er/resolver.ts`); toda decisión queda explicada y auditable (`entity_resolution_decisions`).
- Concurrencia: `pg_advisory_xact_lock` por identidad (5 puntos: `engine.ts:518,728,822,887`) + locks de sesión para escaneos (`scan.ts:63`), con pruebas de concurrencia reales (`curation-scan.test.ts:242-275`).
- Idempotencia por `claims_dedupe_uk` + 13 escenarios en `hardening-scenarios.test.ts`.
- Adapters cerrados (9 funcionales + 2 limited), fetcher con robots.txt previo a la petición (`src/fetcher/http.ts:77-79`), caché por sha256 del contenido.
- Resta: el subsistema de ambigüedades (E10) no tiene pruebas propias de contrato de su `apply` (sí unitarias), y la reparación destructiva de Sincopa (`src/review/sincopa-organizations.ts`, 163 líneas, retira organizaciones) **no tiene ninguna prueba** — el hueco más serio de esta área.

### 2.5 Curaduría — 18/20

- Detector con ~15 detectores en 7 categorías (segmentación, coherencia, duplicados, tipo erróneo, huérfanos, cola, higiene de texto, anomalías), foto del catálogo y huellas estables (`src/curation/analyze.ts`, `detectors/*`).
- Análisis persistido con reconciliación honesta: estados `ok/partial/skipped/failed`, resolución con motivo (`resolution.ts`), historial de cambios por hallazgo, decisiones duraderas (ignorar con motivo + caducidad, pares declarados distintos, E2), verificación dirigida post-corrección (E4.6), lotes con vista previa/hash/aplicar/deshacer (E4, `0018`–`0021`).
- El ciclo se dispara solo: cada escritura de la API lanza verificación (`watcher.ts:30-55`), y el vigilante detecta cambios por firma de catálogo. Medido: análisis completos de 3,6–4,1 s.
- **E5 en curso ahora mismo** (sin commitear): 15 acciones textuales nuevas (`src/curation/actions/textual.ts`, 774 líneas) sobre el registro de 17 acciones (`registry.ts:19-23`).
- Resta: el backlog E6–E12 (valores en disputa, UX de corrección E8, rendimiento incremental E9, autocorrección E10) es exactamente el cuerpo del trabajo pendiente; la web aún depende de los aliases OBSOLETOS `fix/fix-selected/fix-group` hasta E8.

### 2.6 Catálogo (calidad del dato) — 15/20

Completitud medida hoy (solo lectura):

| Métrica | Valor | Lectura |
|---|---|---|
| Álbumes sin artista | 0 / 4.694 | estructura íntegra |
| Álbumes sin año | 219 (4,7 %) | bueno |
| Álbumes sin pistas | 1.670 (35,6 %) | **el hueco mayor** |
| Álbumes sin portada | 1.124 (24 %) | medio |
| Álbumes sin sello | 4.641 (98,9 %) | dato que el core no puede satisfacer del todo hoy |
| Álbumes sin enlace YT | 4.090 (87 %) | esperable |
| Pistas sin duración | 16.227 (60,4 %) | dependiente de la fuente |
| Personas sin ningún vínculo | 279 (2,7 %) | cola de curación (`fichas_sin_vinculos`, 665 hallazgos) |
| Organizaciones sin web | 687 (100 %) | campo vacío por defecto |
| Grupos título duplicado por artista | 5 | residual, con detector activo |

- Los 5.235 hallazgos abiertos (2.759 de segmentación, 783 incoherencias, 727 de tipo erróneo…) son exactamente ese estado a medias — el sistema lo **mide y lo persigue**, que es la diferencia entre "catálogo incompleto" y "catálogo sin control".
- Fortalezas: relaciones correctas y pobladas (43.191 créditos + 1.367 membresías), búsqueda que encuentra con y sin tildes, redirecciones de fusión (`entity_redirects`) para que ningún enlace muera.

### 2.7 Web UI — 15/20

- 16 páginas / 15 componentes; auditoría delegada de código con spot-check propio de sus hallazgos clave (todos confirmados).
- Fuerte: Curaduría (19/20 en su informe), fusión con previsualización y `stale_preview`, conversión de personas, sesión/CSRF en el cliente, accesibilidad del modal (foco atrapado, Escape, ARIA), responsive probado con QA visual a 1440/390 y 1280/400.
- **H-UI-1 (alto): 27/99 operaciones sin UI; 17 ya tienen cliente escrito y muerto** (`web/src/lib/api.ts:181-199,293,301,325`): historial de auditoría (`/audit`, `/runs/{id}`), fuentes, claims, YouTube, `PATCH` de relaciones (corregir un rol obliga a borrar y recrear), alias de pista, mitad del marco de lotes de curaduría. La UI no puede mostrar el historial por ficha aunque el catálogo entero está auditado.
- **H-UI-2 (medio, confirmado por mí): la CSP del gateway bloquea las tipografías.** `web/index.html:8-13` carga Google Fonts; `web/server.mjs:30` declara `font-src 'self'; style-src 'self'` → Anton/Inter/JetBrains Mono no cargan en producción (fallback silencioso a Arial Black/system-ui).
- **H-UI-3 (medio): motivo fabricado por la UI** en 4 acciones (`AliasEditor.tsx:46`, `CreditManager.tsx:41`, `AlbumDetailPage.tsx:260,281`), contra el principio "toda escritura exige nota".
- **H-UI-4 (bajo): sin error boundary** (`main.tsx`); cada tecla en los buscadores dispara petición e historial sin debounce (`useEntityList.ts:13-23`).
- **H-UI-5 (bajo): 409 de dependencias en jerga de Postgres** ("person 123 no se retira: 2 en public.album_credits.person_id").

### 2.8 Pruebas — 15,5/20

- 68 archivos (37 unit / 30 contract / 1 integración opt-in), **495 bloques `it()`**, sin ningún test vacío. 30/30 contratos levantan PostgreSQL propio; 24/30 verifican el **estado por SQL crudo**; 10/30 por HTTP real (`app.inject`).
- Casos difíciles genuinamente probados: atomicidad con fallo inyectado (`person-merge.test.ts:136`), concurrencia con locks (`curation-scan.test.ts:242`), lote con edición externa a mitad (`curation-fixes.test.ts:279-303`), rechazo de deshacer en cadena (`unmerge-roundtrip.test.ts:149`), rate-limit paralelo (`auth.test.ts:155`).
- 151/155 módulos alcanzables por grafo de imports; **4 módulos sin ninguna cobertura**: `cli/index.ts` (838 líneas, ~20 subcomandos), `review/sincopa-organizations.ts` (163 líneas que retiran organizaciones), `doctor/index.ts` (262 líneas) y `api/server.ts` (39 líneas).
- **H-T-1 (alto): no existe CI** (ni `.github`, ni equivalente) ni medición de cobertura (`@vitest/coverage` ausente). La suite es verificable a mano, no obligatoria.
- H-T-2 (medio): paginación casi sin probar (`offset`, default 50, rechazo de `limit>200`); `/merge-runs/:id/undo` y `/persons/duplicate-candidates` sin ejercicio HTTP conductual; `docs/FINAL_AUDIT.md:123-125` con cifras viejas (25/226 unit vs 37/344 reales).

### 2.9 Herramientas y operación — 17/20

- CLI `crv` con ~20 grupos (doctor, db, sources, scrape, youtube/yt:*, ambiguity:*, review, curation, runs) con nombres viejos redirigidos (`cli/index.ts:59-72`) y los no implementados en `KNOWN_FUTURE` (genre:add, genre:disable, export:json).
- `doctor` (hash del core + huella exacta + migraciones + cobertura de auditoría + fuentes), `db:bootstrap`, `db:backup`/`restore`/`restore-check` con verificación, `test:matrix` PG 15/16, sondas en `scripts/probes/`, export de radio, Mesa de Cotejo (`cotejo:build/serve`), 3 suites de QA visual.
- Despliegue real funcionando: `crv-web.service` + `crv-api.service` (systemd de usuario) + Funnel; verificado en vivo con la búsqueda end-to-end.
- **H-OPS-1 (medio): 52 commits sin empujar** a `origin/master` y **deploy 100 % manual** (`scripts/deploy.sh`); no hay pipeline que publique ni que bloquee un merge roto.
- H-OPS-2 (bajo): el sitio público depende de servicios de usuario en la máquina personal (CGNAT + Funnel) — sin redundancia; aceptado como decisión de simplicidad.

### 2.10 Documentación — 18/20

- 5.448 líneas normativas (CONTRACT, PHASES, ARCHITECTURE, OPERATIONS, SOURCES, DATA_MODEL, ER, backup/restore, ADDING_A_SOURCE) + informes por etapa en `reports/` + `migrations/README.md` explicando cada migración y su porqué.
- Coherente con el código en lo verificado; buena señal: los propios documentos declaran reglas que el código cumple (robots primero, un escritor, IA no ejecuta).
- H-DOC-1: `FINAL_AUDIT.md` desactualizado (cifras de la suite); `ARCHITECTURE.md §7` también con conteos viejos.

### 2.11 Rendimiento y escalabilidad — 13/20

- API de lectura en ms con índice caliente (`/artists?q`, 3 ms; listas, 1–10 ms); análisis de curaduría completo en ~3,6 s sobre 5.776 hallazgos; merge con locks medido en cientos de ms.
- **H-REND-1 (alto): la búsqueda en frío puede tardar de 0,2 s a 30 s.** El índice en memoria expira cada 60 s (`search-index.ts:24`) y su recarga ocurre **dentro** de la petición del usuario (`:59-65`); con la caché de página de Postgres fría y/o contención de E/S (contenedores de prueba, respaldos) medí **24,2 s** y, en el sitio público, una búsqueda real de **29,9 s** (`performance` del navegador). En reposo con caché fría: 0,2–0,6 s; en caliente: 30–120 ms. Raíz: PG vive en `/mnt/datos` (HDD, `sda` ROTA=1) y la tabla de 18 GB de TOAST (H-BD-1) compite por IO.
- H-REND-2 (medio): `entity_resolution_decisions` crece ~50k filas/día; a ~40 kB promedio (y 321 kB en las recientes) es el riesgo de disco #1 del sistema.
- H-REND-3 (bajo): `/youtube/videos` 0,87 s por joins sin índice dedicado evidente.

### 2.12 Seguridad — 17/20

- Login: scrypt con parámetros validados (N≥16384 potencia de 2, r/p acotados, `maxmem`), comparación timing-safe por digest, mismo coste para usuario inexistente (anti-enumeración), cupo por cuenta **y** por IP con techo de memoria (`auth.ts:220-243,353-357`).
- Sesión: token aleatorio 32 B en cookie HttpOnly + SameSite=Strict + Secure tras proxy; CSRF en memoria exigido en cada escritura (`auth.ts:311-315`); origen verificado (lista + mismo host); roles admin/reader aplicados en servidor y en la UI; cuentas de herra revalidadas en cada uso.
- Logs con redacción de `authorization`/`cookie` (`app.ts:50-53`); CORS con lista cerrada (`app.ts:65-69`); API en loopback; gateway con CSP, `X-Frame-Options DENY`, `nosniff`, `Referrer-Policy`.
- H-SEC-1 (bajo): sin rate-limit de escrituras; el bearer heredado sigue habilitado si está en `.env`; las sesiones viven en memoria (un reinicio de `crv-api` las cierra — documentado y aceptado: `scripts/deploy.sh` avisa).
- H-SEC-2 (bajo, cosmético-seguridad): H-UI-2 (CSP bloquea fuentes) evidencia que la política del gateway se escribió sin probar la página completa.

---

## 3. Qué está excelente (no tocar)

1. **Gobernanza de escritura única** con auditoría y deshacer: el activo más valioso del sistema. No hay camino alternativo al merge; los tests lo vigilan; `doctor` comprueba que el core no derivó.
2. **Honestidad del detector de curaduría**: estados `partial/skipped`, motivos de resolución, caducidad de decisiones, verificación dirigida. Es raro ver un detector que declare lo que no miró.
3. **Contratos de prueba con PostgreSQL desechable** y verificación por SQL del estado final (incluye concurrencia, atomicidad y roundtrip de undo).
4. **La regla "IA propone, no ejecuta"** implementada en ER, conflictos, ambigüedad y biografías.

## 4. Qué atacaría a continuación (prioridad)

1. **Retención/compactación de `entity_resolution_decisions`** (H-BD-1/H-REND-2): podar dossiers antiguos o guardar solo el ganador + resumen de candidatos; sin esto, respaldos y disco seguirán degradándose.
2. **Búsqueda sin penalización en frío** (H-REND-1): refresco en segundo plano sirviendo el índice viejo (stale-while-revalidate), TTL mayor, o cargar el índice desde un snapshot al arrancar.
3. **CI** (H-T-1/H-OPS-1): workflow que corra `typecheck + lint + test:unit + contratos` y bloquee merge; pushear los 52 commits.
4. **Cerrar la cobertura de UI** (H-UI-1) al ritmo del plan de Curaduría (E8) — sobre todo **historial de auditoría por ficha** (`/audit`), que ya está en la API y no se ve.
5. **Arreglos puntuales baratos**: CSP de tipografías (H-UI-2), motivo fabricado (H-UI-3), `GET /tracks` (H-API-1), índice de `albums.label_id` (H-BD-2), tests de CLI y de Sincopa.

---

## 5. Discrepancias plan ↔ realidad detectadas al auditar

- `docs/ARCHITECTURE.md §7` y `docs/FINAL_AUDIT.md` con conteos de pruebas viejos (la suite creció a 68 archivos / ~495 pruebas).
- `CRV_IMPLEMENTATION_CONTRACT`/§4.13: `genre:add`, `genre:disable`, `export:json` siguen en `KNOWN_FUTURE` (declarados, no implementados) — coherente, pero conviene decidir si salen del contrato o se implementan.
- El plan de Curaduría va por E5 (en curso, sin commitear en el árbol); E0–E4 cerradas en `cd57a01`/`b322617` coinciden con lo verificado en la base (migración 0021 aplicada el 2026-09-17 21:44).

## 6. Metodología y límites

- Verificación directa: lectura de código (file:line citado), consultas de solo lectura a `crv-postgres`, `curl` contra la API viva, navegador real contra el sitio publicado, suites corridas al momento.
- Auditorías delegadas (web, pruebas) con spot-check propio de sus hallazgos clave: **todos confirmados** (CSP/fuentes, clientes muertos, sin error boundary, sin CI, sin tests de CLI, cifras viejas de FINAL_AUDIT).
- Límite declarado: la auditoría de BD delegada agotó tiempo al medir el TOAST de la tabla de 19 GB (las muestras por rangos y tamaños de objeto sí se completaron); el análisis de rendimiento se hizo con el sistema ya sin las suites corriendo, y la medición de 24–30 s corresponde a ventanas con contención de E/S, declarada como tal.
