# CRV · Operación

Guía de E11 para operar el sistema en la máquina de producción: qué comando
usar, en qué orden y cómo saber qué pasó. Todos los comandos se corren desde
la raíz del repositorio. `npm run cli -- <comando>` es el CLI (`src/cli/index.ts`);
`npm run cli -- --help` imprime la lista completa.

Reglas que valen para todo lo de abajo:

- **El core (`public`) solo cambia por el merge engine o por un comando de
  revisión con `--confirm`.** Scrapers, YouTube e IA producen claims y
  revisiones, nunca escriben el catálogo por su cuenta.
- **Todo lo que escribe en lote tiene vista previa.** Sin `--confirm` (o con
  `--dry-run`) se imprime el plan y no se toca nada. Ver §8.
- **Respaldar antes de migrar o aplicar en lote** (§6).

## 1. Puesta en marcha y migraciones

```bash
npm install
npm run db:bootstrap   # .env + PostgreSQL + core + migraciones + fuentes + doctor
npm run doctor         # comprobar en cualquier momento
```

`db:bootstrap` es idempotente: crea `.env` desde `.env.example` si falta,
levanta `crv-postgres` (`127.0.0.1:5433`), aplica `crv_simple_v1.sql` verbatim
solo si la base no tiene el core, corre las migraciones pendientes, siembra
`ingest.sources` y termina con `doctor`.

Migraciones nuevas sobre una base con datos:

```bash
npm run db:backup                              # §6: primero el respaldo
npm run db:migrate                             # aplica migrations/NNNN_*.up.sql pendientes
npm run doctor                                 # huella del core + migraciones + integridad
```

Parar antes la API, la Mesa y cualquier ingesta. Las migraciones corren en
transacción; una que construye índices (como `0013_fk_indexes`) toma locks de
mantenimiento sobre las tablas auxiliares mientras termina. Programar una
ventana de mantenimiento y no cancelar el proceso a mitad.

`npm run db:migrate -- down` revierte **todas** las migraciones: es para
desarrollo y tests, no para operación. `npm run db:down` borra el contenedor
y su volumen. El core nunca se migra: `doctor` compara su hash y la huella del
catálogo (`src/doctor/core-catalog.json`) contra la base viva.

`doctor` sale con código distinto de 0 si algo falla y comprueba: runtime,
hash y catálogo del core, schemas `ingest`/`media`, migraciones aplicadas,
fuentes sembradas, e integridad de claims y auditorías.

## 2. Fuentes y scraping

```bash
npm run cli -- sources:list                  # [✓/✗] slug, tipo, confianza, adapter
npm run cli -- sources:seed                  # re-siembra las 14 filas (idempotente)
```

Solo las fuentes con `enabled=true` y un adapter funcional se descargan.
Para proponer una fuente nueva ver `docs/ADDING_A_SOURCE.md`.

### Scrape de una fuente

```bash
npm run cli -- scrape source rockzuela --all --dry-run   # parsea el crudo guardado: sin red, sin escribir
npm run cli -- scrape source rockzuela --all             # descarga + claims candidatos
npm run cli -- scrape rockzuela --observe                # solo descarga y cachea el crudo
```

`scrape source … --all` recorre la frontera finita del adapter (robots.txt,
un pedido a la vez por fuente, `CRAWL_DELAY_MS` o el `Crawl-delay` de robots
si es mayor, reintentos con backoff 1/2/4 s en red, 5xx y 429), guarda cada
respuesta en `data/raw` + `ingest.raw_pages` y emite claims `low`. Una página
en caché vigente (`CRAWL_CACHE_TTL_DAYS`) no se vuelve a pedir. Repetirlo no
duplica nada: los claims se reutilizan por hash. Sale con código 1 si hubo
errores de descarga.

Los claims web quedan como **candidatos**: entran al catálogo cuando una
persona los aprueba (§4).

### Scrape dirigido a un artista

```bash
npm run cli -- scrape artist "Caramelos De Cianuro" --all-sources --dry-run   # fuentes que recorrería
npm run cli -- scrape artist "Caramelos De Cianuro" --all-sources
```

