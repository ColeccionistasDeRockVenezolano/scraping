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

## Pendiente, a decisión de Brian

1. **Rock/pop.** Ensayo en `promocion-sincopa-rock_pop-ensayo-2026-10-02.json`.
   Casi todo enlaza con lo que ya existe (202 artistas, 836 discos y 8.704
   pistas reconocidos), pero es lo que ya está curado a mano: escribiría sobre
   fichas existentes y crearía ~980 personas homónimas de otras ya
   catalogadas, marcadas como posible duplicado. Antes de promoverla conviene
   reingerir sus 465 fichas con caras (`ingest-sincopa-stored.ts
   --urls-file`, con la lista de rock de `sincopa-paginas-con-caras-2026-10-02.txt`
   + `fix-sincopa-sides.ts`).
2. **191 personas basura** que crearon el piloto y clásica antes de la v2
   (155 títulos de paréntesis, 29 rótulos, 7 agrupaciones o fragmentos):
   `promocion-sincopa-personas-a-revisar-2026-10-02.json`. Ninguna tiene
   membresías y solo 2 tienen datos de otras fuentes. Se pueden borrar con sus
   créditos, o convertir las que son agrupaciones. «Arr: Vicente Emilio Sojo»
   debería pasar a Vicente Emilio Sojo.
3. **196 pistas con el número equivocado en el core**: son caras B que entraron
   sin el arreglo, como «Norteña» de Alirio Díaz, que quedó como 4 y en la
   ficha es la 7. La lista está en `sincopa-caras-correccion-lote1-2026-10-02.json`
   (`acceptedWrongList`). El corrector no toca el core.
4. **Siguiente regla con más rendimiento:** partir los créditos de varios
   autores separados por «/» («Lennon/McCartney»). Son la mayor retención de
   personas y arrastran miles de créditos de pista.
5. Fichas con «CD 2 / Disco 2» (≈327) no se trataron. Hay además 15 fichas con
   números repetidos por otras estructuras, que siguen en la cola.
