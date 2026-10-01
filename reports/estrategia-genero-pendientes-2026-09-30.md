# Estrategia de género para los pendientes del canal «Full album» (2026-09-30)

Censo verificado 2 veces contra la hoja en vivo: **469 filas objetivo** (tipos ⊆ {B-Sides,
Compilation Album, Demos, EP, Single, Remix, Studio Album, Solo Artist}, sin ninguna Live) →
**397 con género (84,6%)** → **72 pendientes = 72 discos**. (Tu ≈74 sale de una base de ~471;
con los 72 listados abajo puedes cuadrar los 2 de diferencia — la estrategia aplica igual.)

**Tesis**: los 72 no son un problema uniforme. 48 de 72 son de artistas cuyo género YA está
documentado en el catálogo (Arquetipo A) → la vía no es buscar más fuentes, es una decisión de
política + runs. Los otros son compilados (B) o artistas sin género (C).

## Arquetipo A — Derivados de artistas con género documentado (48)

| id | tipo hoja | disco | artista | géneros del artista |
|---|---|---|---|---|
| 53 | Single | Elefreak | Alban Arthuan | Rock progresivo, Rock sinfónico |
| 58 | Single | Rubia Sol Morena Luna | Caramelos De Cianuro | Rock |
| 66 | EP | Sonó Así | Famasloop | Pop rock |
| 68 | Single | Algo Tarde | Fuego Montevideo | Post-punk |
| 71 | Single | Ladrón De Tu Amor | La Puta Eléctrica | Pop, Rock |
| 72 | EP | La Vida Boheme | La Vida Bohème | Rock alternativo |
| 79 | Single | No Puedes Ver | Los Mesoneros | Rock alternativo |
| 82 | Single | Answer Machine | Metrozubdivision | Pop rock |
| 83 | Single | Secrets | Metrozubdivision | Pop rock |
| 92 | Demos | SP Demos | Sónica | Punk rock |
| 94 | Single | Alzheimer | The Asbestos | Rock alternativo |
| 98 | Single | Xanax | Zapato 3 | Rock |
| 126 | Demos | Demos | Bacalao Men | Funk, Rock latino, Salsa |
| 146 | Studio Album | Cero A La Izquierda | Cero A La Izquierda | Post-punk |
| 160 | Demos | Demos | Dermis Tatú | Rock alternativo |
| 194 | Demos | Demos | Grillos Mientras Tanto | Funk |
| 261 | Studio Album | Demos | Los Mesoneros | Rock alternativo |
| 272 | Demos | Demos | Marilanne | Dance, Electropop, Indie rock, Pop punk, Power pop, Rock alternativo |
| 287 | Studio Album | Vendrán Por Ti | Mochuelo | Pop rock |
| 306 | Single, Remix | Ya No Más | Pzoom | Pop rock |
| 328 | Studio Album | Vol. 1: Música Popular y Folklórica Venezolana | Serenata Guayanesa | Balada, Fusión latina, World ethnic |
| 341 | Demos | Demos | Superglicerina | Hip hop |
| 428 | B-Sides | B-Sides: Miss Mujerzuela | Caramelos De Cianuro | Rock |
| 430 | B-Sides | B-Sides: El Viaje De Una Vida | Claroscuro | Rock |
| 456 | B-Sides | B-Sides: A.T.C. | La Calle | Pop rock |
| 517 | Studio Album | 2 Lados B | Caramelos De Cianuro | Rock |
| 519 | EP | N[u(n)clear] | SyncroDynamic | Dance, Indie rock, Rock alternativo |
| 538 | Solo Artist, EP | Futuro: Lado A / Lado B | Reyes | Rock |
| 544 | B-Sides | B-Side: Harakiri City | Caramelos De Cianuro | Rock |
| 547 | EP | EP | Dermis Tatú | Rock alternativo |
| 548 | Demos | Inéditas | Dermis Tatú | Rock alternativo |
| 550 | EP | EP | El Quinto Combo | Salsa |
| 554 | EP | EP | Joudy Ju | Indie rock, Pop, Post-hardcore, Space rock |
| 556 | EP | Sonó Así | La Vida Bohème | Rock alternativo |
| 563 | Solo Artist, EP | Sonó Así | Nana Cadavieco | Pop rock |
| 566 | B-Sides | B-Sides: En Vivo En El Teatro Nacional | PAN | Fusión latina, Hip hop |
| 567 | EP | Sonó Así | Pzoom | Pop rock |
| 568 | B-Sides | B-Side: El Amor Ya No Existe | Sentimiento Muerto | Rock |
| 571 | Studio Album | Vol. 2: Música Popular y Folklórica Venezolana | Serenata Guayanesa | Balada, Fusión latina, World ethnic |
| 592 | EP | Sonó Así | Viniloversus | Rock |
| 614 | Demos | Demos | Soleà | Experimental |
| 620 | Single | Sanitarios | Caramelos De Cianuro | Rock |
| 621 | Single | La Costura | Americania | Rock alternativo |
| 622 | Single | Ella | Billy Se Fue | Indie rock, Rock alternativo |
| 623 | Single | Himno Vinotinto | Caramelos De Cianuro | Rock |
| 626 | Single | Mundo Porno | Los Mentas | Rockabilly |
| 627 | Single | Poco | Pixel | Rock |
| 631 | Single | Entrada De Bala | Zapato 3 | Rock |

