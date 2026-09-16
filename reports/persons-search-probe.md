# Búsqueda de personas sin tildes — sonda (E11.9)

Sonda de **solo lectura** contra la base de desarrollo (`127.0.0.1:5433/crv`):
`./scripts/with-node22.sh node_modules/.bin/tsx scripts/probes/persons-search-probe.mts`.
Usa el mismo repositorio que la ruta `GET /persons?q=…`, así que mide el camino
real (índice en memoria + SQL).

## Por qué un índice en memoria

La base es `SQL_ASCII`: `lower('ÁNGEL')` sigue devolviendo `Ángel` y
`ILIKE '%jose%'` no encuentra «José» (regla 0.1.11 del plan). Cargar nombres y
alias (dos SELECT por entidad, ~1 MB para 10 248 personas) y filtrar en Node es
más barato y exacto que cualquier truco en SQL.

## Medición

| medición | tiempo |
| --- | ---: |
| carga de los tres índices (una vez, en el arranque) | 259 ms |
| `q=jose` — 1.ª consulta | 26 ms |
| `q=jose` — 2.ª consulta | 7 ms |
| `q=jose` — 3.ª consulta | 5 ms |
| **criterio del plan** | **< 300 ms** |

`RESULTADO: OK` (peor tiempo 26 ms). Coincidencias para `jose`: **300** fichas,
encabezadas por las que empiezan por la consulta:

    25 «"Joseito" Rodríguez» | José ‘Zoundcolector’ Parra | José "Cebolla" Briceño | José "Chego" Cabrices | José "Chema" Arias

La carga del índice es un coste de arranque que la API ya no le pasa a nadie:
`buildApp()` llama a `warmSearchIndex()` en segundo plano (sin bloquear el
`listen`) y `invalidateSearchIndex()` vacía la caché al terminar cualquier run
del operador, una fusión en lote o un plan de correcciones. Por eso la primera
consulta de una persona real cuesta milisegundos, no los ~900 ms que costaba
antes de añadir el calentamiento.

## Qué cubre el índice

- **Personas, artistas y organizaciones** por nombre y por alias (el alias
  participa, como pedía §E7A).
- Alias propios y variantes ortográficas: `normalizeEntityName` pliega tildes,
  mayúsculas, apodos entre comillas/paréntesis y espacios.
- Orden: primero los que **empiezan** por la consulta; luego por nombre.
- Álbumes y pistas siguen con `ILIKE` a propósito: el índice es de nombres de
  entidad y su normalización (artículos, apodos) no aplica a títulos.

## Filtros del listado (misma etapa)

`GET /persons` gana `hasCredits` (`false` = sin crédito ni membresía),
`suspect` (las cuatro clases de E11.7), `sort=credits` (créditos + membresías,
descendente) y devuelve `creditCount` y `bandCount` por fila, además de la
clasificación del nombre (`nameClass`, `nameClassReason`). El filtro de
sospechosas se resuelve en Node con el mismo clasificador que el aviso de la
ficha: un solo veredicto para la API, la web y el plan.
