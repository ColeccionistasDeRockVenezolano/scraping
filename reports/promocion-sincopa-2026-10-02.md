# Sincopa: promoción al core por reglas (2026-10-02)

Pedido de Brian: promover por sección, con run y nota, empezando por jazz y
clásica; proyectar los géneros; resolver por reglas el millón de claims `low`
que una persona no puede revisar. El VACUUM de `entity_resolution_decisions` ya
se había hecho en la sesión anterior.

## Resultado

Seis secciones promovidas (todas menos rock/pop), en dos pasadas. Todo quedó en
runs del diario y se puede deshacer por run (`crv runs undo <id>`).

| Sección | 1.ª pasada | 2.ª pasada (tras arreglar las caras B) |
|---|---|---|
| new age (piloto) | 11352 | 11407 |
| clásica | 11350, 11353 (cortados: «Independent» y reinicio de la máquina), 11355 | 11408 |
| jazz | 11365 | 11409 |
| latin pop | 11366 | 11410 |
| tradicional | 11367 | 11411 |
| étnica | 11370 | 11412 |

Otros runs: 11403 y la corrección de étnica (números de pista viejos de la cara
B rechazados) y 11414 (`genres derive-artists`). Los runs en estado `partial`
solo tienen errores `tracks_position_uk` sueltos: pistas que siguen como
candidatas.

**Lo que entró al core** (inserciones del diario, todos los runs):

| Tabla | Nuevas | Actualizadas |
|---|---:|---:|
| artistas | 792 | 521 |
| discos | 4.317 | 9.996 |
| pistas | 33.882 | 13.481 |
| personas | 15.652 | 6.136 |
| organizaciones | 650 | 652 |
| membresías | 749 | — |
| créditos de disco | 31.520 | — |
| créditos de pista | 30.508 | — |
| géneros de disco (`album_genres`) | 3.713 | 112 |
| géneros de artista (`artist_genres`) | 1.209 | 850 |

Claims de Sincopa: 728.044 aceptados, 163.171 rechazados y 315.336 aún
candidatos. De estos, 188.058 son de rock/pop (sin promover) y unos 127.000 de
las otras seis secciones (≈27.700 identidades), que están retenidos a propósito.

## Géneros

La aprobación ya proyecta el campo «Genre» de cada ficha: los discos quedan con
su género confirmado (el primero de la lista es el principal) y el artista
hereda los de sus discos. `genres derive-artists` solo encontró 5 artistas
rezagados (run 11414). Los discos cuya ficha no dice género quedan sin género:
no se inventa ninguno.

## La política (src/review/bulk-policy.ts)

Cada identidad recibe un único veredicto, con el nombre de la regla que lo
produjo. Lo que la regla no puede afirmar queda abierto en la cola (`hold`).
Esta sesión agregó la v2:

- **Rótulos:** «Feat. X», «Arr: X», «Bonus Track», «tracks 1-4», «Radio
  Version», «3rd Mov», años sueltos. Ninguno se crea como persona.
- **Paréntesis de título:** Sincopa escribe «Título (Compositor)», pero también
  «Título (traducción)» o «(Capricornio)». Lo que la fuente SOLO nombra así
  resultó ser un título en las siete secciones medidas («Love Me Tender»,
  «Night Flight Over Tokyo», «Goyescas»). Se retiene, salvo que el ER ya lo
  haya enlazado con seguridad a una persona existente.
- **Empresas y lugares** acreditados como personas: «Skylight Recording»,
  «Synth Lab», «Archivo de La Ciudad», «Poliedro de Caracas».

## Fallo encontrado: caras de vinilo

1.864 fichas son LP con «Side A / Side B» y la cara B vuelve a empezar en 01.
El adapter leía dos pistas 01: la segunda chocaba con la posición ocupada y
quedaba candidata. Solo en latin pop eran unas 6.000 pistas.

Arreglo: tras un encabezado de cara que reinicia la cuenta, se suma lo ya
numerado. Es la convención del core (disco corrido: la cara B sigue en 5, 6…).
Se reingirieron 1.311 fichas no rock: los claims nuevos son solo los números
corregidos. Los números viejos se rechazaron en runs propios y la 2.ª pasada
metió las pistas de la cara B (3.725 solo en latin pop).

## Seguimiento (noche del 2026-10-02)

Brian: «1. Caso Rock/Pop, hazlo; 2. Qué opciones hay para estas personas;
3. Ordénalas correctamente; 4. Qué opciones hay?».

