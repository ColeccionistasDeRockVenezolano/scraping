# Géneros: fuentes musicales externas (PLAN_GENEROS etapa 4)

Cómo entra en CRV un género que viene de fuera del catálogo (MusicBrainz,
Discogs, Wikidata…): qué se evalúa antes de tocar nada, cómo se decide que una
ficha de allá es la misma de aquí, qué se escribe y qué no, y cómo se apaga.

**La regla que ordena todo lo demás:** una fuente externa **propone**; nunca
decide. Todo lo que trae entra como `suggested` y se publica solo cuando una
persona lo confirma en la Mesa (etapa 3).

## 1. Antes de integrar: la ficha de evaluación

Ninguna fuente se consulta sin ficha. Viven en
`data/genres/external-sources.json` (revisable en el repositorio) y se cargan a
`ingest.genre_external_sources`:

```bash
crv genres external sheets --by="tu nombre" --reason="alta de fichas" --confirm
crv genres external sources          # estado de cada una
```

Cada ficha responde, por escrito, a lo que exige el plan:

| Campo | Qué responde |
|---|---|
| `accessMode` + `accessNote` | por qué ese acceso está permitido (API documentada, volcado, SPARQL) y qué identificación exige |
| `license` + `attribution` + `termsUrl` | con qué licencia llegan los datos y cómo hay que citarlos |
| `rateLimitPerMinute` | el límite que CRV se impone, por debajo del de la fuente |
| `levels` | si publica géneros de artista, de lanzamiento o de ambos |
| `coverageNote` | cobertura real de música venezolana, sin optimismo |
| `identifierStability` | si su identificador sobrevive a fusiones y renombres |
| `tagPolicy` | qué clases de etiqueta se aceptan (`editorial_genre`, `community_tag`, `technical`) y con cuántos votos |
| `tagPolicy.buckets` | qué familias de CRV abarca un cajón de la fuente, cuando agrupa más grueso que CRV (ver «Los cajones de una fuente») |
| `precisionThreshold` | qué precisión le exige CRV a la muestra antes de importar en volumen |

Cargar una ficha **no autoriza nada**: la fuente queda en `evaluating`.

### Las tres candidatas evaluadas

| Fuente | Veredicto | Por qué |
|---|---|---|
| **MusicBrainz** | integrada (adaptador `src/genres/external/adapters.ts`) | API documentada para uso programático, datos CC0, MBID estable y géneros en los dos niveles. Se accede con User-Agent identificable (`GENRES_EXTERNAL_CONTACT`) y por debajo de su límite. |
| **Discogs** | integrada (token propio, 2026-09-23) | La mejor para ediciones físicas venezolanas. API autenticada con `DISCOGS_TOKEN`; sus condiciones prohíben rastrear el sitio, así que solo se usa la API. **No publica géneros de artista**: su nivel es `album`. |
| **Wikidata** | ficha cargada, sin adaptador | Licencia e identificadores inmejorables, pero su aporte de géneros para el catálogo venezolano se prevé bajo; sirve más para corroborar identidad. |

### Credenciales e identificación

- `GENRES_EXTERNAL_CONTACT` (obligatorio): va en el User-Agent
  `CRV-generos/1.0 ( contacto )`. Las dos fuentes **bloquean** un User-Agent
  genérico o sin vía de contacto, así que sin él la importación falla antes de
  salir a la red, en vez de salir mal identificada.
- `DISCOGS_TOKEN` (solo Discogs): viaja en la cabecera `Authorization`,
  **nunca en la URL**, porque `ingest.genre_external_cache` guarda la URL de
  cada respuesta y un secreto no tiene nada que hacer ahí. Vive en `.env`, que
  está en `.gitignore`; `.env.example` solo lleva el hueco.

### Qué devuelve cada una (medido el 2026-09-23 con dos bandas reales)

| | MusicBrainz | Discogs |
|---|---|---|
| Sentimiento Muerto | identifica (país VE), 5 lanzamientos, **sin géneros** | identifica (6 miembros), 10 lanzamientos, «Punk, Post-Punk, New Wave, Alternative Rock, Rock» |
| Desorden Público | identifica y distingue al homónimo mexicano, 22 lanzamientos, artista `ska` | identifica, 62 lanzamientos, «Ska, Pop Rock, Reggae-Pop, Rock, Reggae, Latin» |

Es la primera señal de lo que la muestra tendrá que confirmar: MusicBrainz
identifica bien pero casi no publica géneros de música venezolana, y Discogs es
mucho más rico en etiquetas. Ninguna de las dos ha importado nada todavía.

### La muestra medida (60 discos cada una, 2026-09-23)