Abre un run `enrich_artist` y refresca el crudo de cada fuente habilitada
con adapter.

### Fuentes limitadas (evidencia manual)

Hemeroteka (Instagram) no se automatiza. Una persona copia el hallazgo:

```bash
npm run cli -- sources:evidence hemeroteka "https://www.instagram.com/p/CODIGO/" "<extracto>" "notas"
```

No hace fetch ni crea claims: registra la evidencia y abre una revisión.

## 3. YouTube

La hoja `YT Master Spreadsheet.xlsx` es la discografía curada; el canal es la
fuente de verdad para videos. La API es opcional (`YOUTUBE_API_KEY` en `.env`).

### Importar la hoja

```bash
npm run cli -- youtube import-sheet "YT Master Spreadsheet.xlsx"   # idempotente (upload_order + row_hash)
npm run cli -- youtube seed-claims --dry-run
npm run cli -- youtube seed-claims                                 # claims low de la hoja
npm run cli -- youtube classifications --dry-run
npm run cli -- youtube classifications                             # todas las clasificaciones por disco
npm run cli -- youtube unmatched                                   # filas pendientes de enlace o revisión
```

Reimportar la misma hoja no inserta filas; una fila editada se procesa como
cambio incremental.

### Sincronizar el canal (consume cuota)

```bash
npm run cli -- youtube discover-channel --resume   # recorre el playlist de uploads (1 unidad por página)
npm run cli -- youtube sync --pending              # hidrata en lotes de 50 (1 unidad por lote)
npm run cli -- youtube sync-video <video-id>
npm run cli -- youtube sync-channel [channel-id]
npm run cli -- youtube rederive --dry-run          # re-parsea descripciones guardadas: sin red ni cuota
npm run cli -- youtube api-claims --dry-run
npm run cli -- youtube api-claims                  # claims del canal (candidatos)
```

### Enlazar y reconciliar (sin red)

```bash
npm run cli -- yt:link --dry-run
npm run cli -- yt:link                             # solo releases inequívocos; el resto a revisión
npm run cli -- yt:link --album=<id> --video=<youtube-id> --note="evidencia" --confirm
npm run cli -- yt:reconcile --dry-run
npm run cli -- yt:reconcile                        # video ↔ artista, disco y pistas; reports/youtube-reconciliation.*
```

### Buscar discos sin video (100 unidades por búsqueda)

```bash
npm run cli -- yt:enrich-artist "Caramelos De Cianuro" --dry-run   # dice qué buscaría y cuánto cuesta
npm run cli -- yt:enrich-artist "Caramelos De Cianuro" --max=3
```

**Cuota.** YouTube concede 10.000 unidades diarias que se reinician a
medianoche del Pacífico. `YOUTUBE_DAILY_QUOTA_UNITS` fija el presupuesto; el
gasto del día se calcula desde `ingest.scrape_runs` (búsquedas de
`enrich_artist` más lotes y páginas de `yt_api_sync`). `yt:enrich-artist` no
busca si lo gastado no deja margen para una búsqueda y su hidratación
(101 unidades). Un 403 `quotaExceeded` corta el comando sin reintentar; un 429
o 5xx se reintenta hasta 3 veces. El mensaje de error nunca incluye la clave.

## 4. Cola de revisión

Todo lo incierto termina en `ingest.review_queue`. Formas de trabajarla:

```bash
npm run cli -- review list
npm run cli -- review show <id>
npm run cli -- review entities album --limit=50                 # candidatos agrupados por entidad
npm run cli -- review approve album "<identity>" "evidencia revisada"
npm run cli -- review dismiss album "<identity>" "motivo"
npm run cli -- review approve-batch album --source=sincopa --limit=200            # plan
npm run cli -- review approve-batch album --source=sincopa --limit=200 --note="…" --confirm
```

Correcciones del catálogo (todas previsualizan sin `--confirm`):