Vía recomendada: **regla «el derivado lleva el género documentado del artista»** — single/EP/demo/
B-side de un artista con género confirmado hereda (run auditable con `decideGenre`, motivo
«herencia de artista documentado», reversible; rol principal = principal del artista, resto secundarios).
Casos multi-género (Marilanne 6, Joudy 4, Bacalao 3, Sincro 3, Serenata 3, LPE 2, PAN 2, Billy 2):
recomendado principal del artista; si el disco contradice (p.ej. 53 Elefreak: artista = prog/sinfónico
pero la banda era hard rock) → a revisión.

## Arquetipo B — Compilados sin página en ninguna fuente (14)

- 380 | Compilation Album | El Pop Venezolano
- 386 | Compilation Album | La Perfección Del Sonido
- 391 | Compilation Album | Pepsi Music: Pide Más
- 393 | Compilation Album | Recuerdo De Mis 15 Años
- 394 | Studio Album | Se Llama Simón
- 397 | Compilation Album | Sonicosubte
- 399 | Compilation Album | U-Rock Discos
- 487 | Compilation Album, Remix | Simón Díaz Remixes
- 582 | Compilation Album | El Subte Venezolano
- 589 | Compilation Album | Venezuela Electrónica Vol. 3 "Mestizo"
- 639 | Compilation Album | Harakiri City: Tributo A Caramelos De Cianuro
- 640 | Compilation Album | Rock: "El Compilado" Vol. 1
- 649 | Compilation Album | Borrachos y Bolingas Vol. 4 "Todos Contra Todos"
- 656 | Compilation Album | Rock: "El Compilado" Vol. 2

Evidencia YA lista (solo falta criterio/OK):
- 649 Borrachos Vol.4: la serie documentada como «movida punk» (Oídos Sucios, Vol.1); la nuestra
  Vol.3 ya es Punk; la página del Vol.4 no existe → ¿serie hereda?
- 640/656 «Rock: El Compilado» 1-2: «Rock» está en el nombre; mismo criterio ya aplicado a 641
  (Ska & Punk, vía Rockzuela).
- 589 VE Vol.3 «Mestizo»: único de la serie sin género (Vol.1/2 y Pop/Chill ya son electrónica) → serie hereda.
- 639 Tributo a CDC: el padre (CDC) es Rock; el tributo agrupa bandas de rock.
- 487 Simón Díaz Remixes + 394 Se Llama Simón: decidir con fuente (proyecto Simón Díaz).

Pasada web pendiente (receta `evidence-web-sweep`): 380, 386, 391, 393, 394, 397, 399, 487, 582
(Brave + site:oidossucios|vzlarockea|rockhechos|rockzuela|venciclopedia + release-ID de Discogs
desde snippets).

## Arquetipo C — Artistas sin género documentado (10)