| | Discogs | MusicBrainz |
|---|---:|---:|
| identificados | 14 | 15 |
| frenados por artista dudoso o sin candidato | 45 | 45 |
| comparables con lo confirmado por CRV | 14 | 4 |
| coincide / familia / discrepa | 10 / 2 / 2 | 1 / 3 / 0 |
| **precisión** | **85,7 %** | **100 %** |

Las dos pasan el umbral de 0,85 **y aun así no se habilitó el volumen**, por una
razón que el número solo no dice: la muestra comparable es minúscula. Discogs
mide 12 aciertos sobre 14 —un error más y cae al 78,6 %— y MusicBrainz mide
sobre **4 fichas**, que no es una medición. El umbral es una condición
necesaria, no suficiente: antes de `bulk-enable` hay que ampliar la muestra, y
para eso el cuello de botella no son los géneros sino la identidad.

**Remedida tras graduar la discografía** (ver más abajo), la muestra de Discogs
identifica 18 en vez de 14 y su precisión bajó a **83,3 %** (15 aciertos, 3
desacuerdos), por debajo del umbral. Dos de esos tres desacuerdos no lo eran
(siguiente apartado); declarado el cajón, la medición del 2026-09-24 da
**94,4 %** sobre las mismas 18 fichas y es la que está guardada en la ficha.

### Los cajones de una fuente, y por qué no son desacuerdos

En CRV `metal`, `punk` y `rock` son familias **hermanas**; en Discogs «Rock» es
el cajón de arriba que *contiene* a las tres. Cuando un disco de nu-metal solo
recibe la etiqueta «Rock», contarlo como **desacuerdo** mide mal: la fuente
está siendo gruesa, no contradiciendo.

**Decisión editorial de Brian (2026-09-24):** se declara qué familias de CRV
abarca cada cajón, en `tagPolicy.buckets` de la ficha de la fuente. La
taxonomía de CRV **no se toca**: `metal` y `punk` siguen siendo familias raíz
en el catálogo, en la Mesa y en la proyección pública. El cajón solo cambia
cómo se *lee* la fuente.

```json
"tagPolicy": { "acceptKinds": ["editorial_genre"], "minTagCount": 1, "maxValues": 3,
               "buckets": { "Rock": ["rock", "metal", "punk"] } }
```

Un cajón hace dos cosas, y ninguna más:

1. Si CRV ya confirmó algo dentro del cajón, el término sale **demasiado
   general** en vez de propuesta: deja de sugerir `rock` en discos de metal.
2. Si el cajón abarca la familia del principal confirmado, el acuerdo es **de
   familia** en vez de desacuerdo, con el motivo escrito en el informe («el
   cajón «Rock» de la fuente abarca la familia del principal (nu-metal)»).

Un cajón **nunca** propone géneros de más ni tapa un desacuerdo real: «Salsa»
frente a un nu-metal sigue siendo desacuerdo. Un slug que no existe o que no es
familia se ignora — la ficha de una fuente no inventa ramas de la taxonomía.

Efecto medido sobre la misma muestra de 60 discos (`sample`, Discogs):

| | sin cajón | con cajón |
|---|---:|---:|
| coincide / familia / discrepa | 13 / 2 / 3 | 13 / 4 / 1 |
| **precisión** | 83,3 % | **94,4 %** |

El desacuerdo que queda es de verdad: «Cosas Sencillas», donde Discogs dice
`jazz, fusion-latina, pop` y CRV tiene `pop-rock` de principal.

Punk no apareció en la muestra, pero entra en el cajón por los 113 discos del
catálogo cuyo principal es de esa familia: Discogs los etiqueta «Rock» igual
que al metal. Las otras dos fuentes no declaran cajones — sus términos de
primer nivel mapean uno a uno contra las familias de CRV.

### El aporte medido (ensayo en seco, Discogs, 40 discos sin clasificar)

| | antes de graduar | después |
|---|---:|---:|
| identificados | 7 de 40 | **15 de 40** |
| frenados por artista dudoso | 17 | 6 |
| sugerencias que escribiría | 13 | **35** |
| **discos que ganarían clasificación** | 7 | **15** |
| casos abiertos para la Mesa | 9 | 8 |

Más de un tercio de los discos sin clasificar recibiría algo. Pero conviene
mirar *qué*: de los 41 valores propuestos, **31 son de familia**
(`fusion-latina` 13, `rock` 8, `pop` 8, `jazz` 2) y 10 son género específico
(`pop-rock` 5, `balada` 2, `soul`, `heavy-metal`, `funk`). Discogs aporta sobre
todo la brocha gorda —que en un disco sin clasificar es mejor que nada, pero no
sustituye la decisión editorial fina—.

Los casos se abren **uno por artista**, no uno por disco: resolver a un artista
en la Mesa desbloquea toda su discografía de golpe.

## 2. Autorizar, habilitar, medir, habilitar el volumen