**Rock/pop, hecho.** Reingesta de sus 465 vinilos y rechazo de 1.402 números
viejos (run 11428). La promoción se cortó a mano en el run 11429 al aparecer
«Cuento» como persona; se amplió la política y siguió en el 11431. Entraron 10
artistas, 73 discos, 1.366 pistas, 3.729 personas, 82 organizaciones, 11.017
créditos de disco y 5.802 de pista. Las 199 pistas que chocan de posición
siguen candidatas (casi todas en los 74 discos de abajo).

**Caras B ya aceptadas, reordenadas.** `scripts/renumber-sincopa-sides.ts`
mueve cada disco en una transacción: claim viejo `superseded`, nuevo
`accepted`, auditoría en `merge_audit`. Run 11430: 137 pistas en 106 discos no
rock. Run 11432: 380 pistas en 82 discos de rock. Tercera pasada de pistas
(runs 11433–11440) para las que estaban bloqueadas. Saltados, para revisión
(`sincopa-caras-renumeracion-*-2026-10-02.json`, `skippedList`): 12 discos no
rock, donde dos fichas de Sincopa cayeron en el mismo disco del core («Recital»
de Alirio Díaz), y 74 de rock, donde Hippito, Rock de Vzla o Descargas Metal
sostienen la numeración por cara.

**Rótulos que la v2 no veía:** «Comp:», «Recop:», «Rec.», «Compilation:»,
«Lyrics:» y palabras sueltas («Cuento», «Demo», «Acústico», «Medley»). La lista
de personas basura sube de 191 a 300
(`promocion-sincopa-personas-a-revisar-v3-2026-10-02.json`).

**Fallo del motor, corregido.** Cada pasada abría otra revisión del ER para el
mismo claim (la decisión del ER cambia de hash con el run). Se cerraron 31.247
repetidas de 15.827 claims (run 11442), y ahora la revisión abierta se
actualiza con la decisión más reciente.

### Opciones: las 300 personas basura

Ninguna tiene membresías; 4 tienen datos de otras fuentes; suman 519 créditos.

| Grupo | Cuántas | Qué hacer |
|---|---:|---|
| Paréntesis de título («Night Flight Over Tokyo») | 155 | Borrar persona y crédito; opcional: guardar el texto como nota de la pista (suele ser la traducción o el subtítulo). |
| Rótulo con persona real («Arr:», «Comp:», «Recop:», «Rec.», «Lyrics:», «Feat.») | ≈105 | Pasar el crédito a la persona real, existente o nueva, con el rol correcto (arreglos, compositor, recopilación, letra, invitado) y borrar la falsa. |
| Rótulo puro («Live», «Bonus Track», «3rd Mov», «Cuento») | ≈16 | Borrar persona y crédito. |
| Varios autores juntos («Lennon/McCartney») | 12 | Se resuelven con la regla de abajo. |
| Agrupaciones y lugares («Ensamble Gurrufio», «Rios Reyna Concert Hall») | 5 | Pasar a artista u organización. |
| Nombres cortados o dudosos («tan Fredericks», «mar Oliveros», «piano solo») | 7 | Revisar contra la ficha, a mano. |

### Opciones: créditos de varios autores («A/B»)

4.212 cadenas, unos 6.800 créditos candidatos; es la mayor retención de personas.

| Tramo | Cadenas | Créditos | Riesgo |
|---|---:|---:|---|
| A. Todas las partes ya existen en el core | 1.262 | 2.625 | Bajo, pero solo si cada parte tiene nombre y apellido («Leo» o «Ubieda» sueltos no bastan). |
| B. Todas son nombres completos, alguna nueva | 993 | 1.298 | Bajo: se crea la persona nueva como cualquier otra. |
| C. Hay iniciales («M. Sullivan», «A. Nazoa») | 961 | 1.512 | Medio: «A. Nazoa» puede ser Aquiles Nazoa; solo con enlace seguro del ER. |
| D. Apellidos sueltos («Lennon/McCartney», «Sadel/Rengifo») | 668 | 931 | Alto: no se crean personas; se enlaza solo si el ER es seguro. |
| E. Traen rótulo («Vers. Esp. P. Medeiros», «Anónimo/Arr: X») | 328 | 472 | Medio: hay que leer el rol. |

## Tercera fase (2026-10-02/03): lo que Brian aprobó

### Pistas con «posición ocupada» (199)

