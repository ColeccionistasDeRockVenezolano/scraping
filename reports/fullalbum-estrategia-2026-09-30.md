# Canal «Full album» — estrategia y resolución (2026-09-30)

## La estrategia

Una sola pasada, tres fuentes por vídeo, cero invención:

1. **La hoja manda para identificar**: la hoja del canal (663 filas) es la fuente de
   identidad (artista, disco, año, tipo de la subida, estado del vídeo). El catálogo se
   audita CONTRA la hoja.
2. **La descripción del vídeo es la fuente de contenido**: los vídeos del canal traen
   *tracklists con timestamps* en la descripción; de ahí salen títulos, orden y
   duraciones (diferencia entre marcas consecutivas; la última contra la duración del
   vídeo). Es la misma técnica de la campaña de biografías.
3. **Tiendas y API como contraste**: Deezer/iTunes (duraciones reales de tienda) y
   Backcamp/Deezer/iTunes para géneros; YouTube Data API para sincronizar y enlazar
   los vídeos (yt:link). Nada se escribe sin claim + evidencia + auditoría.
4. **Cierre honesto**: lo que ninguna fuente publica se marca en la hoja y se documenta;
   lo que ya existe en una ficha gemela se unifica (merge) en vez de duplicar.

## Los cuatro encargos

### «Identificar 77%» (cobertura de género)
Lectura del dato: de las 632 fichas del canal, 488 traían género (77,2%). Estrategia: re-correr el cosechador de tiendas del canal SOLO sobre los 147 discos sin género (144 + 5 fichas nuevas) con una pasada fresca (libros del 27-sep respaldados). RESULTADO: procesó 93 discos (filtro de alcance) × Bandcamp/Deezer/iTunes → 5 hallazgos, 2 fichas únicas, ambas «hijo más preciso ya confirmado» → principal fijado con decideGenre (runs 10623/10624): Garnica «Tech house», Canserbero «Boom bap». Yield del resto: 0 (saturado). Cobertura con principal: 463/608 (76,2%); sin ningún género confirmado: 145 (23,8%).

### Tipo de disco según la hoja
Auditoría completa hoja↔catálogo (632 fichas). Los desajustes se concentran en clases
que describen el VÍDEO, no el disco («Music Video» ×15, «Live Concert» ×6: sus álbumes
son discos de estudio y no se tocan). Cambios aplicados:
- **Candy66 «Acústico En Bits Session»**: other → **live_album** (hoja: «Live Concert,
  Documentary»; la descripción del vídeo lo confirma: grabado en vivo en Backstage
  Studios, 2010). Run 10621.
- Casos dudosos documentados sin cambio (hoja contradictoria o imprecisa): Los Mesoneros
  «Demos» (hoja Studio Album / catálogo demo), El Clan Spiteri «De Vuelta A Los 60s»
  (hoja Studio+Compilation), Los Mentas «Reserva Añeja» (hoja Compilation), Babylon
  Motorhome «Viva La G.A.N.Ya!» (hoja Live Album), PAN «B-Sides: En Vivo…» (hoja B-Sides /
  catálogo live_album), Hana Kobayashi «Smells Like Teen Spirit» (hoja Live Concert, Single).
- Las 5 fichas nuevas se crearon con el tipo de la hoja (Documentary→other,
  Live Concert→live_album, Single→single).

### Duraciones completadas + columna en la hoja
Completadas con fuentes (runs 10610/10611; claim+evidencia+auditoría por pista):
- **Mermelada Bunch «15 Años En Concierto»**: 16/16 desde Deezer.
- **Candy66 «Acústico En Bits Session»**: 8/8 desde los timestamps del vídeo.
- **Franco De Vita «Mil y Una Historias En Vivo»**: 21/27 desde el concierto del canal.
- **V.A. «Venezuela Electrónica Vol. 3 Pop»**: 1/1 (última pista, marcada al final del vídeo).
- Pendientes reales (sin fuente): Gillman «Escalofrío» 1/28 (la pista «Escalofrío
  (Final)» no está en el listado del vídeo), Borrachos y Bolingas Vol. 3 1/30 (el listado
  repite 38:41 en las pistas 16-17) y FdV 6/27 (4 bonus de estudio + «Ay Dios» del cierre).
