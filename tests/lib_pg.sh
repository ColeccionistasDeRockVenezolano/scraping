#!/usr/bin/env bash
# ============================================================================
# CRV · Utilidades compartidas para pruebas contra un PostgreSQL desechable.
# Se usa con `source`; no se ejecuta directamente. Requiere docker.
#
#   source "$ROOT/tests/lib_pg.sh"
#   pg_start "$CTR" || exit 1
#
# Variables de entorno:
#   PG_IMAGE          imagen a usar (por defecto postgres:16-alpine)
#   PG_WAIT_TIMEOUT   segundos máximos de espera al arranque (por defecto 120)
# ============================================================================

PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
PG_WAIT_TIMEOUT="${PG_WAIT_TIMEOUT:-120}"

# ---------------------------------------------------------------------------
# Espera robusta a que PostgreSQL esté REALMENTE listo.
#
# La imagen oficial arranca en dos fases: primero un servidor TEMPORAL con
# listen_addresses='' (solo socket unix) para ejecutar initdb y los scripts de
# init, y después lo apaga y levanta el definitivo. Medido en este entorno:
#
#     t=+2.0s   socket unix: SÍ   TCP: NO    <- servidor temporal
#     t=+2.0s   socket unix: NO   TCP: NO    <- apagándose
#     t=+3.0s   socket unix: SÍ   TCP: SÍ    <- servidor definitivo
#
# Sondear el socket unix da un falso positivo en la primera fase y el psql
# siguiente falla con "FATAL: the database system is shutting down".
#
# El servidor temporal nunca escucha en TCP, así que se espera por TCP y,
# además, se exige una consulta real y dos sondas consecutivas correctas.
# ---------------------------------------------------------------------------
wait_for_pg() {
  local ctr="${1:?uso: wait_for_pg <contenedor>}"
  local deadline=$(( SECONDS + PG_WAIT_TIMEOUT ))
  local streak=0

  while (( SECONDS < deadline )); do
    if [[ "$(docker inspect -f '{{.State.Running}}' "$ctr" 2>/dev/null)" != "true" ]]; then
      echo "ERROR: el contenedor $ctr dejó de correr durante el arranque"
      docker logs --tail 30 "$ctr" 2>&1 | sed 's/^/     /'
      return 1
    fi

    if docker exec "$ctr" pg_isready -h 127.0.0.1 -p 5432 -U postgres -q >/dev/null 2>&1 &&
       docker exec "$ctr" psql -h 127.0.0.1 -U postgres -d postgres -tAq \
         -c 'SELECT 1' >/dev/null 2>&1
    then
      streak=$(( streak + 1 ))
      if (( streak >= 2 )); then
        return 0
      fi
    else
      streak=0          # una sonda fallida invalida la racha (fase temporal)
    fi

    sleep 1
  done

  echo "ERROR: PostgreSQL no aceptó conexiones TCP en ${PG_WAIT_TIMEOUT}s"
  docker logs --tail 30 "$ctr" 2>&1 | sed 's/^/     /'
  return 1
}

# Lanza el contenedor y espera a que esté listo.
pg_start() {
  local ctr="${1:?uso: pg_start <contenedor>}"
  docker run -d --name "$ctr" -e POSTGRES_HOST_AUTH_METHOD=trust "$PG_IMAGE" >/dev/null
  wait_for_pg "$ctr"
}

# Filtra las líneas \restrict/\unrestrict de pg_dump, que llevan una clave
# aleatoria por dump y no representan objetos de base de datos.
pg_dump_filter() {
  grep -vE '^\\(un)?restrict' "${1:?uso: pg_dump_filter <archivo>}"
}
