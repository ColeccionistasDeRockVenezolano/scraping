# CRV · Auditoría final (E11)

Fecha: 2026-09-14/15 · commit base auditado: `6610723` · PostgreSQL real:
16, `SQL_ASCII`, locale `C/C`.

## Resultado

La etapa E11 no alteró `crv_simple_v1.sql` ni añadió fuentes o funciones de
producto. Añadió pruebas de endurecimiento, un linter real, índices de soporte
para FKs auxiliares, redacción defensiva de secretos, scripts de respaldo y
restauración y la documentación operativa que faltaba.

En el código no se encontró ningún defecto de severidad alta. La auditoría
de la configuración en vivo sí encontró una exposición alta que dependía de
una decisión del propietario: la Mesa de Cotejo salía por Funnel sin
autenticación (KI-08) y el proxy `/crv` quedaba inerte sin token (KI-09). El
propio 2026-09-15, ya con E11 cerrada, el propietario resolvió ambas fuera
del alcance de esta etapa (retiró la Mesa de Funnel, activó
`CRV_OPERATOR_TOKEN`) — ver el detalle en cada fila de Known Issues. Verificar
`/crv` con el navegador tras ese cambio descubrió un bug real de producto (no
de E11): el basename del router quedaba en blanco sin barra final; corregido
y verificado con Claude in Chrome contra el dominio público. Los límites y la
deuda restantes aparecen en «Known Issues»; ninguno permite una corrupción
silenciosa del core, porque toda aplicación al core pasa por vista previa y
`--confirm`.

## Cambios correctivos de E11

- `npm run lint` ejecuta ESLint con reglas TypeScript informadas por tipos,
  promesas no esperadas, imports y hooks de React; `typecheck` sigue separado.
- `0013_fk_indexes` añade índices para todas las FKs de `ingest` y `media`
  que no comenzaban por sus columnas. No modifica `public`. El contrato busca
  automáticamente cualquier FK auxiliar sin índice.
- Las propuestas de fuente crean `sources` + `review_queue(new_source)` en una
  única transacción.
- Pino y el logger de Fastify censuran cabeceras de autorización y nombres de
  configuración sensibles como defensa en profundidad.
- El fetcher tiene pruebas reales de 429/5xx, agotamiento de reintentos, 404
  terminal, User-Agent, exclusión mutua y demora por fuente.
- YouTube tiene pruebas de corte por cuota, `quotaExceeded` sin reintento ni
  filtración de clave y reintento de 5xx.
- El help del CLI y la documentación usan los nombres implementados, no los
  alias antiguos `seed:import-yt`, `yt:sync` o `merge:run`.
- `db:backup`, `db:restore` y `db:restore-check` conservan base + crudo, usan
  sumas SHA-256, comparan filas y hashes y restauran sin sobrescribir destinos.

## Caso de aceptación real: Caramelos

Consulta de solo lectura ejecutada sobre `crv-postgres` el 2026-09-14:

| Aserción | Evidencia real | Estado |
|---|---:|---|
| Artista lógico `Caramelos De Cianuro` | 1 fila, id 58, `band`, Venezuela | PASS |
| `Las Paticas De La Abuela` | 1 fila, id 57, 1992, `ep` | PASS |
| URL de álbum | `https://www.youtube.com/watch?v=Q-pRpO2sYSI` | PASS |
| Video primario | 1, id interno 54, `full_album`, upload order 28, confianza high | PASS |
| Pistas enlazadas | 4 ocurrencias distintas, inicios 0–615 s, final 940 s | PASS |
| Créditos de álbum | 12: 8 de persona, 2 de artista, 2 de organización | PASS |
| Integridad audiovisual global | 0 ocurrencias video/pista duplicadas; 0 álbumes con dos primarios | PASS |
| Procedencia del merge | 0 filas de `merge_audit` sin claim | PASS |

`youtube_status=published` es correcto en la base actual: F3 hidrató la API.
El valor `unknown` de la aceptación original describía únicamente el estado al
cerrar F2.

## Los 13 escenarios obligatorios

