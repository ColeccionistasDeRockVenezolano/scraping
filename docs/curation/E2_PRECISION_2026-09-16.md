# Precisión y decisiones duraderas — Curaduría E2 (base 2026-09-16 · cierre v3 2026-09-19)

Etapa **E2** de `~/Desktop/PLAN_CURADURIA_20_DE_20.md` (cierra A5, A6, B1, B2, B3, B5, M3, M4).
La medición real sobre desarrollo se hizo con `curation-rules.v2`; el cierre 20/20 actual usa
`curation-rules.v3`, migración `0020_curation_durable_decisions`.

## 0. Cierre 20/20 con `curation-rules.v3`

La v3 conserva los arreglos y la reducción real de v2 documentados abajo y cierra el criterio global de
**precisión mínima del 90 % por detector**. `test/unit/curation-precision.test.ts` analiza la foto congelada
del mismo catálogo de desarrollo (`catalog-2026-09-16.json.gz`) y ahora exige que **todo detector etiquetado**
tenga un umbral registrado `>= 0.90`, además de mantener todos los verdaderos positivos y evitar la
reaparición de falsos positivos ya corregidos.

Los siete detectores que quedaban por debajo del 90 % en v2 se endurecieron en v3:

| Detector | Umbral v3 | Falso positivo que queda protegido |
|---|---:|---|
| `anio_titulo_contra_publicacion` | 0,90 | material de archivo / grabación en vivo cuyo año del título no es el de publicación |
| `anomalia_del_catalogo` | 0,90 | puntuación legítima, apóstrofos tipográficos, cifras y coma en nombres reales |
| `artista_es_organizacion` | 0,90 | nombres artísticos que contienen vocabulario débil de organización |
| `organizaciones_equivalentes` | 0,90 | entidades distintas como «Capitol Studios» y «Capitol Records» |
| `palabras_pegadas` | 0,90 | marcas/estudios estilizados frente a nombres realmente pegados |
| `signos_sin_cerrar` | 0,90 | pulgadas escritas como `7"` / `12"` |
| `varias_personas_en_una` | 0,90 | nombres/títulos con «y» que no representan dos personas |

`pistas_repetidas` mantiene su umbral de 0,94 y los demás detectores etiquetados permanecen en 1,00.

**Evidencia de aceptación:** el `--dry-run` real requerido por E2 se ejecutó y documentó con v2 (sección 1);
v3 no sustituye esos arreglos A6 ni escribe en desarrollo: añade filtros de precisión comprobados contra la
foto congelada exacta de esa base. En CI, la puerta «Calidad» ejecuta el corpus completo y falla si cualquier
detector cae por debajo del 90 %.

Contra la base de desarrollo (`127.0.0.1:5433`) **solo hubo lecturas**: `curation scan --dry-run` con el código
de `HEAD` (v1) y con el de esta etapa (v2), y una foto del catálogo tomada con `SELECT` en `REPEATABLE READ`.
La migración 0020 **no está aplicada** en desarrollo: la foto consulta si existe
`ingest.curation_distinct_pairs` (`to_regclass`) antes de leerla, así que el `--dry-run` funciona sin ella.

## 1. Análisis `--dry-run` sobre desarrollo

| Reglas | Hallazgos | Duración |
|---|---:|---:|
| v1 (`HEAD`, 4bce56b) | 5.382 | 2.692 ms |
| v2 (esta etapa) | 5.261 | 3.265 ms |

Por categoría:

| Categoría | v1 | v2 | Δ |
|---|---:|---:|---:|
| Mal segmentados | 2.756 | 2.758 | +2 |
| Datos incoherentes | 904 | 782 | −122 |
| Ficha de otro tipo | 718 | 727 | +9 |
| Fichas sin vínculos | 665 | 665 | 0 |
| Otros | 156 | 156 | 0 |
| Fichas repetidas | 110 | 112 | +2 |
| Nombres sucios | 73 | 61 | −12 |
| **Total** | **5.382** | **5.261** | **−121** |

Por detector y subgrupo (solo lo que cambió):