Cuatro decisiones humanas distintas, cada una con `--by` y `--reason`, y todas
en seco hasta que se añade `--confirm`:

```bash
# 1. Autorizar la fuente (evaluada y aceptada)
crv genres external authorize musicbrainz --by=brian --reason="licencia CC0 y API documentada" --confirm

# 2. Habilitar su importación (ya puede escribir sugerencias)
crv genres external enable musicbrainz --by=brian --reason="empezamos por discos sin clasificar" --confirm

# 3. Medir la muestra: se compara con lo que CRV YA confirmó, y no escribe sugerencias
crv genres external sample --source=musicbrainz --level=album --limit=60 \
  --by=brian --reason="muestra de precisión" --confirm

# 4. Solo si la muestra alcanza el umbral, habilitar el volumen
crv genres external bulk-enable musicbrainz --by=brian --reason="muestra en 0,91" --confirm
```

El umbral no es una cortesía: `ingest.genre_external_sources` tiene una
restricción que **rechaza** `bulk_enabled` sin precisión medida por encima de
`precision_threshold`, y otra que rechaza importar sin autorizar.

**La muestra mide precisión, no aporte.** Elige a propósito fichas que CRV ya
tiene clasificadas, porque son las únicas con qué comparar; por construcción su
cobertura nueva siempre sale 0. Para saber cuánto aportaría la fuente hay que
ensayar en seco sobre lo que *no* está clasificado:

```bash
crv genres external import --source=discogs --level=album --limit=200 \
  --by=brian --reason="ensayo: cuánto aportaría"     # sin --confirm
```

Ese ensayo **no necesita el volumen habilitado**: no escribe ni una sugerencia,
y es justamente el informe con el que se justifica habilitarlo. El candado está
en escribir, no en ensayar. Lo que sí exige es `enable`, porque el ensayo sí
sale a la red y gasta el límite de la fuente.

La precisión se mide sobre lo comparable: aciertos exactos y de familia frente
a los desacuerdos, contra fichas que CRV ya tiene confirmadas. El informe queda
en `reports/genres-external-<fuente>-<nivel>-sample-confirm.{json,md}` y la
cifra, en la ficha.

## 3. Importar

```bash
# fichas concretas (no necesita volumen habilitado)
crv genres external import --source=musicbrainz --level=album --ids=1234,1235 \
  --by=brian --reason="discos de la cola de radio" --confirm

# todo lo que no tiene principal confirmado (exige volumen habilitado)
crv genres external import --source=musicbrainz --level=album --limit=200 \
  --by=brian --reason="primera tanda" --confirm
```

Sin `--confirm` corre entero y se deshace: el informe dice exactamente qué
escribiría. Lo que sí sobrevive a un ensayo es la **caché** de respuestas
(`ingest.genre_external_cache`), para no volver a gastar el límite de la fuente.

Qué hace con cada ficha:

1. **Identidad primero.** Artista: nombre normalizado o alias del catálogo,
   país, miembros y discografía coincidente. Lanzamiento: siempre bajo un
   artista ya identificado, más título, año, pistas, sello o número de catálogo.
   Una coincidencia **solo** por nombre o título no basta nunca, y dos
   candidatos igual de buenos quedan `ambiguous` y van a la cola: no se elige
   «el primero». Todo queda en `ingest.genre_external_identities` con su
   puntaje y sus señales.
   La discografía pesa por **títulos distintos** que coinciden (3+ → 0,40, 2 →
   0,30, 1 → 0,15), y el **disco homónimo no cuenta**: que «Almendra» tenga un
   disco «Almendra» es el nombre otra vez, y el nombre ya se cobró aparte.
   Cobrarlo dos veces empataba a 0,75 una coincidencia abrumadora (tres títulos
   propios) con otra que solo repite el nombre de la banda — que es justo la
   forma que toman los homónimos célebres.
   Si el **artista** queda dudoso, sus discos no se identifican: se cuentan
   como dudosos (no como «sin candidato») y abren **un solo caso sobre el
   artista**, no uno por disco. Resolverlo desbloquea toda su discografía, y es
   la palanca que más rinde: en la muestra del 2026-09-23 fue lo que frenó a la
   mayoría de los discos.
2. **Etiquetas después.** Cada valor se resuelve contra la taxonomía aprobada:
   lo que tiene alias se propone; lo que no, va a revisión como término sin
   equivalencia (nunca se inventa un género); lo que solo repite la familia de
   algo que CRV ya precisó se descarta como demasiado general; las clases de
   etiqueta que la ficha no acepta ni se miran.
3. **Escribe solo propuestas.** `status = 'suggested'`, `source_kind = 'external'`,
   con la fuente, el identificador externo, la URL de la respuesta y su fecha en
   `evidence`. Si la pareja ficha–género ya existe (de las reglas o de una
   persona), **no se toca nada**.