| Comando | Uso |
|---|---|
| `review duplicates` | Fusiona filas del core que son la misma entidad con otra tilde o mayúscula |
| `review persons --plan=<json>` | Aplica un plan versionado de identidades de personas (`docs/decisions/`); la vista previa se ejecuta y se revierte |
| `review keep-repeated-tracks <ids>` | Conserva dos posiciones con el mismo título en un disco (exige `--note` y `--confirm`) |
| `review sincopa-organizations` | Retira falsos sellos de Sincopa reextrayendo el crudo |
| `review apply-decisions` | Aplica las decisiones concluyentes de la Mesa de Cotejo |

Ambigüedades (discos y personas que podrían ser la misma):

```bash
npm run cli -- ambiguity:scan --dry-run
npm run cli -- ambiguity:scan
npm run cli -- ambiguity:resolve --dry-run            # reglas; --ai consulta DeepSeek (flash)
npm run cli -- ambiguity:apply --review=<id,...> --note="…" --confirm
```

`ambiguity:resolve` nunca toca el core. `ambiguity:apply` aplica solo
MATCH/KEEP; CONFLICT y NEEDS_HUMAN no entran nunca. Tras aplicar, repetir
`scan` y `resolve` sobre el catálogo resultante.

### Fusión de duplicados: qué hace el motor (E11.1, 2026-09-15)

Una fusión (`mergeInto`) corre en una transacción, con run y nota, y ahora:

- **No se bloquea con las revisiones careadas**: una revisión que comparaba las
  dos fichas pierde el lado que desaparece, se cierra si seguía abierta y su
  fila anterior queda en la auditoría (`detachedReviews`).
- **No borra claims nunca**: un claim gemelo (misma fuente, página, campo y
  valor) pierde su destino y queda `superseded` con nota.
- **Mueve por lotes**: un `UPDATE` masivo por tabla/columna; solo las colisiones
  bajan a fila a fila con `SAVEPOINT`.
- **Completa columnas en una sentencia** y respeta los DEFAULT del core como
  «vacío» (`album_type='other'`, `is_venezuelan=false`).
- **Deja rastro para deshacer** (`movedRefs`, `discardedRows`, `detachedReviews`,
  `version: 2` en `merge_audit.new_value`).
- **Une las membresías equivalentes** que la fusión dejó sobre la misma banda
  (`mergeEquivalentMemberships`); si los períodos se contradicen, abre revisión.

Sonda de solo lectura contra la base de desarrollo (fusiona y **revierte** el
par que bloqueaba P1):

```bash
./scripts/with-node22.sh node_modules/.bin/tsx scripts/probes/merge-probe.mts [keepId] [dropId]
```

### Mesa de Cotejo, API y web

```bash
npm run cotejo:build && npm run cotejo:serve   # Mesa en 127.0.0.1:4310 (COTEJO_PORT)
npm run api                                     # API en HOST:PORT (127.0.0.1:8080); OpenAPI en /docs
cd web && npm run build                         # SPA; VITE_API_BASE_URL (por defecto http://127.0.0.1:8080)
```

La Mesa guarda decisiones en `ingest.review_decisions`; decidir no cambia el
catálogo hasta `review apply-decisions --confirm`. La Mesa contiene nombres de
personas sin revisar. Entre el 2026-09-15 y ese mismo día salió también por
Funnel en `/cotejo`, sin autenticación (KI-08 de `docs/FINAL_AUDIT.md`); el
propietario decidió retirarla (`tailscale funnel --https=443 --set-path=/cotejo
off`). Hoy vuelve al diseño original: solo tailnet, puerto 9444
(`tailscale serve --bg --https=9444 http://127.0.0.1:4310`). Quien colabore
desde la Mesa necesita estar en el tailnet.

La API es de lectura abierta. Las escrituras de la web usan cuentas
individuales configuradas únicamente en `.env`. Para añadir o rotar una:

```bash
npm run auth:set-collaborator -- usuario "Nombre visible"
systemctl --user restart crv-api
```

