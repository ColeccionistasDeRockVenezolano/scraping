#!/usr/bin/env bash
# ============================================================================
# CRV · Prueba específica de la migración 0004_review_kinds contra un
# PostgreSQL desechable. Verifica:
#   1. up: el enum queda con los 16 valores esperados, en orden
#   2. los 8 kinds de 0004 son USABLES en ingest.review_queue
#   3. up re-aplicado directamente = idempotente (ADD VALUE IF NOT EXISTS)
#   4. down CON filas usando kinds de 0004 = ABORTA sin destruir datos
#   5. down sin esas filas = enum vuelve a los 8 valores de 0003
#   6. tras el down, un kind de 0004 se rechaza y uno de 0003 se acepta
#   7. down re-ejecutado = no-op
#   8. up de nuevo tras el rollback = 16 valores
#   9. el schema public (core) queda intacto en todo el proceso
# Limpieza automática del contenedor al salir.
#
# Uso: bash tests/test_0004_review_kinds.sh
#   PG_WAIT_TIMEOUT=<seg>  espera máxima al arranque de PostgreSQL (120 s)
# ============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/tests/lib_pg.sh"

WORK="$(mktemp -d)"
CTR="crv-pg-0004-$((RANDOM % 9000 + 1000))-$((RANDOM % 9000 + 1000))"
cleanup() { docker rm -f "$CTR" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

KINDS_0003="possible_duplicate field_conflict ambiguous_alias album_match \
person_match organization_match youtube_match manual_review"
KINDS_0004="missing_url seed_incomplete media_type_no_album genre_unknown \
new_source low_confidence ai_biography ai_entity_resolution"

PASS=0
FAIL=0
ok()  { printf '   ✓ %s\n' "$1"; PASS=$((PASS + 1)); }
bad() { printf '   ✗ %s\n' "$1"; FAIL=$((FAIL + 1)); }
assert_eq() {  # <esperado> <obtenido> <descripción>
  if [[ "$1" == "$2" ]]; then
    ok "$3"
  else
    bad "$3"
    printf '       esperado: %s\n       obtenido: %s\n' "$1" "$2"
  fi
}

q()      { docker exec -i "$CTR" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -tA -c "$1"; }
f()      { docker exec -i "$CTR" psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q -f - < "$1"; }
labels() { q "SELECT string_agg(e.enumlabel::text, ' ' ORDER BY e.enumsortorder)
              FROM pg_enum e
              JOIN pg_type t ON t.oid = e.enumtypid
              JOIN pg_namespace n ON n.oid = t.typnamespace
             WHERE n.nspname = 'ingest' AND t.typname = 'review_kind'"; }
snapshot() { docker exec "$CTR" pg_dump -U postgres -d postgres \
               --schema=public --schema-only > "$1"; }

echo "== contenedor desechable: $CTR ($PG_IMAGE) =="
pg_start "$CTR" || exit 1
echo "   PostgreSQL $(q 'SHOW server_version;')"

echo
echo "== 0. Verificación de hash + Core canónico + snapshot de public =="
verify_core_hash "$ROOT" || exit 1
echo "   hash coincide con crv_simple_v1.sql.sha256 ✓"
f "$ROOT/crv_simple_v1.sql"
snapshot "$WORK/before.sql"
pg_dump_filter "$WORK/before.sql" > "$WORK/before.filt"
echo "   core aplicado y snapshot guardado ($(wc -l < "$WORK/before.filt") líneas)"

echo
echo "== 1. Migraciones 0001..0004 y valores del enum =="
"$ROOT/tests/migrate.sh" "$CTR" "$ROOT/migrations" | sed 's/^/   /'
assert_eq "$(echo $KINDS_0003 $KINDS_0004)" "$(labels)" \
          "ingest.review_kind tiene los 16 valores esperados, en orden"

echo
echo "== 2. Los 8 kinds de 0004 son usables en review_queue =="
for k in $KINDS_0004; do
  if q "INSERT INTO ingest.review_queue(kind) VALUES ('$k')" >/dev/null 2>&1; then
    ok "INSERT kind='$k'"
  else
    bad "INSERT kind='$k' fue rechazado"
  fi
done
assert_eq "8" "$(q 'SELECT count(*) FROM ingest.review_queue')" \
          "review_queue contiene las 8 filas insertadas"

echo
echo "== 3. up re-aplicado directamente (idempotencia DDL) =="
if f "$ROOT/migrations/0004_review_kinds.up.sql" 2>/dev/null; then
  ok "0004_review_kinds.up.sql re-aplicado sin error"
else
  bad "0004_review_kinds.up.sql falló al re-aplicarse"
fi
assert_eq "$(echo $KINDS_0003 $KINDS_0004)" "$(labels)" \
          "el enum sigue con los mismos 16 valores"

echo
echo "== 4. down CON filas usando kinds de 0004 -> debe ABORTAR =="
if f "$ROOT/migrations/0004_review_kinds.down.sql" > "$WORK/down.out" 2>&1; then
  bad "el down NO abortó (habría destruido datos)"
else
  ok "el down abortó como se esperaba"
  if grep -q 'No se puede revertir 0004' "$WORK/down.out"; then
    ok "el error identifica la causa"
    printf '       %s\n' "$(grep -o 'ingest.review_queue.kind -> .*' "$WORK/down.out" | cut -c1-96)"
  else
    bad "el error no menciona el motivo esperado"
    sed 's/^/       /' "$WORK/down.out" | head -5
  fi
fi
assert_eq "8" "$(q 'SELECT count(*) FROM ingest.review_queue')" \
          "las 8 filas siguen intactas tras el intento fallido"
assert_eq "$(echo $KINDS_0003 $KINDS_0004)" "$(labels)" \
          "el enum no fue modificado por el down abortado"

echo
echo "== 5. down tras resolver las revisiones =="
q "DELETE FROM ingest.review_queue" >/dev/null
if f "$ROOT/migrations/0004_review_kinds.down.sql" 2>/dev/null; then
  ok "0004_review_kinds.down.sql aplicado sin error"
else
  bad "el down falló con la tabla vacía"
fi
assert_eq "$(echo $KINDS_0003)" "$(labels)" \
          "el enum vuelve a los 8 valores de 0003"

echo
echo "== 6. Efecto real del rollback sobre los INSERT =="
if q "INSERT INTO ingest.review_queue(kind) VALUES ('missing_url')" >/dev/null 2>&1; then
  bad "un kind de 0004 sigue siendo aceptado tras el rollback"
else
  ok "un kind de 0004 ('missing_url') es rechazado"
fi
if q "INSERT INTO ingest.review_queue(kind) VALUES ('possible_duplicate')" >/dev/null 2>&1; then
  ok "un kind de 0003 ('possible_duplicate') sigue aceptándose"
else
  bad "un kind de 0003 fue rechazado tras el rollback"
fi
q "DELETE FROM ingest.review_queue" >/dev/null

echo
echo "== 7. down re-ejecutado (idempotente) =="
if f "$ROOT/migrations/0004_review_kinds.down.sql" 2>/dev/null; then
  ok "el down re-ejecutado es un no-op sin error"
else
  bad "el down falló al re-ejecutarse"
fi

echo
echo "== 8. up de nuevo tras el rollback =="
f "$ROOT/migrations/0004_review_kinds.up.sql" 2>/dev/null
assert_eq "$(echo $KINDS_0003 $KINDS_0004)" "$(labels)" \
          "el enum vuelve a tener los 16 valores"

echo
echo "== 9. El core (schema public) sigue intacto =="
snapshot "$WORK/after.sql"
pg_dump_filter "$WORK/after.sql" > "$WORK/after.filt"
if diff -u "$WORK/before.filt" "$WORK/after.filt" > "$WORK/core.diff"; then
  ok "diff de public VACÍO: el core no fue alterado"
else
  bad "EL CORE CAMBIÓ"
  head -20 "$WORK/core.diff" | sed 's/^/       /'
fi

echo
echo "════════════════════════════════════════════════════════════════"
if (( FAIL == 0 )); then
  echo "TODO VERDE para 0004_review_kinds: $PASS comprobaciones correctas."
  echo "════════════════════════════════════════════════════════════════"
else
  echo "FALLOS en 0004_review_kinds: $FAIL de $((PASS + FAIL)) comprobaciones."
  echo "════════════════════════════════════════════════════════════════"
  exit 1
fi
