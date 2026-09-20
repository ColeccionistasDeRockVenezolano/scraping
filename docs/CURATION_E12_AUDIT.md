# Auditoría de cierre · PLAN_CURADURIA E11–E12

Fecha: 2026-09-20  
Rama: `feat/curaduria-e11-e12`  
PR: #2

> Esta auditoría pertenece al plan de Curaduría E11/E12. `docs/FINAL_AUDIT.md` es una instantánea histórica de otro ciclo y no sustituye este cierre.

## Problemas encontrados al auditar E11/E12 contra datos reales

La primera implementación era correcta estructuralmente, pero la foto `catalog-2026-09-16` mostró cinco defectos de cierre:

1. E11 ampliaba la superficie de reglas sin obligar a tener corpus/umbral de precisión.
2. `disco_sin_pistas` añadía 1.670 hallazgos sin acción y degradaba artificialmente el KPI de cobertura.
3. Cuatro E11 localizables estaban marcados globales, retrasando `corregir → verificar → cerrar`.
4. Las pruebas de E11/E12 eran demasiado superficiales y el CLI no tenía contrato unitario.
5. Dos heurísticas producían falsos positivos reales (`Grabaciones Silvestres`, `Record Plant`, `DIESEL`, `MARSHALL`).
6. `/curation/summary` recalculaba cobertura leyendo todos los abiertos en cada polling.

Una segunda vuelta, ya con la parte relacional del catálogo congelada (`relations-2026-09-20.json.gz`), destapó tres más:

7. Los siete detectores relacionales nunca se habían ejecutado contra datos reales. Al hacerlo, `rol_contra_tipo_de_credito` producía **48 falsos positivos de 49** y `alias_que_choca_con_otra_ficha` **4.152 hallazgos** casi enteramente ruido.
8. `alias_que_choca_con_otra_ficha` no respetaba `handledPairs`, a diferencia del resto de los detectores de fichas repetidas: un par ya fusionado o declarado distinto volvía por la puerta del alias.
9. El total de «Abiertos» del panorama sumaba los 1.670 informativos sin decirlo, de modo que la corrección del KPI se leía como una regresión del total.

## Matriz de cierre endurecida

| Requisito | Estado | Evidencia |
|---|---|---|
| 11 detectores E11 | cerrado | `advanced.ts` + prueba de claves/positivos |
| Precisión E11 real | cerrado | corpus 648 casos; los 7 E11 que emiten en la foto real tienen **≥20 decisiones** + umbral ≥90 % |
| Detectores relacionales sobre datos reales | cerrado | foto relacional congelada: 29.310 créditos, 40.207 aliases, 1.367 membresías, 1.020 enlaces |
| Total de abiertos legible | cerrado | `totals.openInformational` en API, tipos y panorama, con contrato que lo fija |
| Regresión de falsos positivos | cerrado | `Grabaciones Silvestres`, `Record Plant`, `DIESEL`, `MARSHALL` etiquetados y protegidos |
| Ruido de `disco_sin_pistas` | cerrado | sigue visible como informativo; excluido del denominador accionable |
| Ciclo dirigido E9/E11 | cerrado | 4 locales / 7 globales + contrato PostgreSQL de cierre dirigido |
| Precisión operativa E12 | cerrado | fórmula separada del corpus; alerta <80 % solo desde n=20 |
| Cobertura ≤N1/≤N2 | cerrado | denominador accionable y `excludedInformational` explícito |
| Lotes | cerrado | `total`, `previewed`, `applied`, `undone` |
| Autocorrección | cerrado | `autoApplied`, `autoReverted` |
| CLI preview | cerrado | parser puro probado + `--preview` obligatorio |
| SQL de métricas | cerrado | contrato con resultados numéricos exactos |
| Coste de polling | cerrado | caché 10 s por pool + exclusión temprana de informativos |
| UI/API/tipos | cerrado | esquema Zod, tipos web y panorama sincronizados |

## Resultado de calibración

Sobre la misma foto real:

| Detector | Antes | v6 |
|---|---:|---:|
| `organizacion_sin_clasificar` | 60 | 21 |
| `mayusculas_sostenidas` | 26 | 1 |
| `disco_sin_pistas` | 1.670 accionando contra el KPI | 1.670 informativos, fuera del KPI |
| `pistas_sin_duracion_en_disco_con_duraciones` | 56 | 56 |
| `rol_contra_tipo_de_credito` | 49 (48 falsos) | 1 (real) |
| `alias_que_choca_con_otra_ficha` | 4.152 | 62 |
| `creditos_duplicados` | 57 | 57 (filas idénticas, comprobado en la base) |

No se redujo `disco_sin_pistas` ocultando datos: se corrigió su semántica. La ausencia de tracklist continúa visible para completar el catálogo, pero ya no se presenta como si existiera una corrección N1/N2 que no existe.

## Pruebas de aceptación

Verificado en local sobre la v6, y reverificado por CI antes de fusionar:

- TypeScript: PASS.
- ESLint: PASS.
- Unitarias: **44 archivos, 382 tests PASS**.
- Contratos de curaduría contra PostgreSQL real: PASS (`curation-metrics`, `curation-e11-local`).
- Web tipos/build: PASS.

Los contratos añadidos prueban específicamente valores de E12 y el cierre dirigido E11; no se limita a comprobar que un endpoint devuelve 200.

## Límites explícitos

- Esta auditoría valida el repositorio y PostgreSQL desechable de CI; no afirma el estado de una base desplegada fuera del repositorio.
- Cuatro detectores relacionales (`periodo_de_membresia_imposible`, `sello_que_es_artista`, `redireccion_en_cadena`, `enlace_de_medio_a_ficha_fusionada`) emiten **0** sobre la foto real: el catálogo solo tiene 2 redirecciones y 53 discos con sello. Están cubiertos por pruebas sintéticas y su precisión sobre datos reales sigue sin medirse; la guardia del corpus los exigirá en cuanto empiecen a emitir.
- Las etiquetas nuevas del corpus las puso quien implementó las reglas, no el propietario del catálogo. Conviene repasar a ojo las 21 de `organizacion_sin_clasificar` y las 20 de `alias_que_choca_con_otra_ficha` antes de apoyarse en esos umbrales para futuras reglas.
- La foto relacional se tomó el 20/09 y las fichas el 16/09. En ese intervalo el catálogo solo perdió 2 personas por fusión, así que las dos mitades se corresponden; si la distancia crece, hay que volver a tomar las dos juntas.
- Una alerta operacional de precisión requiere 20 decisiones; el porcentaje se sigue mostrando por debajo de ese tamaño, sin convertirlo en alarma.

## Criterio de cierre

Los puntos que mantenían el PR en 15/20 quedan convertidos en condiciones verificables por CI: precisión mínima, semántica de accionabilidad, alcance local/global, negativos reales, métricas SQL exactas, seguridad del CLI y ciclo de cierre dirigido. El código validado por CI #98 está verde; cualquier commit documental posterior debe conservar el mismo gate antes de fusionar.