| Detector › subgrupo | v1 | v2 | Qué pasó |
|---|---:|---:|---|
| `tipo_de_disco_contra_titulo` › `sin_clasificar` | 596 | 515 | «vol» y «rock» ya no declaran un tipo |
| `tipo_de_disco_contra_titulo` › `contradice` | 22 | 8 | ídem; entran «Maquetas» (semilla) |
| `duracion_atipica` › `muy_corta` | 133 | 106 | 27 intros, outros, presentaciones y bloopers |
| `minusculas` | 13 | 1 | 11 pasan a «Persona que no es un nombre» › `fragmento`; «intro» ya estaba en `palabra_generica` |
| `persona_no_es_un_nombre` › `fragmento` | 11 | 22 | +11 desde `minusculas` |
| `numeracion_con_huecos` | 104 | 55 | 49 pasan al subgrupo propio |
| `numeracion_con_huecos` › `empieza_en_2` | — | 49 | reclasificados, no eliminados |
| `palabras_pegadas` | 51 | 29 | 22 pasan al subgrupo propio |
| `palabras_pegadas` › `posible_estilizado` | — | 22 | una sola palabra camelCase |
| `persona_con_nombre_de_artista` | 79 | — | se divide (B5) |
| › `solista_detras_del_proyecto` | — | 41 | forma de nombre de persona, gravedad baja |
| › `banda_como_persona` | — | 38 | gravedad media |
| `persona_es_organizacion` › `vocabulario_de_organizacion` | 431 | 429 | fuera «Dan Warner» y «John Philips» |
| `varias_personas_en_una` | 93 | 91 | dos pasan a alias |
| `varias_personas_en_una` › `alias_en_nombre` | — | 4 | dos de v1 y dos que v1 no veía |
| `pistas_repetidas` | 61 | 63 | un hallazgo por par: dos pistas que aparecían 3 veces dan 3 pares |
| `anomalia_del_catalogo` (subgrupos de signos) | 44 | 12 | mismo número de hallazgos; un subgrupo por clase y campo, no por carácter (B1) |

### Criterios de aceptación del plan

| Esperado en el plan | Medido | Evidencia |
|---|---|---|
| −75 «vol» | 75 → 0 | hallazgos de tipo de disco cuyo título dice «vol» |
| −25 «rock» | 26 → 0 | ídem con «rock» (el plan redondeó) |
| −49 «empieza en 2» reclasificados | 49 en `empieza_en_2`; `numeracion_con_huecos` 104 → 55 | tabla anterior |
| «Dan Warner» fuera | fuera, y también «John Philips» | `persona_es_organizacion`, `test/unit/curation-rules-v2.test.ts` |
| Prueba de precisión en verde | 4/4 | `test/unit/curation-precision.test.ts`; con las reglas v1 fallan 3 de 4 |
| Un ignorado de grupo sobrevive a un tercer miembro (contrato) | en verde | `test/contract/curation-scan.test.ts` › «un par ignorado en grupo sobrevive…» |

De los 75 «vol», tres discos que también dicen «Antología» siguen en `contradice` por esa semilla
(«antologia» 1 → 4): no es un falso positivo de «vol».

### Primer análisis que se guarde con v2

Calculado sobre la misma foto comparando huellas v1 y v2: **4.880 hallazgos conservan su huella**, **502 se
resolverán** y **381 aparecerán como nuevos**. Casi todo es el cambio de huella, no un cambio del catálogo:
los duplicados pasan de un hallazgo por grupo a uno por par (artistas 29, pistas 61 → 63, discos 9,
personas 6, organizaciones 5), `persona_con_nombre_de_artista` (79), `numeracion_con_huecos` (49),
`palabras_pegadas` (22) y `varias_personas_en_una` (2 → 4) cambian de subgrupo, en «Otros» (101) cambia la
firma y 11 fragmentos pasan de `minusculas` a `persona_no_es_un_nombre`. Los 98 de tipo de disco, 27 de
duración, 12 de minúsculas y 2 de organización sí desaparecen. Los que se resuelven quedan con motivo
`rules_changed`.

En desarrollo **no hay hallazgos ignorados ni resueltos** (consulta de solo lectura del 2026-09-16): el
cambio de huellas no hace perder ninguna decisión.

## 2. Corpus etiquetado y precisión

`test/fixtures/curation/corpus.json`: los 474 hallazgos de la muestra de E0 (hasta 20 por detector),
etiquetados a mano, más **13 del suplemento de E2** (`addedIn: "E2"`): falsos positivos de A6 que la muestra
no recogió (8 «vol»/«rock», «John Philips», 4 intros y outros). El suplemento sale de lo que v2 elimina, así
que infla la mejora de `tipo_de_disco_contra_titulo`, `duracion_atipica` y `persona_es_organizacion`; lo que
protege es que esos casos no vuelvan.

| Etiqueta | Hallazgos |
|---|---:|
| Verdadero positivo | 389 |
| Falso positivo | 47 |
| Discutible (no cuenta) | 51 |
| **Total** | **487** |

Campos nuevos por hallazgo: `verdict`, `note` (por qué, en los casos no evidentes), `expectedDetector` y
`expectedSignature` (dónde tiene que estar hoy un verdadero positivo que v2 reclasificó) y `fixedIn`
(versión que dejó de emitir un falso positivo).

