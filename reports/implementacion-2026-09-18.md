# CRV · Implementación de las mejoras de la auditoría (2026-09-18)

Base: `reports/auditoria-sistema-2026-09-17.md` (nota global 17/20). Este
informe cierra cada hallazgo con su commit y su prueba. Nada se empujó a
`origin`: los commits quedan locales para revisión.

## Hallazgos críticos

| # | Hallazgo | Solución | Evidencia |
| --- | --- | --- | --- |
| 1 | `ingest.entity_resolution_decisions`: 469.445 filas / 19 GB (18 de TOAST) sin retención | Migración 0022 (`compacted_at`, `candidates_count`, índice parcial) + `src/er/retention.ts`: compacta por edad conservando decisión, features, explicación, `input_context` y las 20 mejores candidatas. Ni un borrado: idempotente, reanudable, con candado de sesión. La API la corre sola; `crv er:prune` a mano | `62ae909`; contrato `er-retention.test.ts` (5/5); dry-run dev: 469.393 pendientes; backfill en curso (111k compactadas a las 08:40) |
| 2 | Búsqueda en frío: 24–30 s porque el índice expiraba cada 60 s y recargaba dentro de la petición | `src/api/search-index.ts` a stale-while-revalidate: sirve lo que hay y refresca en segundo plano (una carga por tipo, con backoff); la invalidación marca y refresca ya | `069034e`; contrato `search-index.test.ts` (3/3); medición en vivo tras el deploy: **0,08–0,10 s** |
| 3 | Sin CI ni cobertura; la suite solo corría a mano | `.github/workflows/ci.yml` (calidad con tipos+lint+unitarias+cobertura por umbral, contratos con PostgreSQL desechable, build web) + `npm run test:coverage` con `@vitest/coverage-v8` | `33ba3c4`; umbral fijado al nivel medido (35,5 % sentencias / 80,8 % ramas) |

## Hallazgos altos

| # | Hallazgo | Solución | Evidencia |
| --- | --- | --- | --- |
| 4 | CLI, `sincopa-organizations.ts` y `doctor` sin una sola prueba | Tres contratos nuevos: humo de la CLI (ayuda, comandos renombrados/futuros, doctor, listados, dry-runs que no escriben), `doctor` completo (verde, fila sin auditoría, drift en `public`, aviso de fuentes) y la reparación de organizaciones de Sincopa (guardas y apply real con run, auditoría y claims) | `1911256` (CLI 6/6, doctor 4/4, sincopa 3/3) |
| 5 | 27/99 operaciones de la API sin UI | Cierre parcial y deliberado: el historial por ficha, los lotes E4–E6 y el resto de la mitad muerta del cliente son E8 (siguiente etapa del plan). De esta lista se cerró el extremo de los alias de pista (el otro extremo del hallazgo 7) | `4ae90e8` |
| 6 | UI: Google Fonts bloqueado por la CSP, motivos fabricados, listas que parpadeaban, sin error boundary, 409 en jerga de Postgres | Tipografías auto-hospedadas (Anton + Inter/JetBrains variables), 5 escrituras con motivo real, debounce de 250 ms con `replace`, listas que atenúan en vez de desaparecer, `ErrorBoundary` global y mensajes humanos en el 409 | `61306a4` + `1b7e113` + `de475f5`; verificado en vivo: 0 referencias a Google Fonts, fuentes propias servidas (18 KB, 0,018 s) |
| 7 | Sin `GET /tracks` ni `GET /tracks/{id}`: CRUD de pistas asimétrico | Repositorio y rutas de lectura de pistas (listado con filtro por disco/texto/alias, ficha con alias y créditos, 404 con `movedTo`) y su uso en el modal de edición del disco | `104d3f9` (api-read 19/19), `4ae90e8` |
| 8 | `src/api/pagination.ts` sin pruebas de sus límites | Contrato unitario: defecto 50, tope 200, rechazos y forma de `toPage` | `2f83693` |

## Hallazgos medios

| # | Hallazgo | Solución | Evidencia |
| --- | --- | --- | --- |
| 10 | El login limita intentos; las escrituras autenticadas no | `src/api/rate-limit.ts` (ventana fija por cuenta, tope de claves, apagable) aplicado en `auth.ts`; `CRV_WRITE_RATE_LIMIT=240`/min | `3043d6a`; unitarias del limitador |
| 11 | Documentación desalineada (`FINAL_AUDIT`, ARCHITECTURE §7) | `FINAL_AUDIT` marcado como instantánea histórica; ARCHITECTURE con E5–E6, retención ER, SWR, `/tracks` y CI; OPERATIONS con la operación de la retención | `17d7a79` |
| 12 | 12.908 auditorías sin `run_id` (13–14 sep) y nada que lo vigile | Causa raíz documentada (cierre F2–F5 por una ruta sin run); `merge_audit.coverage` avisa si aparecen nuevas en 3 días y tolera el histórico nombrándolo | `2e62d9c` (doctor 5/5) |
| 9 | `public.albums.label_id` sin índice | **No se toca por diseño**: el core es inmutable y `doctor` verifica su huella objeto por objeto; queda como desviación conocida en ARCHITECTURE §4.17 para decisión del dueño | `17d7a79` |
| 13 | `/youtube/videos` tardaba 0,87 s según el informe | Medición del 2026-09-18: **0,005 s en caliente** (0,39 s en frío). Era contención de IO del HDD, no la consulta: sin cambios de código, cerrado con evidencia | medición de este informe |
| 14 | PostgreSQL en HDD: picos de latencia | **Resuelto**: el data dir pasó al SSD (`/home/brian/crv-pgdata`, bind mount) con copia verificada por hashes (1.985 archivos, bit a bit) y conteos idénticos. Medido después: búsquedas 0,03-0,08 s y scan de 510k claims en 0,2 s. Vuelta atrás documentada (el volumen del HDD sigue intacto) | `docker-compose.yml` + OPERATIONS |