- 65 | EP | Elektra — Transformer
- 133 | Demos | Cangrejo — Inéditas
- 311 | Studio Album | Radio Tigre Internacional — Radio Tigre Internacional
- 349 | Studio Album | The Last April — The Last April
- 455 | Solo Artist, Studio Album | Juan Carlos Torrealba — No Voy Sin Ti
- 552 | EP | Gasolina — EP
- 564 | EP | Niuno Niotro — EP
- 573 | EP | Sin Comentarios — EP
- 574 | EP | SMAG — EP
- 575 | EP | Tha Chewbacca Project — EP

Doble trabajo (primero documentar al artista): pasada web dirigida; evidencia ya vista:
552 Gasolina («blues criollo», El Estímulo). Al quedar documentado el artista, sus discos caen por la regla de A.

## Residual — cierre honesto

Lo que ninguna fuente publique tras A+B+C se cierra con nota documentada (mismo criterio que los
«598 discos sin lista publicada»), sin inventar y sin re-buscar.

## Etapas

1. Aprobar regla A + serie B + aplicar evidencia lista → ~50-55 fichas (2 runs + verificación).
2. Pasada web para B/C restantes (~15 consultas) → +5-10.
3. Cierre documentado del resto (~10-15) → fin con ~99% del set con género o cierre explícito.

## Cuidados

- El artista «Various Artists» tiene un género **Punk** (`auto:laya`, p=0.64, texto rockdevzla —
  colateral de la era Laya): NO usarlo para herencia de compilados; revisar/retirar aparte
  (probable dato espurio).
- Runs reversibles con motivo por ficha; re-exportar la hoja al ejecutar (es viva).

## Ejecutado (2026-09-30, noche)

- **Etapa 1 — herencia (A)**: los 48 derivados heredaron el género del artista
  documentado (48 principales + 20 secundarios = 68 filas, 0 errores). Cada nota
  lleva la regla: «si una fuente publicada nombra otro género, LA FUENTE GANA».
  Excluido «Various Artists» de la herencia (su Punk es colateral auto:laya).
- **Etapa 2 — evidencia lista + fuentes (B/C)**: +15 fichas. Por libro de fuente:
  589 (Oídos Sucios: «compilado de música electrónica nacional») y 487 (Discos
  Venezolanos: remixes de «la movida electrónica venezolana») → Electrónica. Por
  criterio aprobado: 649→Punk (serie Borrachos), 640/656→Rock (nombre de serie),
  639→Rock (tributo a CDC). Artistas documentados con sus EP: 65→Electrónica
  (vzlarockea), 552→Blues (Alba Ciudad/Havana Times), 573→Rock, 574→Rock,
  133→Rock (vzlarockea + prensa 2025), 564→Rock, 349→Metal (vzlarockea labels).
  Runs 10702–10721.
- **Resultado**: set sin-Live 469 → **458 con género (97,7%)**, 11 pendientes.
  553 Listed → 45 vídeos sin género. Canal completo 609 → **38 discos sin género
  (93,8% con)**.
- **Pendientes finales (11, cierre honesto)**: compilados sin fuente en ningún
  archivo probado — 380 El Pop Venezolano, 386 La Perfección Del Sonido,
  391 Pepsi Music: Pide Más, 393 Recuerdo De Mis 15 Años, 394 Se Llama Simón,
  397 Sonicosubte, 399 U-Rock Discos, 582 El Subte Venezolano — ; artistas sin
  fuente — 311 Radio Tigre Internacional, 455 Juan Carlos Torrealba, 575 Tha
  Chewbacca Project.
- **Jerarquía de género (Brian, 2026-09-30)**: fuente > Laya > heredado —
  `docs/curation/PRIORIDAD_GENEROS_2026-09-30.md`.

## ¿Laya para los 11? (evaluado 2026-09-30 noche)