- **Columna L de la hoja** («Duraciones (CRV, 30-sep)», escrita y verificada en el export):
  L431 «FALTAN 1/28» · L345 «FALTAN 1/30» · L561 «FALTAN 6/27» · L560 «completadas 30-sep» ·
  L571 «completadas 30-sep» · L651 «completada 30-sep».

### «Crea la pista faltante»
El disco «sin pistas» era la ficha gemela **587 «Tributo a CDC: Harakiri City»** (vacía;
subida Unlisted) del tributo que YA tiene las 13 pistas completas en **639 «Harakiri City:
Tributo A Caramelos De Cianuro»**. Resolución: **unificación 587 → 639** (merge de álbum,
run 10613; antes se degradó el enlace primario duplicado que bloqueaba la fusión — hallazgo
de `mergeAlbums` con dos primarios). Queda una sola ficha con sus 13 pistas.

## Resolución del listado «SIN FICHA»

**Fichas creadas (5)** — runs 10615/10617/10618/10619/10620:
| Disco | Álbum | Notas |
|---|---|---|
| Gasolina — Blues Criollo (2005) | 5122 | documental; 5 pistas con duración (timestamps); vídeo vinculado (bePwD424LvA) |
| Viniloversus — Tiempo Nos Queda (2010) | 5119 | documental en 6 episodios (PlanetaurbeTV); vídeo vinculado (pcS_p4F-cm0) |
| Cangrejo & Kreils — Live Sessions At ViveConCancha (2016) | 5123 | artista nuevo (2946, dúo); 3 pistas con duración; vídeo vinculado (zgUvEQd92Qg) |
| Zapato 3 — Detrás De La Puerta (2010) | 5120 | documental de Pericles Sánchez; vídeo retirado de YouTube |
| La Puta Eléctrica — Mentiras Embrujadas (2002) | 5121 | single; 1 pista (2:13); vídeo retirado |

**Casi-sin-ficha (5)**:
- Franco De Vita «Mil y Una Historias En Vivo» (4078): vídeo sincronizado y **vinculado**.
- Todosantos «Aeropuerto» (353): vídeo sincronizado y **vinculado** (LXR4tlsLlcw).
- Viniloversus «El Día Es Hoy» (541), Telegrama «Country Club» (539), Sónica «B-Sides» (543):
  sus vídeos están **retirados de YouTube** (la API ya no los devuelve): fichas correctas,
  sin vínculo posible.

**8 filas sin URL**: 6 tienen ficha ya (La Puta Eléctrica ×4, Yátu «Inmortal», Lebronch
«Todos Los Topinos De Lebronch») y 2 son filas «EMPTY» (placeholders). Nada que sincronizar.

**12 vídeos que no son de álbum** (sin ficha por diseño): 2 entrevistas del canal + 1
extracto, 5 reseñas #repost (Babylon Motorhome, Canserbero, Ladies WC, Tribop, V.A.
Psicotomimética), Dermis Tatú «Historia de la banda», Pil Kyu, 2 reposts (Jorge Spiteri,
Vytas Brenner) y el documental de Los Amigos Invisibles («La Casa Del Ritmo»).

## Artefactos
- Toolkit: `tmp-analysis/fullalbum/` (crear-fichas.mts, merge-tributo.mts, desc-*.txt,
  cobertura JSON) y `tmp-analysis/campana-datos-2026-09-30/` (ledgers y aplicadores).
- Cobertura completa del canal: `tmp-analysis/campana-datos-2026-09-30/fullalbum-cobertura.json`.
- Hojas: columna L escrita y verificada contra el export CSV.

## Cosecha profunda de género de los discos listados sin género (2026-09-30)

Pregunta: los 137 discos de los vídeos LISTADOS sin género — ¿tienen género en otras
fuentes? Se probaron, en orden, las fuentes ya autorizadas y sus variantes:

| Fuente | Alcance probado | Resultado |
|---|---|---|
| MusicBrainz | 56 artistas / 43 discos (release-groups VE) | 0 géneros |
| Last.fm (API) | 38 artistas / 69 discos (album.getTopTags) | 0 géneros |
| Wikipedia (es/en) | 55 artistas / 29 discos (artículos de disco) | 0 géneros |
| Discogs | 137 fichas, import+aceptación dirigida (run 10625) | 0 candidatos (568 req de caché → ya estaba agotado) |
| Sincopa (cruce + rastreo del sitio) | 1.609 fichas cacheadas + 65 páginas frescas (índices → páginas de artista → discos) | **7 fichas confirmadas** |