El comando solicita la contraseña sin mostrarla y guarda solo un hash scrypt
con sal. `POST /auth/login` crea una sesión aleatoria en una cookie `HttpOnly`,
`Secure` en HTTPS y `SameSite=Strict`; cada escritura requiere además el token
CSRF efímero. Hay un máximo de cinco intentos fallidos por cuenta e IP cada 15
minutos. Las sesiones duran 12 horas y se invalidan al reiniciar la API.
`CRV_OPERATOR_TOKEN` queda como compatibilidad opcional para scripts internos,
pero debe permanecer vacío si no existe uno. La cuenta autenticada firma cada
transacción y run `manual`, visibles en `GET /runs/:id` y `GET /audit`.

**Publicar el frontend bajo un prefijo de Funnel exige dos variables en el
momento del build**, o la página carga en negro sin ningún error en consola:
el prefijo (`--base=/crv/`, ya lo pasa `build:public`) y `VITE_API_BASE_URL`.
El build público escribe `web/dist-public/`, que es el directorio que sirve
`server.mjs`; `npm run build` (verificación) escribe `web/dist/` y no toca lo
publicado — mezclarlos dejó la página en blanco el 2026-09-16 (un build de
verificación pisó el bundle del Funnel y los assets `/assets/…` no existen
bajo `/crv/`). Tras publicar: `systemctl --user restart crv-web` (y `crv-api`
si cambió el API).

```bash
cd web && npm run build:public   # la API sale sola: /crv/api del mismo origen
```

`build:public` ya pasa `--base=/crv/` a Vite, y con ese prefijo la web habla
con `/crv/api` del mismo origen sin configurar nada (`web/src/lib/api.ts`).
Antes dependía de `VITE_API_BASE_URL`: publicar sin ella dejaba el bundle
apuntando a `http://127.0.0.1:8080` —el equipo del visitante— y nadie podía
iniciar sesión (pasó el 2026-09-15 y el 2026-09-16). Aunque un `.env` traiga
esa dirección de loopback, una página abierta desde un dominio real usa la API
del mismo origen. Además, Funnel recorta
el prefijo configurado antes de reenviar la petición al backend: `/crv` y
`/crv/` le llegan al gateway igual de recortados (`/`), así que un redirect
del lado del servidor no puede distinguirlos. El basename de `BrowserRouter`
en `web/src/main.tsx` se quita la barra final por esto — con la barra,
`react-router` no reconoce `/crv` sin ella y no monta nada (hallazgo del
2026-09-15, corregido).

### Detector de conflictos (Curaduría)

La web (`/curaduria`, solo admin) muestra una pestaña por categoría: nombres
sucios, mal segmentados, ficha de otro tipo, fichas repetidas, datos
incoherentes, valores en disputa, revisión de ingesta, fichas sin vínculos y
**Otros** (lo que ningún detector específico explica). La antigua pestaña
«Cola de revisión» se retiró: sus casos vivos entran en esas categorías y el
detalle sigue en `/curaduria/revision/:id`.

Cuándo analiza:

- tras cada escritura correcta de la API (editar, fusionar, convertir, decidir
  una revisión), agrupando escrituras seguidas en 1,5 s. El resultado aparece
  en «Última corrección verificada»: resueltos, nuevos y **desencadenados por
  la corrección**. Se apaga con `CRV_CURATION_AUTOSCAN=false`;
- cada `CRV_CURATION_WATCH_MS` (60 s; 0 lo apaga) si cambiaron los contadores
  del catálogo, lo que cubre ingestas y la CLI; y al arrancar la API;
- a mano: botón «Analizar ahora» o

```bash
npm run cli -- curation scan            # analiza y guarda
npm run cli -- curation scan --dry-run  # analiza sin guardar
npm run cli -- curation summary
```

«No es un problema» ignora un hallazgo sin tocar el catálogo; no se vuelve a
abrir mientras el valor no cambie. Un hallazgo resuelto que reaparece se
reabre con el mismo id.

## 5. Logs y trazabilidad

