# Etapa 1 — Aplicación de la cosecha web + RYM al catálogo (2026-10-01)

Alcance: aplicar TODO lo cosechado (fuentes web dirigidas + barrido RYM asistido) como runs
reversibles con claim + evidencia por campo. Runs `10870`–`10890` (`ok`), reportes JSON por
fase en `reports/apply-*.json`. Respaldo previo (dump dirigido sin la tabla ER):
`/mnt/datos/backups/crv/crv-pre-web-etapa1-20261001T185815Z.dump` (1,28 GB, sha256
`be9e4c9c…4611`). Nota de concurrencia: otra sesión de agente trabajó el repo en paralelo
(fusiones y altas propias, p. ej. «Malegua» 18:59); cada escritura midió actividad antes.

## Fuentes y páginas crudas (run 10870)

Seis fuentes nuevas registradas con `enabled=false` + `review_queue(kind=new_source)` ×6
(aprobación manual pendiente — gobernanza CONTRACT §3 / SOURCES §6):

| slug | id | contenido |
|---|---|---|
| wikipedia | 8788 | 140 artículos (rock venezolano) |
| musicavenezuela | 8789 | 108 fichas |
| rockshop | 8790 | 3 páginas |
| paltoque | 8791 | 1 |
| laguiadecaracas | 8792 | 1 |
| rateyourmusic | 8793 | 571 (barrido por navegación humana de Brian) |

**824 páginas crudas** almacenadas en `ingest.raw_pages` (0 fallos) + copia sha256 en
`data/raw/<slug>/`. Para RYM, la URL exacta de cada HTML se reconstruyó desde el estado del
cosechador (pitfall: el sanitizado de nombres de archivo elimina `%`).

## Entidades

- **Artistas: 7 creados** — Cuásar, GeneraSion, La Vesper, Proyecto Fenyx, «R», Rolling Band,
  Sexeappeal (nombre, tipo banda, biografía, ciudad, año de formación; claims por campo).
  Excluidos con motivo: «bandas que definen el rock Venezolano» (artefacto de parseo),
  La Granja (sin verificación fuera del blog), Winds of May (ya existía en el catálogo),
  La Vesper/paltoque (duplicado del de Wikipedia). **Malegua**: la creó la otra sesión a las
  18:59 (su ficha ganó; la nuestra no duplicó — ER `already_exists`).
- **Biografía**: Caramelos de Cianuro (id 58) → 1.107 caracteres desde Wikipedia. La bio previa
  era «Rock venezolano» (etiqueta de género, 15 caracteres, única en el catálogo) →
  reemplazo documentado y reversible por field journal.
- **Discos: 80 creados** de 95 planificados:
  - 74 directos + **6 adjudicados con `allowSimilar`** tras revisar el candidato del ER uno a
    uno (Cecilia Todd con Barrio Obrero de Cabimas 5598, Cecilia Todd Vol. 3 5599, Desorden
    Público En Vivo 5600, Canto Popular 25 años 5601, Desorden Público Reedición 20 años 5602,
    Superpop Venezuela Remixes 5603).
  - 8 saltados (ya existían como obra): Live in Paris Lado A/B, DP18, Aditus «Ni en concierto…»,
    No Más Violencia, Museo de los Pillos, Esplendor/Mirador E.P.
  - 1 ya existía (Diáspora Vol. 1).
  - **6 en cola de revisión** (ambiguos genuinos, con aviso abierto): Bitsessions, Tiempo
    Compartido, P.O.P / Rarezas, Aquí, Viva Navidad-Sesiones en Petit Comité, Comienza la
    Leyenda. Recomendación para 4 de ellos: (Bitzsessions↔Acústico En Bits Session) y
    (Comienza la Leyenda↔Comienza La Historia) parecen el MISMO trabajo con título variante →
    alias, no ficha nueva; (P.O.P/Rarezas) y (Viva Navidad-Sesiones) requieren ojo humano.
- **Personas: 13 creadas** (Wikipedia, con guardas y claims). Excluidos: Vicente Arcuri (ya
  existía), Recordatorio (proyecto musical, no persona). Normalizaciones: Danian (nombre real
  Daniel Perdomo), Jeremías (nombre real Carlos Eduardo López Ávila). Sin avisos de ER.
- **Fotos: 17/17 asociadas a archivo local** (8 artistas de MusicaVenezuela + 9 personas de
  Wikipedia). 14 descargadas por `media:localize`; 3 (Hernán Hermida, Miguel Ángel González,
  Ryan Cox) copiadas de los archivos locales de la captura porque `upload.wikimedia.org`
  devolvía HTTP 429 desde la IP — documentado en `reports/web-fotos-locales-2026-10-01.json`.
  Todas con archivo verificado en `web/public/media/` y URL local `/crv/media/…`.

## RYM

- **634 anclas de identidad** (claims de nombre + URL RYM como evidencia; sin tocar el core)
  para artistas del catálogo presentes en las listas: 617 por nombre exacto + 17 por alias.
  3 se re-apuntaron a la ficha superviviente por fusiones recientes de la otra sesión
  (Gorepriest→Sol Nocturno 870, Abraxas→Kolman 332, Okkvlt→Cthonica 672).
- **Fechas: 383 campos en 165 personas** — 136 nacimientos, 42 fallecimientos, 160 ciudades de
  nacimiento, 45 marcas de fallecido; solo campos vacíos (42 filas filtradas por ya tener
  valor). Ledger reproducible: `tmp-analysis` + `/tmp/crv-recon/prep-rym-ledgers.py`.
  Personas con fecha de nacimiento: **481 → 615**.

## Verificación (medida)

- `ingest.scrape_runs` 10870–10890 en `ok`; reportes por fase con `errores=0` (los 3 FK se
  resolvieron redirigiendo; los 3 HTTP 429 con los archivos locales).
- `raw_pages` 824 · claims: rateyourmusic 1.017 (634+383), wikipedia 157, musicavenezuela 92.
- Sin basura: «La Granja» 0 fichas, «bandas que definen…» 0, «Winds of May» 1 (la existente).
- Avisos abiertos que deja la etapa: **6 `new_source`** (aprobación de fuentes) + **20
  `album_match`** (cola de revisión de discos, arriba) + 1 `person_match`/alias menores de la
  otra sesión.

## Pendiente (etapa 2)

Géneros (Laya/DeepSeek sobre lo recién creado), bios restantes, cierre de la cola de alias
(490), clasificación de alcance de los 1.591 candidatos RYM, y triaje de los 6 avisos
`new_source`.
