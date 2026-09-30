# Cierre de los 12 hallazgos + cosechas de portadas, fotos y años — 2026-09-30

Retomado por Hermes (deepseek-v4-flash) por pedido de Brian: «enfócate en descubrir — portadas 453,
fotos 2.279, años 207 y los 12 errores abiertos». Todo corre sobre la base viva y quedó en runs
auditables (merge_run + claims + merge_audit + journal por campo). Números finales al cierre:

| Frente | Antes | Después | Nota |
|---|---|---|---|
| Hallazgos abiertos | 12 | **0** | scan 481: 0 nuevos · 0 reabiertos |
| Discos sin año | 207 | **138** | 69 recuperados |
| Discos sin portada | 453 | **430** | 23 recuperadas |
| Artistas sin foto | 2.279 | **2.263** | 16 recuperadas (con verificación por visión) |

---

## 1 · Hallazgos de curaduría: 12 → 0 abiertos

| Hallazgo | Qué era | Cierre |
|---|---|---|
| 340587 · duración atípica pista 34962 «Un Buen Perdedor» = 950 s | El 950 salió del vídeo del concierto mal calculado: al no matchear la pista siguiente («Ay Dios»), la duración se estiró hasta el final del vídeo | **Corregida a 224 s** (run 10726): timestamps del vídeo 01:42:59→01:46:43 = 224 s y Apple lista 3:44 = 224 s |
| 340666 · disco 4078 «Mil y Una Historias En Vivo» con 6 pistas sin duración | Faltaban por no matchear en la descripción del vídeo | **Completadas desde el álbum oficial** (Apple, mismo tracklist de 27): Tengo 249 · Ay Dios (Cigala) 303 · Te Veo Venir 261 · Tengo Tropical 253 · Intro 144 · Ay Dios 351 |
| 5355 · pista 23007 «4641 NW» (anomalía «pocas letras») | Falso positivo | **Ignorado con motivo**: la pista existe (Sincopa la lista; Apple la publica como «4641 Nw») — es una dirección, coherente con el disco «Las Calles De Mi Ciudad» de Pocho Serra |
| 340658–340663 · 6 revisiones ambiguous_alias (249924–249929) | Pistas nuevas del canal compartían título con pistas de publicaciones distintas | **Dismissed con nota** (publicaciones distintas; no se fusionan ni se comparte alias global) |
| 340667 · «Cangrejo & Kreils» (artista 56 vs 2946) | El alias «Cangrejo & Kreils» estaba en la banda Cangrejo (56) por un claim de YouTube de baja confianza | **Entidades distintas**: la sesión ViveConCancha (2016) es la colaboración de Abraham García «Cangrejo» (†) con Kreils García «G4RC14» (créditos del vídeo). Alias retirado de 56 (run 10727); el disco queda en «Cangrejo & Kreils» (2946) |
| 340664 · disco 5119 «Tiempo Nos Queda» (Viniloversus) sin pistas | No es álbum: **documental** de PlanetaurbeTV (2010, 6 episodios) | **Ignorado con motivo** (ficha creada a propósito para el vídeo del canal; sin lista de canciones) |
| 340665 · disco 5120 «Detrás De La Puerta» (Zapato 3) sin pistas | No es álbum: **documental** de Pericles Sánchez (2010, vídeo retirado de YouTube) | **Ignorado con motivo** |

Verificación: scan 481 → **0 nuevos · 0 reabiertos · 7 resueltos · 0 abiertos**.

Herramientas: `tmp-analysis/errores-abiertos-2026-09-30/` (fix-dur-4078.mts, cerrar-hallazgos.mts,
cerrar-reviews.mts, apply-album-years.mts, revert-artworks.mts, harvest-years-feeds.py,
harvest-covers-feeds.py, recover-covers-sincopa.ts).

---

## 2 · Años de lanzamiento: 207 → 138