No se perdieron: 184 ya estaban en el disco con el número corrido del core
(Sincopa reinicia en el CD 2: Franco De Vita, «Ana», 04 → 15). Ponerlas al
final las habría duplicado. `scripts/fix-sincopa-position-collisions.ts`,
run 11459: el número reiniciado queda `superseded` y el resto de sus datos se
aprueba sobre la pista que ya existe (284 pistas). Quedan 22: 13 de
recopilaciones sin disco resuelto, 6 sin título y 3 de discos con dos
ediciones mezcladas (`sincopa-posiciones-ocupadas-2026-10-02.json`).

### Personas basura (opción B)

`scripts/cleanup-sincopa-junk-persons.ts`, run 11460: 277 aplicadas. El rótulo
pasa a rol («Arr:» → Arreglos, «Recop:» → Recopilación, «Feat» → Invitado), el
nombre a su persona o artista, y los títulos a la nota de la pista. 165
créditos movidos, 280 retirados, 60 notas. Regla nueva de Brian: el nombre
entero entre comillas («"Cervantes el campeón"») es un título; el apodo
intercalado (Rafael "Pollo" Brito, "Cheo" Valenzuela) es persona y conserva
las comillas.

### Créditos de varios autores («A/B»)

Brian: «aplicar A y B ahora, C y D solo con enlace seguro, y E después».

- Adapter 1.3.0: compositores y nombres se parten por «/», un crédito por autor.
- Política: una parte que solo aparece dentro de un crédito partido y es una
  palabra o lleva iniciales se retiene salvo AUTO_MATCH del ER
  (`parte-de-credito-multiple:sin-enlace-seguro`). Los rótulos (tramo E) siguen
  retenidos como rótulo.
- Reingesta de 2.129 fichas; `scripts/reject-stale-sincopa-credits.ts` (run
  11519) rechazó 47.591 claims de las cadenas combinadas y cerró 88.403
  revisiones. Los ~1.100 claims combinados ya aceptados apuntan a créditos que
  otras pasadas ya habían partido (Sandro Liberatoscioli, José Luis Pardo…).
- Promoción, solo en esas fichas:

| Sección | Run | Personas | Créditos de disco | Créditos de pista | Retenidos |
| --- | --- | ---: | ---: | ---: | ---: |
| classic | 11520 | 40 | 4 | 103 | 78 |
| ethnic | 11524 | 96 | 12 | 425 | 412 |
| jazz | 11536 | 216 | 26 | 687 | 578 |
| latin_pop | 11538 | 520 | 25 | 2.239 | 1.345 |
| new_age | 11539 | 5 | 0 | 13 | 20 |
| rock_pop | 11540 | 446 | 180 | 3.004 | 1.731 |
| traditional | 11541 | 309 | 10 | 1.977 | 540 |
| **Total** | | **1.632** | **257** | **8.448** | **4.704** |

  Retenidos: 3.052 partes sin enlace seguro (tramos C/D), 757 sellos o
  estudios, 385 rótulos, 314 agrupaciones o lugares, 148 que siguen siendo
  varias personas.
- Fichas combinadas que ya estaban en el core: run 11468
  (`docs/decisions/2026-10-02-sincopa-creditos-combinados.json`) partió
  «María Conchita Alonso/K.C. Porter», «Lennon/McCartney» y «Donida/Mogol» en
  sus personas. El resto, en `sincopa-revision-manual-2026-10-02.md`.
- Trampa encontrada: un claim viejo cuya identidad se reescribió sin recalcular
  el hash (Hydra, «Desde Una Orilla a La Otra») hacía que la reingesta metiera
  un gemelo y rompiera `claims_dedupe_uk`. El motor ahora lo deja `superseded`
  (commit e1969f4) y las 588 fichas restantes se reingirieron.

## Pendiente

1. Tramos C/D: 3.052 partes con iniciales o una palabra («A. Nazoa»,
   «Lennon»). Entran solas si un día el ER las enlaza con seguridad; si no,
   hace falta una regla de apellido + proyecto común.
2. Tramo E (rótulos dentro de créditos partidos): sin tocar, como pidió Brian.
3. Revisión manual: `sincopa-revision-manual-2026-10-02.md` (14 fichas
   combinadas, 37 rótulos sin enlace, 2 conversiones detenidas por el ER).
4. Fichas con «CD 2 / Disco 2» (≈327) y 15 con números repetidos por otras
   estructuras siguen en la cola.