Sincopa funcionó así: índice de artistas (`rock_artists_index.htm`, 668 entradas) →
páginas de artista (21 traídas) → enlaces a discos (`cdinfo_rock/*.htm`) → descarga con
el fetcher oficial (`fetchAndCache`: robots + cortesía) → extracción con el adaptador
Sincopa (campo `genre`) → cruce por identidad artista+título → ledger → `apply-source-genres`.

Confirmadas (Rock, runs 10627/10628, corroboradas por pistas del propio disco):
156 «Supereterodino Sessions» (5/7), 322 «Demos: Sin Sombra No Hay Luz» (3/3),
416 «Showcase: Bésame y Suicídate» (9/12), 593 «Separación Tour» (5/13),
588 «Tributo Lo-Fi A Sentimiento Muerto» = sincopa «Lo-Fi SM» (11/14),
227 «Demos: Nuestra» (5/5), 337 «Demos» de Submarino (3/3).

En espera (ficha Sincopa del lanzamiento madre, SIN corroboración de pistas — decisión
de Brian si se aceptan como derivados): 544, 428, 430, 456, 72, 566, 568, 53.

Balance: de los 137, **7 con género nuevo; 130 siguen sin él** — esos discos no existen
en ninguna de las fuentes probadas (autoediciones, casetes y compilaciones fuera de
catálogo digital). Opciones restantes: cola de revisión humana (la web), inferencia de
audio Essentia (solo como sugerencia, nunca confirma — docs/curation/ANALISIS_AUDIO...)
o sumar una fuente nueva por caso.

## Segunda pasada: buscadores, tiendas y blogs (2026-09-30)

Motivo: Brian — «esos 137 deben tener género en otras fuentes; busca en Google, Brave,
Duck, tiendas de CDs, blogs». Herramientas usadas y resultado medido:

| Vía | Uso | Resultado |
|---|---|---|
| **Brave (API)** | 130 discos × 1-3 consultas (y variantes site:) | descubrió 34 fichas Discogs, páginas Sincopa de compilaciones y blogs de respaldo |
| **DuckDuckGo** (lite/html) | consultas directas y vía Scrapling | captcha/challenge anti-bot (sin resultados) |
| **Google** | consultas y vía Scrapling/camoufox | redirección/consent (sin resultados) |
| **Scrapling (camoufox)** | oidossucios.com (archivo punk VE) | OK — páginas de la serie Borrachos y Bolingas («movida punk venezolana») |
| **Discogs dirigido** | búsqueda API por disco + detalle por release + verificación de artista | **34 fichas confirmadas** |
| **Sincopa** | páginas de compilación descubiertas por búsqueda (fetcher oficial + caché) | **8 fichas confirmadas** (incl. derivados corroborados por pistas) |
| **Blogs/revistas** | rockzuela, 1000flights, vzlarockea, medium, elestímulo, cusica, albaciudad | 1 aplicación (Ska & Punk Venezuelan Bands Vol. 1) + candidatos |

Balance de la jornada: de los 137 discos listados sin género → **43 con género nuevo**
(Discogs 34, Sincopa 8, Rockzuela 1); primarios: Rock 8, Pop rock 6, Synth pop 4,
Techno/House/Ska 3 c/u, Ambient/Experimental 2 c/u, y 12 subgéneros sueltos.
Quedan **94** sin género: singles de bandas conocidas (6), demos/derivados sin
corroboración de pistas (12), compilados sin página en ninguna fuente (14), documentales
y fichas nuevas del canal (5) y otros casetes/rarezas (57).

Candidatos para tu criterio (con evidencia recogida, sin aplicar):
72 LVB (¿«La. vida. Bohéme. Presenta:» 2007?), 53 Elefreak (bandcamp/reverbnation «hard
rock», pero el EP01 no coincide con la pista de la ficha), 649 Borrachos Vol. 4 (la página
de Vol. 1 dice «movida punk venezolana»; el site no tiene la Vol. 4), 382 Encuentro En El
Ruedo (El Estímulo: «nuevo rock nacional»), 5121 Mentiras Embrujadas (Cusica: «radicalidad
punk» en la reseña del álbum), 5120 Detrás De La Puerta (documental «del rock local»),
singles CDC 620 Sanitarios / 58 Rubia Sol / 623 Himno Vinotinto (letras.com: «rock band»).