`test/contract/hardening-scenarios.test.ts` usa un PostgreSQL desechable y la
puerta normal raw → adapter → normalización → claim → ER → merge. Las garantías
puramente relacionales se ejercitan directamente contra las constraints.

| # | Escenario | Aserción principal | Estado |
|---:|---|---|---|
| 1 | Misma página tres veces | 1 raw page, claims reutilizados, sin entidad nueva | PASS |
| 2 | Mismo XLSX tres veces | importaciones 2 y 3 `unchanged`, mismos seeds/reviews/videos | PASS |
| 3 | URL YouTube con parámetros | todas canonizan al mismo `video_id` y una sola fila | PASS |
| 4 | Bandas de nombre parecido | candidato; no merge hasta decisión humana `different` | PASS |
| 5 | Personas homónimas | contexto de banda escoge candidato; el nombre solo no fusiona | PASS |
| 6 | Alias con/sin tilde | solo converge tras alias explícito; conserva nombre canónico | PASS |
| 7 | Dos años distintos | conflicto conserva 1992/1993 y no sobrescribe el core | PASS |
| 8 | Álbum con 30 músicos | 30 créditos idempotentes; 0 membresías inferidas | PASS |
| 9 | Pista con varios créditos | personas y roles distintos se conservan por separado | PASS |
| 10 | Video con varias pistas | N relaciones válidas, reprise válida, duplicado/rango inválido bloqueados | PASS |
| 11 | Álbum con varios videos | N videos y un único primario por índice parcial | PASS |
| 12 | Persona extranjera | crédito y nacionalidad conservados; 0 membresía automática | PASS |
| 13 | Músico invitado | crédito `guest`; ninguna fila en `artist_members` | PASS |

## Matriz final requisito / implementación / prueba / estado

| Requirement | Implementation | Test o evidencia | Status |
|---|---|---|---|
| Core canónico intacto | Migraciones solo `ingest`/`media` | hash + diff de schema en `core-and-schema` | PASS |
| Migraciones reproducibles | runner TS, tabla de versiones, up idempotente y down | `core-and-schema`, harness PostgreSQL 15/16 | PASS |
| FKs y constraints | DDL 0001–0013 | contrato de FKs indexadas + escenarios 10/11 | PASS |
| Índices operativos | `0013_fk_indexes` | búsqueda automática de FK auxiliar sin prefijo de índice | PASS |
| Seguridad transaccional | merge/API/revisión por transacción; propuesta de fuente atómica | contratos de merge, API write y revisión | PASS |
| Idempotencia | hashes, uniques y upserts | escenarios 1–3, 8; adapters ingestion | PASS |
| Protección de duplicados | ER + aliases + uniques del core/auxiliares | escenarios 3–6, 10/11 | PASS |
| Rate limit / robots | una petición por fuente, delay máximo propio/robots | `fetcher-politeness`, `robots`, `fetcher-observe` | PASS |
| HTTP retries | backoff 1/2/4 en red, 429 y 5xx; 4xx terminal | `fetcher-politeness` | PASS |
| Cache y raw evidence | `data/raw`, `raw_pages`, hash y TTL | `fetcher-observe`; restore valida archivos/hashes | PASS |
| Claims y evidencia | claim inmutable + `claim_evidence` | contracts de ingestión; Caramelos | PASS |
| Conflictos | ambos claims y evidencias, core intacto | escenario 7; `entity-resolution-merge` | PASS |
| Merge audit | auditoría enlazada a claims y runs | `doctor`; 0 auditorías sin claim en la base real | PASS |
| Validación IA | salida JSON Zod, citas y política; IA no escribe core | `deepseek-gateway`, `ambiguity-resolution` | PASS |
| Secret management | `.env` ignorado, tokens opcionales, auth constante, redacción de logs | escaneo de Git + tests API/YouTube | PASS |
| Exposición de red en vivo | API, PostgreSQL, Mesa y gateway escuchan en `127.0.0.1`; Tailscale decide qué sale | `tailscale funnel status`, `ss`/procesos, lectura de `web/server.mjs` y `src/cotejo/server.ts` (2026-09-15) | RESUELTO — KI-08 y KI-09, decisión del propietario aplicada el 2026-09-15 (ver Known Issues) |
| YouTube quota | presupuesto diario y costos explícitos | `youtube-enrich` unit/contract | PASS |
| CLI | comandos reales, errores/exit codes y help reconciliado | ejecución `crv --help`, suite | PASS |
| API validation/auth | Zod strict, bearer, escrituras por merge | `api-read`, `api-write`, `api-aliases` | PASS |
| CRUD | 10 entidades core + relaciones/aliases | contratos API de escritura | PASS |
| Frontend | React → API, sin acceso directo a PostgreSQL | typecheck + build Vite | PASS |
| Error handling/logging | errores tipados, Pino, runs/errors persistidos, redacción | tests fetcher/API/AI + lint | PASS |
| Backup/restore | dump custom + raw + manifest + SHA-256 + restore desechable | `db:backup` real (`crv-20260915T011708Z`) + `db:restore-check`: filas, índices/constraints, 1.830 hashes, doctor | PASS |
| Documentación operativa | Operations, Adding a Source, Backup/Restore | inspección y comandos reconciliados | PASS |

