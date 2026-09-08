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

Requisitos: Node.js ≥22, Docker (para PostgreSQL desechable de test).

```bash
npm install
npm run typecheck          # tsc --noEmit
npm test                   # Vitest: unit + contrato (levanta PG en Docker)
npm run doctor              # integridad: core (hash+catálogo), schemas, migraciones, fuentes
npm run db:migrate          # aplica migrations/*.up.sql pendientes contra DATABASE_URL
npm run db:migrate -- down  # rollback completo (desarrollo/test, no operación normal)
```

Copiar `.env.example` a `.env` y ajustar `DATABASE_URL` antes de `db:migrate`/`doctor`
contra una base real. El harness de pruebas bash original
(`tests/run_all.sh`, `tests/test_0004_review_kinds.sh`) sigue vigente y en
verde — no depende de Node, solo de `docker` y `psql` dentro del contenedor.

Estructura de módulos: ver `docs/ARCHITECTURE.md` §3-4. El core
(`crv_simple_v1.sql`, schema `public`) es inmutable y se verifica por hash
(`crv_simple_v1.sql.sha256`) en cada ejecución de los tests de contrato.