## E5 y E6 (trabajo en curso de Curaduría, cerrado)

- `8f16597` — E5 (acciones de texto): se commiteó con staging quirúrgico para no
  arrastrar el trabajo de E6 que estaba en el árbol. Aceptación medida:
  5.235 hallazgos · 1.200 nivel 0 · 3.257 nivel 1 · 125 nivel 2 · 653 manual.
- `864113e` — E6 (acciones estructurales): 20 acciones, fusión de discos,
  división de personas, deshacer estructural; 21/21 pruebas; limpieza de los 20
  avisos de lint que quedaron en la iteración.

## Verificación de cierre

- `npm run typecheck` ✓ · `npm run lint` ✓ (0 problemas)
- `npm run test:unit` → **40 archivos / 364 pruebas** ✓
- Contratos nuevos: `er-retention` 5/5, `search-index` 3/3, `cli` 6/6,
  `doctor` 5/5, `sincopa-organizations` 3/3, `api-read` 19/19,
  `curation-structural` 7/7 + unit 14/14, `api-write` 9/9, `core-and-schema` 7/7
- Migración 0022 aplicada a la base de desarrollo y verificada (columnas +
  índice + dry-run)
- API reiniciada con el código nuevo; `/health` ok
- Web publicada (`scripts/deploy.sh`) y verificada en vivo:

| comprobación | antes | después |
| --- | --- | --- |
| Google Fonts en el HTML | 3 referencias (bloqueadas por la CSP) | 0 |
| Tipografías propias | — | 200 OK, 18.612 B, 0,018 s |
| Búsqueda pública | 29,9 s (una medición real) | 0,08 / 0,10 / 0,08 s |

## En curso y decisiones del dueño

- **Backfill de retención: cerrado** (2026-09-18, 11:27). `crv er:prune` compactó
  464.393 decisiones en 2 h 57 min; la tabla quedó con 469.393 compactadas de
  469.445 (las 52 restantes son de la ventana de 3 días, por diseño) y **650 MB
  de datos vivos** donde antes había 19 GB, así que el respaldo completo ya no
  copia la basura. El `VACUUM (ANALYZE)` paralelo murió por el `/dev/shm` de
  64 MB del contenedor → relanzado con `PARALLEL 0` y documentado en
  OPERATIONS §4. **`VACUUM FULL` hecho**: la tabla pasó de 20 GB a **817 MB**
  (heap 711 MB) en 51 s, con las 469.445 filas intactas y **18 GB devueltos** al
  disco. Antes se hizo un respaldo fresco verificado de punta a punta
  (`db:restore-check`: 50 tablas, 2.121.713 filas idénticas, raw por sha256,
  doctor verde); el dump pesa **110 MB** comprimido, así que los respaldos
  dejaron de ser un problema.
- **Push**: los commits se empujaron a origin el 2026-09-18 (`c73c3e5..59cfe3c`);
  el CI corre sobre master y su primera corrida (35356516029) falló en Contratos
  por dos fragilidades que este informe ya recogía como arregladas (reloj de
  `finish_run` y refresco del índice en los tests de búsqueda).
- **SSD**: hecho — el data dir pasó al SSD con verificación por hashes (fila 14);
  el **Docker root** (imágenes y volúmenes de contenedores desechables) sigue en
  el HDD: moverlo afecta a todos los contenedores de la máquina y queda como
  decisión aparte (medida en OPERATIONS).
- **Cola del CI** (`2143b72`): su corrida de Contratos 35359069309 falló por el
  arranque del contenedor, no por el código — el hook de 120 s no cubría espera
  + core + migraciones y el `afterAll` (`container.stop()`) enmascaraba el error
  real. Ahora `startPgContainer` reintenta con otro puerto si choca, la espera
  es 100 s, el `hookTimeout` 180 s y 34 contratos limpian con `container?.stop()`.
- **`albums.label_id`**: índice fuera del core (requiere regenerar `core:catalog`
  con aprobación explícita).
- **E8** (UX de corrección sobre el marco E4–E6) sigue siendo la siguiente etapa
  del plan de Curaduría; el historial por ficha en la interfaz queda ahí.