La prueba analiza una **foto congelada del catálogo de desarrollo**
(`test/fixtures/curation/catalog-2026-09-16.json.gz`, 710 KB, cargada por
`test/support/curation-catalog-fixture.ts`): el vocabulario se aprende del catálogo entero, así que un falso
positivo real solo se reproduce con los mismos datos. Sin la cola de revisión (el corpus no tiene hallazgos
de cola), con sus pares ya tratados. Exige:

1. ningún verdadero positivo perdido, y en su subgrupo esperado si se reclasificó;
2. ningún falso positivo con `fixedIn` de vuelta;
3. precisión por detector (verdaderos / verdaderos + falsos que siguen emitiéndose) ≥ el umbral registrado en
   `precisionThresholds`. El umbral es la precisión medida con v2, redondeada hacia abajo: una regla que la
   mejore debe subirlo.

Precisión por detector, truncada a dos decimales (los que tienen 1,00 en v1 y en v2 van agrupados al final):

| Detector | v1 | v2 (= umbral) | Decididos v2 |
|---|---:|---:|---:|
| `tipo_de_disco_contra_titulo` | 0,71 | **1,00** | 20 (+8 corregidos) |
| `duracion_atipica` | 0,71 | **1,00** | 15 (+6 corregidos) |
| `persona_es_organizacion` | 0,89 | **1,00** | 17 (+2 corregidos) |
| `pistas_repetidas` | 0,94 | 0,94 | 19 |
| `signos_sin_cerrar` | 0,88 | 0,88 | 17 |
| `varias_personas_en_una` | 0,71 | 0,71 | 14 |
| `organizaciones_equivalentes` | 0,50 | 0,50 | 2 |
| `anomalia_del_catalogo` | 0,41 | 0,41 | 17 |
| `anio_titulo_contra_publicacion` | 0,40 | 0,40 | 5 |
| `artista_es_organizacion` | 0,33 | 0,33 | 6 |
| `palabras_pegadas` | 0,33 | 0,33 | 9 |
| los otros 21 detectores | 1,00 | 1,00 | — |

(En v1, `minusculas` emitía 11 verdaderos positivos que v2 emite en `persona_no_es_un_nombre`: la precisión
de ambos es 1,00 antes y después.)

**Nota histórica de v2:** esos siete detectores estaban por debajo del 90 % en la primera entrega de E2.
La v3 los corrige y eleva sus umbrales a 0,90; la prueba de precisión impide volver a aceptar los casos
documentados (pulgadas, «Luis Felipe Ramón y Rivera», Capitol Studios/Records, material de archivo, nombres
artísticos y marcas camelCase). Los valores de la tabla anterior se conservan únicamente como medición
histórica de v2, no como estado actual de cierre.

## 3. Qué cambió

**Reglas (A6, B1–B3, B5)**

- `learnAlbumTypeWords`: una palabra aprendida no puede estar sin clasificar en más de la mitad de sus discos,
  ni ser de volumen (`vol`, `volumen`, `parte`, `tomo`…) ni un descriptor de género o serie. Los descriptores
  se aprenden: palabras en nombres de ≥ 3 artistas, en títulos de disco de ≥ 5 artistas y al menos 2,5 veces
  más frecuentes en títulos de disco que en títulos de pista, que no sean lugar, nombre de pila ni palabra de
  nombre de persona. En desarrollo: «rock», «punk», «tributo» (más las de volumen). Sin el último criterio
  entraban palabras comunes («blood», «pan», «tierra») y tres personas («Blood», «PAN», «Human Production»)
  pasaban a `palabra_generica`. La evidencia dice `wordSource: semilla | aprendida`; solo la semilla
  permite corregir sin criterio (nivel 0). Semilla nueva: «demos», «maquetas». «Singles»/«Sencillos» **no**
  entran: un título así es una colección de sencillos (un recopilatorio); probarlo dio 10 falsos positivos.
- Léxico nuevo: nombres de pila (primera palabra de ≥ 3 personas, más delante que detrás), palabras de nombre
  de persona y apellidos (de nombres que empiezan por un nombre de pila) y piezas breves (semilla más palabras
  cuya mediana de duración no llega a un tercio de la del catálogo, en ≥ 5 pistas de ≥ 3 discos).
  `isPersonShaped`: empieza por nombre de pila, o termina en apellido conocido.
- `numeracion_con_huecos`: la numeración continua entre discos no es un hueco; `empieza_en_2`; «Falta la
  pista 3» / «Faltan las pistas 2, 3».
- Marcas de organización: una sola marca aprendida al final de un nombre con forma de persona no marca
  («Dan Warner»). Las inequívocas («Records», «Estudios») siguen marcando.
- `palabras_pegadas` › `posible_estilizado` cuando el valor es una sola palabra camelCase, salvo una persona
  cuyo primer tramo es nombre de pila («CarlosAcosta»).