| Dónde | Qué |
|---|---|
| stdout del proceso | Logs Pino en JSON (legibles en una terminal). Nivel con `LOG_LEVEL` (`info` por defecto; `debug` para ver cada fetch) |
| `ingest.scrape_runs` | Un run por ejecución: tipo, estado (`running`/`ok`/`partial`/`failed`), parámetros y contadores. `npm run cli -- runs list` |
| `ingest.scrape_errors` | Errores de descarga por URL, con reintentos |
| `ingest.raw_pages` + `data/raw` | Cada respuesta HTTP con su hash: la evidencia de cada claim |
| `ingest.merge_audit` | Cada cambio del core con valor anterior, nuevo, claim y run |
| `reports/` | Informes de `yt:reconcile`, `ambiguity:scan` y `ambiguity:resolve` |

Para conservar los logs de un proceso largo, redirigirlos a un archivo:

```bash
mkdir -p logs
setsid nohup npm run cli -- scrape source sincopa --all > logs/sincopa-$(date +%F).log 2>&1 &
```

Un run que quedó en `running` tras un corte no se reanuda solo: volver a
lanzar el comando reutiliza el crudo en caché y los claims ya persistidos.

Los logs no contienen secretos: la API no registra cabeceras y los errores de
YouTube y DeepSeek omiten la URL con la clave.

## 6. Respaldo

Ver `docs/DATABASE_BACKUP_RESTORE.md`. En resumen: `npm run db:backup` con el
catálogo quieto, `npm run db:restore-check -- backups/<dir>` para probarlo y
`npm run db:restore -- backups/<dir>` para recuperar sin sobrescribir nada.

## 7. Verificación

```bash
npm run lint
npm run typecheck
npm test                    # unit + contrato (levanta PostgreSQL desechables en Docker)
cd web && npm run build
npm run doctor
```

Los tests de contrato nunca usan la base de desarrollo: cada archivo levanta
su propio contenedor.

## 8. Dry-run y confirmación

| Forma | Comandos | Garantía |
|---|---|---|
| `--dry-run` | `scrape source`, `scrape artist`, `youtube seed-claims`/`rederive`/`api-claims`/`classifications`, `yt:link`, `yt:reconcile`, `yt:enrich-artist`, `ambiguity:scan`/`resolve` | Construye el mismo plan sin INSERT/UPDATE, sin red y sin cuota |
| Vista previa hasta `--note` + `--confirm` | `review approve-batch`/`dismiss-batch`, `review duplicates`, `review persons`, `review sincopa-organizations`, `review apply-decisions`, `yt:link --album`, `ambiguity:apply` | Imprime lo que haría; solo con ambas banderas escribe, en transacción, y queda como run con su nota |

`--confirm` exige una nota: queda en el run y en cada auditoría como el motivo
humano del cambio.

## 9. Duplicados, fusiones y búsqueda (E11)

Todo esto se decide con previsualización y deja rastro: ninguna fusión, división
o conversión se ejecuta sin run del operador, claims humanos y auditoría.

### 9.1 Detectar candidatos de duplicado

    crv review person-candidates                          # previsualización
    crv review person-candidates --note="<motivo>" --confirm
    crv review organization-candidates [--min-score=0.45] [--limit=200]

Propone pares explicables (apodo con y sin comillas, alias cruzado, nombre con
contexto, banda o disco en común) y los deja en la cola como `person_duplicate`
u `organization_match`. Repetir la corrida no duplica revisiones y un par
descartado no vuelve a proponerse.

La base de desarrollo es `SQL_ASCII`: las comparaciones de nombres sin tildes se
hacen en TypeScript (`normalizeEntityName`), nunca en SQL.

### 9.2 Revisar y fusionar

- Mesa de cotejo: `/revision` (revisiones `person_duplicate` / `organization_match`).
- Página de duplicados de persona: `/personas/duplicados`.
- Ficha de persona: botón «Fusionar con…»; organizaciones y artistas tienen el
  mismo botón en su ficha.

El modal enseña la previsualización —qué ficha queda (la de más referencias), qué
campos se completan, cuáles se contradicen, qué discos y bandas comparten y qué
avisos merece el par— antes de fusionar. La elección de campos en conflicto se
escribe como corrección humana.

