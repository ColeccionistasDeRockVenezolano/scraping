# CRV · E11.5 — Detector de candidatos de persona: dry-run contra la base de desarrollo

- **Fecha:** 2026-09-16 · **Comando:** `crv review person-candidates --limit=1000` (solo lectura; **no** se ejecutó `--confirm`).
- **Base:** desarrollo `127.0.0.1:5433/crv` (10.248 personas, 10.099 alias). La base **no** tiene aplicadas 0014–0016
  (leer no las necesita: el detector compara nombres y relaciones en TypeScript y lee `review_queue.kind::text`).
- **Tiempo:** 1,76 s (primer arranque en frío; umbral del plan: < 20 s).

## Resultado

- **173 pares propuestos** (umbral ≥ 0,45) entre **10.248 personas**; 471 pares llegaron a compararse
  (los que comparten alguna clave de bloqueo; las claves con más de 25 personas se descartan).
- Prioridad 3 (score ≥ 0,60): **162** · prioridad 6 (0,45–0,59): **11**.
- Score 1,000: 156 · entre 0,60 y 0,99: 6 · entre 0,45 y 0,59: 11.

Señales más frecuentes (un par puede llevar varias):

| Señal | Pares |
|---|---:|
| `alias_cross` (un nombre es alias del otro) | 162 |
| `jaro_winkler` (≥ 0,92 sobre el nombre sin apodo) | 170 |
| `nickname_equal` (apodo entre comillas) | 156 |
| `shared_album` (discos acreditados compartidos) | 19 |
| `first_last_equal` (primer y último token) | 16 |
| `shared_band` (bandas compartidas) | 1 |
| `middle_name_clash` (segundo nombre distinto, resta) | 1 |

## Acceptación del plan

| Criterio | Resultado |
|---|---|
| Propone ≥ 100 pares | **173** |
| Incluye el par `14 / 3617` («Carlos "Nene" Quintero» / «Carlos Quintero») | **sí** (score 1,000, `nickname_equal` + `alias_cross` + `jaro_winkler` + `shared_album`) |
| Incluye el par `300 / 133` («Manuel Macías» / «Manuel "Manolo" Macías») | **sí** (score 1,000) |
| No incluye pares de estudios/sellos | **sí**: 0 coincidencias de `studio|estudio|records|producciones` en los 173 pares (bloqueo `organization_like`) |
| Tarda < 20 s | **1,76 s** |

## Muestra (extremos y casos con contexto)

### Prioridad 3 (score ≥ 0,60)

| Score | Prioridad | Persona A | Persona B | Señales |
|---:|---:|---|---|---|
| 1.000 | 3 | 5 «José Velásquez "El Patuo"» | 5993 «José Velásquez» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 14 «Carlos "Nene" Quintero» | 3617 «Carlos Quintero» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15, shared_album=0.15 |
| 1.000 | 3 | 29 «Rubén "Micho" Correa» | 5948 «Rubén Correa "Micho"» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 112 «Alejandro Estrada» | 859 «Alejandro Estrada "Alz"» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 113 «Carlos Astros» | 861 «Carlos Astros "Carlz"» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 120 «Alejandro "Chonto" Turola» | 1012 «Alejandro Turola "Chonto"» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 123 «Kevin Lovera "Kev"» | 3779 «Kevin Lovera» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 133 «Manuel Macías» | 300 «Manuel "Manolo" Macías» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 167 «José Rodríguez» | 1112 «José "Cheo" Rodríguez» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 167 «José Rodríguez» | 6072 «José "Pepe" Rodríguez» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 218 «Carlos Alvarez» | 6861 «Carlos "Chars" Alvarez» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 223 «Annabella Almenar» | 2033 «Annabella Almenar "Bélica"» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 294 «Interamericana De Grabaciones» | 8371 «Interamericana de Grabaciones (Integra)» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 307 «Julio Rojas» | 1373 «Julio Rojas "Colmillo"» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |
| 1.000 | 3 | 310 «Ricardo "Ziggy" Anthes» | 3053 «Ricardo Anthés» | nickname_equal=0.45, alias_cross=0.45, jaro_winkler=0.15 |

### Prioridad 6 (0,45 ≤ score < 0,60)

| Score | Prioridad | Persona A | Persona B | Señales |
|---:|---:|---|---|---|
| 0.547 | 6 | 2435 «Ezequiel Serrano C.» | 2892 «Ezequiel Serrano» | first_last_equal=0.25, jaro_winkler=0.14667, shared_album=0.15 |
| 0.546 | 6 | 1915 «Interamericana De Grabaciones S.A» | 8371 «Interamericana de Grabaciones (Integra)» | first_last_equal=0.25, jaro_winkler=0.14636, shared_album=0.15 |
| 0.546 | 6 | 1061 «Gelson Briceño» | 1357 «Gelson Briceño L» | first_last_equal=0.25, jaro_winkler=0.14625, shared_album=0.15 |
| 0.546 | 6 | 1258 «Gabriel Arbiza» | 1259 «Gabriel Arbiza Z.» | first_last_equal=0.25, jaro_winkler=0.14625, shared_album=0.15 |
| 0.546 | 6 | 5311 «Enrique Rincón C.» | 9155 «Enrique Rincón» | first_last_equal=0.25, jaro_winkler=0.14625, shared_album=0.15 |

### Casos solo por nombre y apellido (sin apodo ni alias)

| Score | Prioridad | Persona A | Persona B | Señales |
|---:|---:|---|---|---|
| 0.850 | 3 | 2367 «Victor Gámez» | 11896 «Víctor Gámez» | alias_cross=0.45, first_last_equal=0.25, jaro_winkler=0.15 |
| 0.850 | 3 | 4189 «Carlos Rondon» | 7443 «Carlos Rondón» | alias_cross=0.45, first_last_equal=0.25, jaro_winkler=0.15 |
| 0.850 | 3 | 8696 «Cesar Jaime» | 9172 «César Jaime» | alias_cross=0.45, first_last_equal=0.25, jaro_winkler=0.15 |
| 0.700 | 3 | 608 «Carlos Eduardo "Cayayo" Troconis» | 9462 «Carlos Troconis» | alias_cross=0.45, first_last_equal=0.25 |
| 0.700 | 3 | 2902 «José Leonardo "Pepeleo" Hernández» | 5084 «José Hernández» | alias_cross=0.45, first_last_equal=0.25 |

Salida completa: 173 líneas + cabecera de total; el comando imprime una línea por par con la misma forma que
las tablas de arriba. **Nada se escribió** (sin `--confirm`, el CLI no abre revisiones).
