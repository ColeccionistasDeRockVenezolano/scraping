#!/usr/bin/env bash
# ============================================================================
# CRV · Prueba completa de las migraciones auxiliares contra PostgreSQL 15+
# (desechable). Verifica:
#   0. hash de crv_simple_v1.sql contra crv_simple_v1.sql.sha256 (integridad)
#   1. core crv_simple_v1.sql aplicado primero
#   2. todas las migraciones migrations/*.up.sql (harness) — 1ª pasada
#   3. migraciones (harness) — 2ª pasada = no-op (mecanismo normal)
#   4. re-aplicación directa de los .up.sql = idempotencia DDL
#   5. fixtures válidos
#   6. tests negativos de constraints/FK (esperan fallos concretos)
#   7. queries de verificación (valores contradictorios, N:N, ocurrencias)
#   8. diff del schema public antes/después = VACÍO (core intacto)
#   9. listado de objetos nuevos
#  13. rollback completo (*.down.sql en orden inverso) + diff vacío
# Limpieza automática del contenedor al salir.
#
# Uso: bash tests/run_all.sh
#   PG_WAIT_TIMEOUT=<seg>  segundos máximos de espera al arranque de
#                          PostgreSQL (por defecto 120).
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/tests/artifacts"
mkdir -p "$OUT"

CTR="crv-pg-test-$((RANDOM % 9000 + 1000))-$((RANDOM % 9000 + 1000))"
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; }
trap cleanup EXIT

# Arranque del contenedor y espera robusta: ver tests/lib_pg.sh
# (la imagen oficial levanta un servidor temporal solo-socket antes del real).
source "$ROOT/tests/lib_pg.sh"

echo "== contenedor desechable: $CTR ($PG_IMAGE) =="
pg_start "$CTR" || exit 1

VERSION="$(docker exec "$CTR" psql -U postgres -d postgres -tA -c 'SHOW server_version;')"
echo "   PostgreSQL $VERSION"

psql_file() { docker exec -i "$CTR" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < "$1"; }

echo
echo "== 0. Verificación de integridad de crv_simple_v1.sql (hash) =="
verify_core_hash "$ROOT" || exit 1
echo "   hash coincide con crv_simple_v1.sql.sha256 ✓"

echo
echo "== 1. CORE canónico (crv_simple_v1.sql) =="
psql_file "$ROOT/crv_simple_v1.sql"
echo "   core aplicado ✓"

echo
echo "== 2. Snapshot del schema public (core) ANTES de migrar =="
docker exec "$CTR" pg_dump -U postgres -d postgres --schema=public --schema-only > "$OUT/core_before.sql"
echo "   guardado: tests/artifacts/core_before.sql ($(wc -l < "$OUT/core_before.sql") líneas)"

echo
echo "== 3. Migraciones (harness schema_migrations) — 1ª pasada =="
"$ROOT/tests/migrate.sh" "$CTR" "$ROOT/migrations"

echo
echo "== 4. Migraciones (harness) — 2ª pasada (debe ser no-op) =="
"$ROOT/tests/migrate.sh" "$CTR" "$ROOT/migrations"

echo
echo "== 5. Re-aplicación directa de los .up.sql (idempotencia DDL) =="
for f in "$ROOT"/migrations/*.up.sql; do
  psql_file "$f"
  echo "   re-aplicado sin errores: $(basename "$f") ✓"
done

echo
echo "== 6. Fixtures válidos =="
psql_file "$ROOT/tests/fixtures_ok.sql"
echo "   fixtures insertados ✓"

echo
echo "== 7. Tests negativos de constraints/FK =="
psql_file "$ROOT/tests/constraints_negative.sql" 2>&1 | grep -E 'PASS|FAIL|ERROR' || true

echo
echo "== 8. Queries de verificación =="
docker exec -i "$CTR" psql -U postgres -d postgres -q -f - < "$ROOT/tests/verify_queries.sql" \
  | tee "$OUT/verify_output.txt"

echo
echo "== 9. Snapshot del schema public (core) DESPUÉS + diff =="
docker exec "$CTR" pg_dump -U postgres -d postgres --schema=public --schema-only > "$OUT/core_after.sql"
# Las líneas \restrict/\unrestrict de pg_dump llevan una clave aleatoria por
# dump: se excluyen del diff (no representan objetos de base de datos).
grep -vE '^\\(un)?restrict' "$OUT/core_before.sql" > "$OUT/core_before.filt"
grep -vE '^\\(un)?restrict' "$OUT/core_after.sql"  > "$OUT/core_after.filt"
if diff -u "$OUT/core_before.filt" "$OUT/core_after.filt" > "$OUT/core.diff"; then
  echo "   DIFF VACÍO: el schema public (core) NO fue alterado ✓"
else
  echo "   *** EL CORE CAMBIÓ *** (ver tests/artifacts/core.diff)"
  exit 1
fi

echo
echo "== 10. Objetos nuevos (tablas) =="
docker exec "$CTR" psql -U postgres -d postgres -c '\dt ingest.*' -c '\dt media.*'

echo
echo "== 11. Objetos nuevos (enums) =="
docker exec "$CTR" psql -U postgres -d postgres -tA -c \
  "SELECT n.nspname||'.'||t.typname FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace
   WHERE n.nspname IN ('ingest','media') AND t.typtype='e' ORDER BY 1;"

echo
echo "== 12. Vista de integridad: FKs de auxiliares hacia core =="
docker exec "$CTR" psql -U postgres -d postgres -tA -c \
  "SELECT conrelid::regclass AS tabla, confrelid::regclass AS referencia
   FROM pg_constraint
   WHERE contype='f'
     AND (conrelid::regclass::text LIKE 'ingest.%' OR conrelid::regclass::text LIKE 'media.%')
   ORDER BY 1,2;"

echo
echo "== 13. Rollback completo (down migrations en orden inverso) =="
mapfile -t DOWNS < <(ls -r "$ROOT"/migrations/*.down.sql)
for f in "${DOWNS[@]}"; do
  echo "   down: $(basename "$f")"
  psql_file "$f"
done
echo "   schemas restantes:"
docker exec "$CTR" psql -U postgres -d postgres -tA -c \
  "SELECT nspname FROM pg_namespace WHERE nspname IN ('ingest','media');" | sed 's/^/     /' || true
docker exec "$CTR" pg_dump -U postgres -d postgres --schema=public --schema-only > "$OUT/core_after_rollback.sql"
grep -vE '^\\(un)?restrict' "$OUT/core_after_rollback.sql" > "$OUT/core_rollback.filt"
if diff -u "$OUT/core_before.filt" "$OUT/core_rollback.filt" > "$OUT/core_rollback.diff"; then
  echo "   DIFF VACÍO tras rollback: core intacto ✓"
else
  echo "   *** EL CORE CAMBIÓ TRAS ROLLBACK ***"
  exit 1
fi

echo
echo "════════════════════════════════════════════════════════════════"
echo "TODO VERDE: core intacto, migraciones aplicadas (2x) e idempotentes,"
echo "constraints verificadas, datos contradictorios conservados,"
echo "rollback reversible verificado."
echo "════════════════════════════════════════════════════════════════"