### 9.3 Deshacer una fusión

    POST /merge-runs/:runId/undo   { "note": "<motivo>" }

O el botón «Deshacer esta fusión» que aparece al terminar una fusión (E11.8).
Reinserta lo borrado, repunta lo movido, devuelve las revisiones a su estado y
borra la redirección. Si la ficha que quedó se fusionó después (o una fila movida
ya apunta a otra entidad) responde `409 not_open` y no toca nada. Las
correcciones de campo de la fusión se informan (`fieldsNotReverted`), no se
revierten.

### 9.4 Convertir y dividir personas basura

- Ficha con nombre que no parece de persona (`nameClass` ≠ `ok`): aviso con
  «Convertir en organización…» y «Convertir en artista…» (ficha existente o
  nueva). También `POST /persons/:id/convert`.
- División de una ficha que son varias personas: plan JSON con la operación
  `split` (`docs/decisions/`, mismo formato que las correcciones de identidad).

    crv review persons --plan=<archivo.json>            # simula y deshace
    crv review persons --plan=<archivo.json> --confirm

Cada crédito y membresía se copia hacia cada destino (con `split_from` en la
auditoría) y la ficha combinada se retira: su historia queda en la auditoría de
los destinos.

### 9.5 Buscar y filtrar

- `GET /persons?q=jose` encuentra «José» (índice en memoria, sin tildes): la
  primera llamada no paga la carga porque la API la calienta al arrancar, y
  cualquier escritura la invalida.
- `hasCredits=false` (sin crédito ni membresía), `suspect=<clase>` (nombres
  sospechosos de E11.7) y `sort=credits`; el listado trae `creditCount` y
  `bandCount`.

### 9.6 Verificación visual de la interfaz

Dos herramientas de Playwright, siempre contra contenedores de prueba:

    npm run test:visual-merge      # flujo de duplicados y fusión, 1280 y 400 px

`web/tests/visual/merge-qa.ts` levanta un contenedor, siembra los casos con el
código real (detector + servicio de fusión), arranca API y web en puertos
libres y comprueba: página de duplicados, modal con previsualización (foco
atrapado, Esc cierra), aviso de enlace fusionado, «Fusionar con…» con sesión de
colaborador, sin overflow horizontal ni errores de consola. Deja las capturas
en `docs/ui-qa/merge/`.

Al final del mismo run se invoca la herramienta general de capturas,
`web/tests/visual/capture.mjs`, apuntada a ese contenedor y a 1280/400 px
(capturas en `docs/ui-qa/e11/`). Esa herramienta acepta:

| variable | para qué |
| --- | --- |
| `CRV_WEB_URL` | base de la web a capturar |
| `CRV_CAPTURE_DIR`, `CRV_CAPTURE_MODE` | destino y prefijo de los ficheros |
| `CRV_CAPTURE_ROUTES` | JSON `[[nombre, ruta], …]` (por defecto, fichas de la base de desarrollo) |
| `CRV_CAPTURE_EDIT_ROUTE` | ficha con «Editar» para la captura del formulario |
| `CRV_CAPTURE_VIEWPORTS` | JSON `[{name,width,height}, …]` (por defecto 1440 y 390 px) |
| `CRV_CAPTURE_USERNAME` / `CRV_CAPTURE_PASSWORD` | sesión de colaborador para los formularios |

Sin esas variables el capturador se comporta igual que antes: las rutas y los
tamaños de la base de desarrollo.

### 9.7 Sondas de solo lectura contra la base de desarrollo

    ./scripts/with-node22.sh tsx scripts/probes/person-junk-dryrun.mts
    ./scripts/with-node22.sh tsx scripts/probes/persons-search-probe.mts [q]
    ./scripts/with-node22.sh tsx scripts/probes/merge-probe.mts [keepId] [dropId]

Ninguna escribe: la de fusión revierte siempre su transacción. Sirven para medir
los criterios del plan sin tocar datos reales.
