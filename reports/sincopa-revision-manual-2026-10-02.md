# Sincopa: personas que quedan para revisión manual (2026-10-02)

Lo que las reglas de la limpieza (run 11460) y de los créditos «A/B» no
resolvieron solas. En el core siguen tal cual; nada se perdió.

## Créditos «A/B» ya en el core

Run 11468 (`docs/decisions/2026-10-02-sincopa-creditos-combinados.json`) partió
los tres con destino inequívoco:

| Ficha | Destinos |
| --- | --- |
| 34628 María Conchita Alonso/K.C. Porter | 610 María Conchita Alonso, 1115 K.C. Porter |
| 27642 Lennon/McCartney | 81 John Lennon, 93 Paul McCartney |
| 25125 Donida/Mogol | 11446 Carlo Donida, 11448 Gulio Rapetti Mogol |

Quedan, porque el apellido coincide con varias personas o el destino no existe:

| Ficha | Por qué no |
| --- | --- |
| 29364 Herrero/Armenteros | 7 «Herrero» y 7 «Armenteros» posibles |
| 32996 Miller/Blakut | 24 «Miller»; «Blakut» no está |
| 27047 Vinicio/Rico | 12 «Rico» |
| 29427 Testa/Renis | 3 «Testa»; «Renis» no está (¿Alberto Testa + Tony Renis?) |
| 26733 Marchisio/Santiago | ninguno de los dos está |
| 26791 Angel Condercuri/Marú | ninguno de los dos está |
| 32409 Eliseo Herrera/De La Colina | «De La Colina» no está |
| 31839 Zona P/Mouseñadores | parecen dos grupos, no personas |
| 37409 Juan Carlos y Fernando | dúo sin apellidos |
| 4311 Daniel Mijares/nPi, 4315 Alejandro De Oliveira/nPi | «nPi» parece un sello |
| 8563 Oswaldo Grillet/cdboxproducciones | persona + productora |
| 9026 A. Cazalis/adpt:Felipe Grüber | autor + adaptación |
| 8540 B&R Gibb/c. Martin | Barry y Robin Gibb + ¿C. Martin? |

## Rótulos con un nombre que no tiene enlace seguro

| Ficha | Nombre | Motivo |
| --- | --- | --- |
| 18822 | Ft. Eidoscognito | una sola palabra |
| 19780 | Arr: D. d Los Reyes | iniciales |
| 19787 | Arr: A. Lauro | iniciales (¿Antonio Lauro?) |
| 27460 | Recopilación: Carreño | una sola palabra |
| 31248 | Comp. F. R. Yribera | iniciales |
| 32201 | Comp: A. Pérez Piñango | iniciales |
| 32205, 32206 | Comp: UDAF, Recop: UDAF | sigla |
| 36374–36376 | Lyrics: Z. Matousek, V. Fiol, I. Gastaminza | iniciales |
| 28490 | Rec. Iván Pérez Rossi | 2 personas y un artista con ese nombre |
| 30938 | Comp: Francisco Pacheco | 2 personas y un artista |
| 31028 | Comp. Jesús Rosas Marcano | 2 personas |
| 31379 | Recop: Juan Estévez | 3 personas |
| 31426 | Recop: Eduardo Martínez | 2 personas |
| 31574 | Recop: Hernán Marín | 2 personas y un artista |
| 31670 | Recop: Gualberto Ibarreto | 2 personas y un artista |
| 31770 | Recop: Reinaldo López | 3 personas |
| 32176 | Recop: José Antonio Calcaño | 3 personas |
| 32491 | Recop. Daniel Gil | 2 personas |
| 31247 | Comp. Los Araucanos | grupo que no está como artista |
| 31335 | Recop. Los Golperos Del Tocuyo | grupo que no está como artista |
| 31674 | Recop. Guilllermina-Gualberto Ibarreto | dúo que no está como artista |
| 31980 | Recop. Experimental Barlovento | grupo que no está como artista |

Los homónimos (2–3 personas con el mismo nombre) son duplicados de persona:
al fusionarlos (con proyecto común) el rótulo se resuelve con la regla de la
limpieza.

## Conversiones que el ER detuvo

| Ficha | Iba a ser | Motivo |
| --- | --- | --- |
| 19843 Acoustic Recording Service | organización | el ER lo ve parecido a 2256 «Acoustic Music Records» |
| 37813 La Otra Gente | artista | el ER encontró un candidato parecido |

## Resuelto el 2026-10-03 (runs 11585 y 11586)

Decisiones de Brian, aplicadas con `scripts/resolve-sincopa-manual-review.ts`
(deshacer: `crv runs undo 11586` y luego `crv runs undo 11585`):

- **Iniciales, una palabra o sigla** (11 fichas): el rótulo pasa a rol y la
  ficha queda con el nombre limpio, sin enlazar («Arr: A. Lauro» → «A. Lauro»,
  arreglos). «Comp: UDAF» y «Recop: UDAF» quedan en una sola ficha «UDAF».
- **Homónimos con proyecto común** (6): Francisco Pacheco → 20566 (2 créditos
  ya estaban y se retiraron), Hernán Marín → 24616, Gualberto Ibarreto → 21200
  (mismo disco); Eduardo Martínez → 3907, Reinaldo López → 5800, Daniel Gil →
  30434 (mismo artista).
- **Grupos a artista**: Los Araucanos (4328, absorbe también la persona 31232
  «Los Araucanos»; el ER lo veía parecido a «Los Anauco» 3980, que es otro
  grupo), Los Golperos Del Tocuyo (4325), Experimental Barlovento (4326, sin
  créditos: la ficha no tenía ninguno). El dúo «Guilllermina-Gualberto
  Ibarreto» se partió: el crédito va a Gualberto Ibarreto (21200) y a una
  ficha «Guillermina».
- **Conversiones**: Acoustic Recording Service → organización 2350 (estudio,
  distinta de 2256 «Acoustic Music Records»); La Otra Gente → artista 4327.

Los cuatro en los que ningún homónimo compartía disco ni artista (Brian, 2026-10-03;
fusiones en el run 11594 con `docs/decisions/2026-10-03-sincopa-homonimos-revision.json`,
el resto en el run 11596):

| Ficha | Nombre | Resultado |
| --- | --- | --- |
| 28490 | Rec. Iván Pérez Rossi | 911 fusionado en 20644 (los dos de Serenata Guayanesa); la ficha vacía se retiró |
| 31028 | Comp. Jesús Rosas Marcano | 9650 fusionado en 32526 (los dos en discos de Carlos Baute); los 3 créditos de «Sabor a Pueblo» pasaron a 32526 |
| 31379 | Recop: Juan Estévez | ficha propia «Juan Estévez», recopilación (no es el de Angelus ni el productor de Ed Calle) |
| 32176 | Recop: José Antonio Calcaño | ficha propia «José Antonio Calcaño», recopilación (no es ninguno de los rockeros) |

Pendiente: el crédito «Rec. Iván Pérez Rossi» de «Corre Caballito» es del disco
«La Luz Que Me Guía» de Juan Carlos Salazar (Sincopa latin_pop), que no está en
el core: el artista quedó candidato (¿«Carlos Salazar» 2865?, ¿el dúo con Hernán
Gamboa 3788?). Al promover ese disco el crédito debe ir a 20644.
