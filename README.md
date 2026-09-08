# Coleccionistas de Rock Venezolano — DB v1 simplificada

## Archivos
- `crv_simple_v1.dbml`: pegar directamente en https://dbdiagram.io/
- `crv_simple_v1.sql`: PostgreSQL 15+
- `crv_simple_conceptual.svg`: vista simple para discutir el modelo
- `crv_simple_relational.svg`: vista técnica con PK/FK

## Importar en dbdiagram.io
1. Crear un diagrama nuevo.
2. Borrar el ejemplo inicial.
3. Copiar y pegar todo el contenido de `crv_simple_v1.dbml`.
4. dbdiagram.io dibujará las relaciones automáticamente.

## Idea central
`artists -> albums -> tracks`, con `persons` conectadas mediante membresías y créditos.
Las organizaciones representan sellos, estudios y productoras.

---

## Backend (F0+)

Documentación normativa completa en `docs/` (empezar por
`docs/CRV_IMPLEMENTATION_CONTRACT.md` y `docs/PHASES.md`).

Requisitos: Node.js ≥22 (`.nvmrc`) y Docker.

### Puesta en marcha (de cero a `doctor` en verde)

```bash
npm install
npm run db:bootstrap   # .env + PostgreSQL local + core + migraciones + fuentes + doctor
```

`db:bootstrap` es idempotente: crea `.env` desde `.env.example` si falta,
levanta el PostgreSQL de `docker-compose.yml` (puerto **5433**, para no chocar
con otro PostgreSQL local), aplica `crv_simple_v1.sql` **verbatim** solo si la
base aún no tiene el core, corre las migraciones pendientes, siembra
`ingest.sources` y termina con `doctor`.

```bash
npm run typecheck           # tsc --noEmit
npm test                    # Vitest: unit + contrato (levanta PG en Docker)
npm run test:matrix         # harness bash contra PostgreSQL 15 y 16
npm run test:deepseek:real  # opt-in: requiere DEEPSEEK_API_KEY; usa modelos configurados
npm run doctor              # integridad: runtime, core (hash+huella), schemas, migraciones, fuentes
npm run db:up               # solo levantar la base local
npm run db:down             # borrar la base local (incluye el volumen)
npm run db:migrate          # aplica migrations/*.up.sql pendientes contra DATABASE_URL
npm run db:migrate -- down  # rollback completo (desarrollo/test, no operación normal)
npm run cli -- sources:list # resto de comandos del CLI
npm run cli -- sources:evidence hemeroteka "https://www.instagram.com/p/CODIGO/" "<extracto>" # entrada humana; no hace fetch
npm run core:catalog        # regenera la huella del core (solo si el core cambia)
```

**Node:** los scripts npm pasan por `scripts/with-node22.sh`, que antepone un
Node ≥22 de nvm cuando el del PATH no cumple. Hace falta porque bash no lee
`~/.bashrc` en shells no interactivos (cron, CI, hooks, agentes), así que ahí
el PATH puede traer un Node más viejo que `engines.node`. Si no hay ninguno
disponible, el comando falla con instrucciones en vez de correr con la versión
equivocada; `src/config/runtime.ts` repite la comprobación dentro del proceso.

El harness de pruebas bash original (`tests/run_all.sh`,
`tests/test_0004_review_kinds.sh`) sigue vigente y en verde — no depende de
Node, solo de `docker` y `psql` dentro del contenedor.

El servidor HTTP (`src/api/`) llega en **F8**: por eso no hay script `dev`.

El motor de resolución vive en `src/er/` y considera contexto propio de
ARTIST, PERSON, ALBUM, TRACK y ORGANIZATION. `src/merge/` aplica la política
sin sobrescrituras contradictorias silenciosas, y su puente
(`src/merge/relations.ts`) materializa membresías y créditos con la tabla
destino fijada por el tipo de claim, nunca por el rol; `src/conflicts/` y
`src/review/` conservan el desacuerdo, y `src/review/approval.ts` es la
promoción por entidad que una persona ejecuta desde `crv review approve`;
`src/review/batch.ts` deja expresar esa misma decisión sobre un conjunto
(`crv review approve-batch --source=<slug> --note="..." --confirm`) sin
relajar ninguna guarda, respetando el orden de dependencia del core y
dejando el lote registrado como un `merge_run`. DeepSeek está aislado en `src/ai/`: es
opcional, devuelve propuestas JSON validadas con Zod y nunca ejecuta SQL ni
merges. Las biografías generadas son artefactos editoriales separados y
citan los claims aceptados que las sostienen.

Estructura de módulos: ver `docs/ARCHITECTURE.md` §3-4. El core
(`crv_simple_v1.sql`, schema `public`) es inmutable y se verifica en tres
niveles independientes: por **hash del archivo**
(`crv_simple_v1.sql.sha256`), por **diff de `pg_dump`** antes/después de
migrar (tests de contrato) y por **huella del catálogo**
(`src/doctor/core-catalog.json`: 178 objetos — enums, columnas, vistas,
constraints e índices) que `doctor` compara contra la base viva para detectar
alteraciones hechas a mano.