## Validaciones ejecutadas

| Comando | Resultado |
|---|---|
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run test:unit` | PASS — 25 archivos, 226 pruebas |
| `npm run test:contract` | PASS — 20 archivos, 132 pruebas, 751,44 s |
| `npm test` | PASS — 45 archivos y 358 pruebas; 1 integración real opt-in omitida |
| `npm run test:matrix` | PASS — PostgreSQL 15.19 y 16.14; subida doble, DDL idempotente, rollback y core intacto |
| `cd web && npm run build` | PASS — 4.608 módulos, bundle 269,26 kB (79,65 kB gzip) |
| `npm run db:migrate` (base real, tras respaldo verificado) | PASS — `0013_fk_indexes` aplicada en 41 s; 0 índices inválidos |
| `npm run doctor` (base real con 0013) | PASS — TODO VERDE: core hash + 178 objetos, migraciones 0001–0013, cobertura `merge_audit`, 14 fuentes |
| `npm run db:restore-check -- backups/crv-20260915T011708Z` | PASS — `RESTORE VERIFICADO`; restauración 1 h 42 min; 44 tablas / 2.105.173 filas idénticas; 0 crudos faltantes o alterados; doctor verde en la copia |

La integración real con DeepSeek es deliberadamente opt-in y se omite sin
`RUN_DEEPSEEK_INTEGRATION=1` + clave. Las reglas, validación de respuesta y
persistencia sí corren con transportes deterministas en la suite normal.

El primer intento de `test:contract` coincidió con el dump de 20 GB y una
consulta diagnóstica que recorría la tabla ER de 19 GB. Hippito y Sincopa
agotaron entonces su límite de 60 s sin fallo de aserción. Se detuvo ese run
inconcluyente, se eliminó la contención y se repitió la suite completa: ambos
adapters pasaron en 21,78 s y 17,92 s, y el resultado final fue 132/132.

### Respaldo y restauración

`npm run db:backup` sobre la base real produjo `backups/crv-20260915T011708Z`
en 45 min. Contiene un dump de 7,29 GB, el crudo de 13,5 MB, 44 tablas y
2.105.173 filas, sin snapshots faltantes. El primer intento murió por falta de
memoria: la versión previa del script volcaba el dump al `/tmp` del contenedor.
Se corrigió transmitiendo el dump al host, y el segundo intento pasó.

`npm run db:restore-check` restauró ese respaldo en un PostgreSQL desechable
en 1 h 42 min. Resultado: `RESTORE VERIFICADO`. Coinciden la codificación, las
44 tablas con 2.105.173 filas, las migraciones y los índices y constraints de
cada esquema, sin índices inválidos. De 1.830 `raw_pages` ninguna falta ni
tiene el hash distinto, y `doctor` quedó en verde contra la copia. Detalle y
nota sobre la salida del script: `DATABASE_BACKUP_RESTORE.md` §5.

## Escaneo de secretos

Se recorrieron los 51 commits alcanzables y el working tree con patrones para
claves Google `AIza…`, tokens `sk-…`, Bearer literales largos, asignaciones de
las tres variables secretas y URLs con `usuario:password@host`.

Resultado: 0 secretos reales. El único candidato de Git es el token ficticio
de `test/contract/api-write.test.ts`; la base contiene un falso positivo
`sk-…` de 25 caracteres dentro de un `etag` público de YouTube. `.env` está
ignorado. El escaneo se repitió el 2026-09-15 sobre los 42 archivos
modificados o nuevos de E11 (sin `package-lock.json`). Además de los patrones
anteriores buscó `ghp_`, `github_pat_`, `xox*-`, `tskey-`, claves privadas
PEM, nombres de host `*.ts.net` y el correo del propietario. Único resultado:
la clave ficticia `AIzaClaveQueNoDebeFiltrarse` de
`test/unit/youtube-enrich.test.ts`, que existe precisamente para comprobar que
el error no filtra la clave. La credencial `crv:crv` de Docker es exclusivamente local y
documentada, no una credencial desplegable.

`npm audit --omit=dev` informa 2 vulnerabilidades moderadas transitivas y 0
altas/críticas; el árbol completo informa 4 moderadas y 0 altas/críticas. Ver
KI-04.

## Known Issues

| ID | Severidad | Límite conocido | Mitigación / decisión |
|---|---|---|---|
| KI-01 | Media operativa | El backup es completo; no hay incrementales ni PITR. Restaurarlo requiere temporalmente otra base de ~20 GB y es lento: medido el 2026-09-15, 45 min de respaldo y 1 h 42 min de `pg_restore` secuencial, dominado por la tabla ER (KI-02). El tiempo de recuperación real ronda las 2 h. | Ejecutar periódicamente, guardar fuera del repo y probar cada copia; documentado en `DATABASE_BACKUP_RESTORE.md`. |
| KI-02 | Media de capacidad | `ingest.entity_resolution_decisions` ocupa ~19 GB para 469.292 decisiones porque conserva listas completas de candidatos como evidencia. | No afecta corrección; vigilar disco. Compactar evidencia exigiría una decisión de retención/producto fuera de E11. |
| KI-03 | Baja | Dos páginas distintas de una fuente que repiten el mismo valor contradictorio abren un conflicto por par de claims; el core queda intacto pero puede haber ruido duplicado en revisión. | La misma página sí es idempotente. Agrupar conflictos por valor cambiaría identidad/auditoría y se difiere. Escenario 7 lo hace explícito. |
| KI-04 | Moderada upstream | `npm audit`: `uuid` transitivo de ExcelJS y `@vitest/mocker` tienen advisories moderados. Las correcciones sugeridas requieren downgrade/bump mayor. | No hay vulnerabilidades altas/críticas; no se fuerza una actualización incompatible en hardening. Revisar cuando ExcelJS/Vitest publiquen una ruta compatible probada. |
| KI-05 | Baja operativa | Aprobar una fuente futura no tiene un comando genérico que implemente/habilite su adapter. | Es intencional: exige aprobación, cambio de código, fixture y despliegue; proceso completo en `ADDING_A_SOURCE.md`. |
| KI-06 | Baja de datos | Quedan ~32 nombres compuestos de organizaciones procedentes del primer parser de YouTube y 405 revisiones humanas abiertas (400 duplicados posibles, 5 YouTube). | No son conflictos abiertos ni mutan el core; resolver en cola, sin inferencia automática. |
| KI-07 | Limitación de verificación | La llamada real a DeepSeek no forma parte de la suite reproducible sin secreto y cuota. | Test opcional `test:deepseek:real`; contratos deterministas cubren schema, evidencia y gating. |
| KI-08 | **Alta de exposición — RESUELTO 2026-09-15** | `tailscale funnel status` (2026-09-15) publicaba la Mesa de Cotejo (`127.0.0.1:4310`) en internet abierto bajo `/cotejo`. La Mesa no tiene autenticación: `POST /api/decisions` y `/api/decisions/undo` aceptan cualquier `decidedBy`, y la página muestra nombres de personas sin revisar. En la base había decisiones de 4 autores (`Jose` 828, `Brian` 290, `Claude (por Brian)` 20, `Codex` 5). | El propietario eligió la alternativa (a): `tailscale funnel --https=443 --set-path=/cotejo off`. La Mesa sigue corriendo y accesible solo por el tailnet (puerto 9444, diseño original). Verificado: `tailscale funnel status` ya no lista `/cotejo`. Quien colabore desde fuera del tailnet necesita otro canal. |
| KI-09 | Media de exposición — **RESUELTO 2026-09-15 (activado, no inerte)** | El gateway público `web/server.mjs` (`/crv`, también por Funnel) solo acepta GET/HEAD para archivos, pero reenvía `/crv/api/*` con cualquier método y con la cabecera `Authorization`. La API usa además `cors({ origin: true })`. | El propietario decidió activar el token en vez de restringir el proxy a solo lectura: se generó `CRV_OPERATOR_TOKEN` (48 hex, `openssl rand -hex 24`) en `.env` y se reinició la API. Verificado: sin `Authorization` responde 401; con el token correcto la auth pasa (probado contra una ruta inexistente → 404, no 401/403). Las escrituras del operador ahora son alcanzables desde internet, protegidas solo por ese bearer (comparación de tiempo constante, sin cookie de por medio). Guardar el token con el mismo cuidado que `YOUTUBE_API_KEY`/`DEEPSEEK_API_KEY`. |
| KI-10 | Bug de producto, no de E11 — **encontrado y corregido 2026-09-15** | Al verificar KI-08/KI-09 con Claude in Chrome, `https://…/crv` (sin barra final) cargaba en negro: 0 elementos bajo `#root`, sin ningún error en consola ni llamada a la API. Causa: `BrowserRouter basename={import.meta.env.BASE_URL}` en `web/src/main.tsx` usa un basename con barra final (`/crv/`, garantizado por Vite); `react-router` exige que el pathname empiece exactamente así, y `/crv` sin barra no matchea → no monta nada. Un redirect en el gateway (`web/server.mjs`) no sirve: Funnel recorta el prefijo configurado antes de reenviar, así que el backend recibe `/` sea cual sea la forma que escribió el visitante y no puede distinguirlas. | Se quitó la barra final del basename (`import.meta.env.BASE_URL.replace(/\/$/, "") \|\| "/"`), con lo que `react-router` reconoce `/crv` y `/crv/` por igual. Se reconstruyó (`build:public` con `VITE_API_BASE_URL` apuntando a `/crv/api`) y se verificó con Claude in Chrome contra el dominio público de Funnel: shell, portada y búsqueda («Caramelos» → «Caramelos De Cianuro» + discos) funcionando con datos reales de la API. |

## Conclusión

E11 queda cerrada el 2026-09-15. Todos los renglones de validación tienen
evidencia ejecutada en la máquina de producción:
- respaldo real con `RESTORE VERIFICADO`;
- `0013` aplicada a la base real y `doctor` en verde;
- 358 pruebas, 132 contratos y la matriz PostgreSQL 15/16 en verde;
- lint, typecheck y build web en verde.

Con 0013 los chequeos de FK medidos sobre la base real bajaron de segundos a
submilisegundos:

| FK | Antes | Después |
|---|---|---|
| `entity_resolution_decisions.track_id` | 3.965 ms | 0,37 ms |
| `claims.track_credit_id` | 4.622 ms | 0,17 ms |
| `merge_audit.track_id` | 699 ms | 0,16 ms |
| `review_queue.person_a_id` | 543 ms | 0,07 ms |

El mismo 2026-09-15, ya con E11 técnicamente cerrada, el propietario resolvió
KI-08 y KI-09 (Mesa retirada de Funnel, `CRV_OPERATOR_TOKEN` activado). Esa
verificación encontró y corrigió KI-10, un bug real en `web/src/main.tsx` que
dejaba `/crv` en blanco sin barra final — sin relación con el alcance de E11,
pero real y confirmado con Claude in Chrome contra el dominio público antes y
después del arreglo. Si una validación posterior falla, este documento debe
conservar el fallo; no se convierte en PASS por declaración.