4. **Manda a revisión lo dudoso**: identidad ambigua, desacuerdo con lo que CRV
   confirmó, término sin equivalencia y etiquetas demasiado generales. Todos
   caen en la misma cola de la Mesa, con origen `genres-external`.

## 3 bis. Aceptar en bloque lo que propuso la fuente

`import` escribe propuestas, nunca clasificación: un disco con sugerencias
sigue **sin género** para el catálogo y para el público. Decidirlas una a una
en la Mesa es el camino normal. Cuando la fuente ya se ganó la confianza
—muestra medida por encima del umbral— se pueden aceptar todas de una vez:

```bash
# en seco: dice qué confirmaría y con qué principal
crv genres external accept --source=discogs --level=album --limit=200 \
  --by=brian --reason="aceptar lo de Discogs"

# aplicado, confirmando también los secundarios
crv genres external accept --source=discogs --level=album --limit=200 \
  --secondaries=confirm --by=brian --reason="aceptar lo de Discogs" --confirm
```

**Decisión editorial de Brian (2026-09-24):** lo que proponga Discogs se
confirma en bloque, sin pasar ficha por ficha por la Mesa.

Reglas del paso, que no son negociables porque son las que lo hacen reversible:

- **No inventa.** Solo confirma sugerencias que la fuente ya escribió y que
  siguen `suggested` con `decision_kind = 'rule'`.
- **No pisa a nadie.** Una ficha que ya tiene principal confirmado se salta
  entera, y lo que decidió una persona no se toca jamás.
- **El principal es el más preciso**: un género hijo antes que una familia y, a
  igualdad, el que la fuente nombró primero. Discogs ofrece sus «styles» (Hard
  Rock, Ska Punk) antes que sus «genres» (Rock), así que el orden de la fuente
  ya viene de lo fino a lo grueso. Una familia que el hijo vuelve redundante
  queda `superseded`, no confirmada.
- **Se sabe quién fue.** Las filas quedan a nombre de `auto:<fuente>`, no del
  actor: el diario distingue lo que miró una persona de lo que entró en bloque.
  El motivo lleva el run, y **deshacerlo es por run**.
- Exige el mismo permiso que la carga masiva (`bulk-enabled`), y sin `--confirm`
  corre entero y se deshace.

Lo que este paso **no** arregla: un disco cuya identidad no se resolvió no
tiene propuestas, así que aquí no aparece. La cobertura la limita la identidad
del artista, no la confianza en la fuente.

## 4. En la Mesa

Las sugerencias aparecen en la categoría **Sugerencia externa** y los
desacuerdos, en **Desacuerdo**. La ficha muestra, aparte de la evidencia de
siempre, con qué identificador externo se corresponde, con qué señales se
decidió y la atribución de la fuente. Confirmar o rechazar es la misma decisión
humana de la etapa 3, con su motivo, su run y su historial.

## 5. Apagar sin perder nada

```bash
crv genres external disable musicbrainz --purge --by=brian --reason="revisamos su aporte" --confirm
```

`disable` apaga la importación; con `--purge` retira además las propuestas que
nadie resolvió y cierra sus casos. **Lo que una persona confirmó o rechazó no
se toca**: esas filas son `decision_kind = 'human'` y sobreviven al apagado, a
`block` y hasta a la migración `down`.

## 6. Qué vigila el sistema solo

- `npm run doctor` → `genres.external`: ninguna sugerencia externa confirmada
  sin persona detrás, ninguna identidad sobre fichas inexistentes, avisa de
  fichas fusionadas y de sugerencias vivas de fuentes ya no autorizadas.
- `GENRES_EXTERNAL_ENABLED=false` (el valor de fábrica) deja todo el sistema
  funcionando sin que nada salga a la red.
- El recálculo de las reglas (backfill, taxonomía, fusiones) no borra las
  sugerencias externas; si el catálogo termina afirmando ese mismo género, la
  fila pasa a ser de las reglas y suelta la referencia externa.

## 7. Dónde está cada cosa

| Pieza | Archivo |
|---|---|
| Migración | `migrations/0031_genre_external_sources.{up,down}.sql` |
| Fichas revisables | `data/genres/external-sources.json` |
| Identidad (puro) | `src/genres/external/identity.ts` |
| Mapeo de etiquetas (puro) | `src/genres/external/mapping.ts` |
| Adaptadores | `src/genres/external/adapters.ts` |
| Caché y límites | `src/genres/external/http.ts` |
| Base | `src/genres/external/store.ts` |
| Importación | `src/genres/external/import.ts` |
| Informes | `src/genres/external/report.ts` |
| CLI | `src/cli/genres-external.ts` |
| Pruebas | `test/unit/genres-external.test.ts`, `test/contract/genres-external.test.ts` |