- El expediente de Laya (`export-laya-dossiers.ts`, regla del 26/27) solo envía fichas con
  TEXTO PROPIO que nombre el género. De los 11: solo **455** entró (texto: «llanero» →
  opción Folk); **Laya se abstuvo** (folk 0,33 vs evidencia_insuficiente 0,67). **311** y
  **575**: su texto no nombra género → sin opciones. Los **8 compilados**: excluidos por
  diseño (VARIOUS: el texto de compilado nombra canciones y bandas ajenas, no un estilo
  propio).
- Con la exclusión V.A. levantada solo para compilados cuyo texto propio describa el
  conjunto, **380** («pop venezolano») y **582** («rock y la electrónica») tendrían
  opciones; los otros 6 no nombran género en ninguna parte.
- Datos que SÍ existen de los 11 (para constancia): descripciones de ficha y descripciones
  de vídeo completas (tracklists, músicos, sellos, participantes) — p. ej. 455 con
  arpa/cuatro/piano llanero y créditos; 397 con la escena subterránea y sus músicos; 399
  con cuatro bandas y versiones acústicas; 582 «serie Venezuela Pop and Rock».
- Laya corre local (`~/.venvs/laya`, checkpoint multilingual ya en caché): 1 caso = 29 s.

## Simulación «sin exclusión V.A.» (2026-09-30 noche) — Laya y los compilados

Corrida en copia temporal del exportador (`tmp-analysis/fullalbum/export-dossiers-nonva.ts`,
sin tocar `scripts/`); la simulación quedó en /tmp y las predicciones se aplicaron después con `apply-laya-genres.ts --confirm` (run 10723 — ver «Aplicado» abajo). Entraron 4 de los 8 compilados
(los otros 4 no nombran género ni con la exclusión levantada):

| disco | opciones del texto | Laya | nota |
|---|---|---|---|
| 380 El Pop Venezolano | pop | **pop 0,88** | sobre el umbral 0,75 → único confirmable |
| 399 U-Rock Discos | rock | rock 0,73 | bajo el umbral — y la opción nace del NOMBRE DEL SELLO «U-Rock» |
| 582 El Subte Venezolano | pop, rock, electronica | rock 0,53 | bajo el umbral |
| 386 La Perfección Del Sonido | trance | trance 0,52 | opción ESPURIA: «trance» viene del nombre de banda «Trance Nuance» |
| 455 (ya corrido) | folk | abstención 0,67 | — |
| 311, 391, 393, 394, 397, 575 | — | sin opciones | nada que predecir |

Lección: `mentioned()` puede tomar un género dentro de nombres propios (bandas/sellos:
«Trance Nuance», «U-Rock»). Si algún día se levanta la exclusión, filtrar nombres propios
en las opciones. Neto del ejercicio: **1 confirmable (380), 2 sugerencias débiles para ojo
humano (399, 582), 1 opción mala (386), 6 sin caso**.

### Aplicado (2026-09-30, noche)

- `apply-laya-genres.ts --confirm` (dossiers/predicciones v9 en `reports/`): **run 10723**,
  1 confirmada — **380 → Pop** (p=0,88, actor `auto:laya`; motivo: ficha del canal +
  descripción del vídeo Tg7B6twCLKU). Log `genre_assignment_log` #13972; proyección
  `albums.genre` = «Pop». Los otros 3 casos quedaron fuera por umbral (399 0,73 · 582 0,53
  · 386 0,52; 455 no entró).
- Conteos tras aplicar: set sin-Live **459/469 (97,9%)** → **10 residuales** (7 compilados
  —386, 391, 393, 394, 397, 399, 582— + 311 Radio Tigre, 455 JC Torrealba, 575 Tha
  Chewbacca). Canal completo 609 → **37 discos sin género (93,9% con)**. 553 Listed →
  **44 vídeos sin género** (380 tiene 1 vídeo Listed; verificado en el CSV vivo).
- Archivos: `reports/genre-laya-dossiers-comps-v9-2026-09-30.jsonl`,
  `reports/genre-laya-predictions-comps-v9-2026-09-30.jsonl`,
  `reports/genres-laya-accept-{dry-run,confirm}-v9-2026-09-27.json` (+ copia en la
  skill `crv-coleccionistas`, carpeta `scripts/canal-fullalbum-2026-09-30/`).