- **66 aplicados (run 10730)** desde los feeds de Blogger ya guardados: el año vive en el título del
  post («Artista - Álbum (Año)»). Cosechador: `harvest-years-feeds.py` (offline, match exacto
  artista+título; 2 dudosos por rango «2006-2007» quedaron aparte).
- **3 más (run 10738)** desde tiendas (`discover-album-years.ts`): 799→2013 (MusicBrainz),
  4623→1985 y 4660→1984 (Apple). El candidato de «Promo 2017» (Discogs 2019 vs título 2017) quedó
  fuera por conflicto.
- Residual 138: mayormente metal underground sin ficha de tienda ni página con año; MusicBrainz
  devolvió 503 en la corrida (16 fallos). Reintentable con el mismo descubridor.

## 3 · Portadas: 453 → 430

- **Deezer: 12** (`discover-deezer-covers.ts`, match exacto único).
- **Sincopa: 5** (páginas cdinfo ya guardadas + verificación estricta con el adapter —
  `recover-covers-sincopa.ts`).
- **Feeds Blogger: 6** (`harvest-covers-feeds.py`, imgs embebidas en los posts).
- iTunes retry y Discogs: **0 candidatos** para el residual (no están en esas tiendas).

**Diagnóstico del residual (430):** ~232 son de Sincopa **sin página cdinfo guardada** (el claim
apunta a la página del artista, que no trae portadas). Siguiente ola: crawl dirigido de las páginas
de disco de Sincopa (por su índice de discografías) — y Bandcamp (vía Scrapling) para indie activo.

## 4 · Fotos de artistas: 2.279 → 2.263

- **Deezer** (`discover-deezer-artist-photos.ts`, nuevo): 1.523 artistas con disco consultados →
  158 candidatos con nombre exacto único + disco compartido. **Pero Deezer rellena la «foto» del
  artista con artwork/logo/placeholder cuando no tiene retrato**: 98 se descartaron
  automáticamente (hash del picture idéntico al de alguna portada) y de los 60 restantes, la
  clasificación con visión por mosaicos (6 contact sheets) dejó **15 fotos reales** (el resto:
  artworks, logos y placeholders grises). Aplicadas 14 (una no descargó). **144 reversiones** en
  runs 10739/10740 (journal + audit), y el descubridor ahora excluye los artwork por hash para
  futuras corridas.
- **Wikidata/Commons: ~3** (estricto P18 + Venezuela). **51 imágenes siguen bloqueadas por 429 de
  Wikimedia** (rate limit por IP); quedó lista la vía por redirect de `Special:FilePath` en
  `localize-images.ts` (sin pasar por el api.php) para el reintento.
- **Discogs: 2** (identidades ya matched, descargadas por el localizador).
- Ledgers: `reports/media-deezer-artist-{candidates,doubts,artworks,nofoto}-2026-09-30.jsonl`.

## 5 · Verificación

- **Visión**: portadas 593, 212, 3414 ✓; fotos 2679, 1414, 21, 1145, 1880… (clasificación completa
  de las 60 de Deezer por mosaicos); artworks detectados y revertidos.
- `npm run typecheck` ✓ · ESLint de los scripts nuevos ✓ · manifest de medios consistente
  (entradas revertidas eliminadas).

## Pendientes documentados (siguiente ola)

1. **Crawl dirigido de Sincopa** (cdinfo) para ~232 portadas.
2. **Reintento de Commons** (51) cuando expire el 429.
3. **1538 (Jesús Tomed)**: reintentar la descarga de su retrato (candidata válida que no bajó).
4. Residual de años (138): re-correr `discover-album-years.ts` (MusicBrainz estaba en 503) y buscar
   años en páginas de fuente que aún no se guardan.
5. Dudas de fotos de Deezer (590 «solo discos genéricos/sin disco común») y de años (dudosos):
   revisión manual si se quiere ampliar.
6. Bandcamp (Scrapling) como fuente extra de portadas/fotos para indie activo.