- `duracion_atipica`: no marca como muy corta una pista con palabra de pieza breve.
- `varias_personas_en_una` › `alias_en_nombre`: «(aka X)», «alias X», «X as "Y"».
- Persona en minúsculas sin ninguna palabra de nombre de persona → `persona_no_es_un_nombre` › `fragmento`.
- `persona_con_nombre_de_artista` › `solista_detras_del_proyecto` / `banda_como_persona` (B5).
- «Otros» agrupa por clase Unicode (`signo:puntuacion|moneda|simbolo|invisible_o_marca:<campo>`); el carácter
  sigue en el título y la evidencia (B1). U+200D y U+FE0F dentro de un emoji compuesto no son invisibles ni
  signos raros (B2). El mojibake con bytes Windows-1252 («Donâ€™t») se repara y se propone (B3).

**Decisiones duraderas (A5, M3, M4)**

- Huella por par: los duplicados (artistas, organizaciones, discos, pistas, personas) se emiten por par y la
  huella es `detector + "par" + tipo + id menor + id mayor`. Un tercer miembro o un renombrado no la cambian.
- `ingest.curation_distinct_pairs` («Son distintas»): la foto la lee dentro de la misma transacción y suma sus
  pares a `handledPairs`; el hallazgo abierto o ignorado de ese par se resuelve con `declared_distinct`.
  API: `GET/POST /curation/distinct-pairs`, `DELETE /curation/distinct-pairs/:id`.
- «No es un problema» exige `reason` (`falso_positivo`, `correcto_a_proposito`, `fuera_de_alcance`); ignorar
  en grupo exige además nota. Un ignorado cuyo problema desaparece pasa a `resolved` y conserva quién y por
  qué; si el problema vuelve, vuelve **abierto** y sin la decisión vieja.
- `evidence.history`: los últimos 5 cambios de gravedad, título o subgrupo de un mismo hallazgo.
- Web: diálogo de motivo al ignorar (uno o en grupo), botón «Son distintas» en los pares, último cambio,
  motivo del ignorado y «antes estaba ignorado» en los resueltos.

## 4. Discrepancias con el plan

1. **Motivo al caducar un ignorado.** El plan dice que pasa a `resolved` con `resolution='changed_elsewhere'`.
   El código usa el clasificador de E1 como con cualquier otro hallazgo: `fixed_by_curation` si lo corrigió
   Curaduría, `entity_removed`, `rules_changed` o `declared_distinct` cuando corresponde. Forzar
   `changed_elsewhere` borraría la información que E1 añadió.
2. **Motivo nuevo `declared_distinct`.** El plan no lo nombra; sin él, un par declarado distinto se
   resolvería como «cambiado en otra parte», que es falso.
3. **Numeración de migraciones.** E2 ocupa `0020`; la `0020_curation_fix_batches` que el plan asigna a E4
   pasa a ser `0021`.
4. **Adelantos de E3.5/E8.** Las rutas `/curation/distinct-pairs` y, en la web, el diálogo de motivo y el
   botón «Son distintas» entran aquí: sin ellos `reason` obligatorio rompía «No es un problema» y la tabla de
   pares no tenía forma de usarse.
5. **Ámbito de `distinct_pairs`.** El plan lista artistas, organizaciones, discos y pistas; también cubre
   personas (el detector `personas_equivalentes` también emite pares).
6. **Umbral de precisión (resuelto en v3).** La primera entrega registró siete umbrales inferiores a 0,90.
   El cierre v3 corrigió esos falsos positivos y elevó todos los umbrales etiquetados a ≥ 0,90; CI lo impone.
7. **«Singles»/«Sencillos»** no se añadieron a la semilla (§3).
8. **QA visual de Curaduría** (`npm run test:visual-curation`, contenedor propio): se actualizó porque E2 la
   rompía a propósito. «No es un problema» ya no ignora de un clic (abre el diálogo de motivo) y «Otros» ya no
   tiene un subgrupo por carácter; ahora siembra signos de tres clases en cuatro campos (12 subgrupos, para
   seguir probando el despliegue por tandas), comprueba que sin motivo no se guarda y que «Son distintas» guarda
   el par. Capturas nuevas: `*-ignorar-motivo.png` y `desktop-son-distintas.png`.
9. **Retirar un par declarado** (`DELETE`) borra la fila sin nota: la decisión no es una escritura del core y
   el hallazgo reaparece abierto, pero no queda constancia de quién la retiró.

## 5. Reproducir

```bash
npm run cli -- curation scan --dry-run                 # solo lectura
./scripts/with-node22.sh node_modules/.bin/vitest run test/unit/curation-precision.test.ts test/unit/curation-rules-v2.test.ts
./scripts/with-node22.sh node_modules/.bin/vitest run test/contract/curation-scan.test.ts --pool=forks --poolOptions.forks.singleFork
npm run test:visual-curation                          # contenedor propio, capturas en docs/ui-qa/curaduria
```
