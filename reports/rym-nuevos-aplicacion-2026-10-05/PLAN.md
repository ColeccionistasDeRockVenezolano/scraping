# Plan de aplicación · cosechas RYM «nuevos», enlaces y fuentes web (2026-10-05)

Decisiones de Brian (2026-10-05): discos «completar + altas»; enlaces como candidato y en la web
solo lo confirmado; redes sociales en su propio campo (0040 `social_links`); por etapas con
ensayo, reporte y OK antes de `--confirm`. Todo en runs reversibles (diario 0028).

## Etapa 1 · Discos y fichas desde RYM «nuevos»

| paso | qué | dónde queda | estado |
|---|---|---|---|
| 1.1 | Altas de discos (3.270) | `public.albums` + claims/evidencia RYM | ensayo: 2.859 crear · 34 crear a sabiendas · 279 a la cola ER · 41 repetidos dentro del plan · 56 errores de tipo «na» (corregidos, falta re-ensayar) |
| 1.2 | Re-correr `plan-discos.py` | los discos nuevos pasan a «ya existe» | tras 1.1 |
| 1.3 | Pistas y duraciones (solo discos sin pistas) | `public.tracks` (`duration_seconds`) | ensayo ok (existentes: 8 discos, 94 pistas) |
| 1.4 | Año (solo discos sin año) | `albums.release_year` | ensayo ok (2) |
| 1.5 | Géneros de disco (solo sin principal) | `ingest.album_genres` | ensayo ok (163; 22 términos fuera de la taxonomía) |
| 1.6 | Géneros de artista (solo sin principal) | `ingest.artist_genres` | por construir (551 con géneros RYM, 466 sin principal) |
| 1.7 | Año de formación (solo vacío) | `artists.formed_year` | por construir (13) |
| 1.8 | Portadas | vacía → `albums.cover_url` (copia local); con imagen → Curaduría · Imágenes | tras 1.2 |
| 1.9 | Discos cuyo dueño solo existe como persona (1.451) | — | **decisión de Brian** (mezcla extranjeros y venezolanos) |

Fotos de perfil: RYM no dio ninguna real (las 1.059 «fotos» son portadas).

## Etapa 2 · Enlaces de escucha y redes

| paso | qué | estado |
|---|---|---|
| 2.1 | Esquema `social_links` (0040), API (`platforms`, `socials`), iconos en la web | hecho (dev); falta desplegar |
| 2.2 | Identidad MusicBrainz (2.256 artistas) | hecho: 567 confirmados · 601 contradicen país · 387 sin datos · 701 sin candidato |
| 2.3 | Re-elección de Deezer por discos en común (816) | hecho |
| 2.4 | Cosecha de los 60 artistas creados hoy | hecho; falta su pasada de identidad |
| 2.5 | Aplicar (`apply-streaming-links.ts`) | tras ensayo final y OK |
| 2.6 | Pase de Spotify | espera ventana sin 429 |

## Etapa 3 · Bios

5 bios de RYM (solo fichas vacías); los 60 nuevos sin ficha RYM.

## Etapa 4 · Fuentes web ya cosechadas (2026-10-01) — remanente medido

Lo creado el 2026-10-01 (etapa 1 web): 7 artistas, 80/95 discos, 13 personas, 17 fotos, 1 bio.
Archivos: `data/raw/fuentes-web-2026-10-01/consolidado/` y `pages/`.

| fuente | remanente aplicable (solo vacíos) |
|---|---|
| MusicaVenezuela (108 fichas) | 19 bios · 13 fotos de artista · 4 géneros de artista · 11 portadas · 2 años · 78 discos que faltan (13 ya planeados el 10-01, 65 nunca planeados) |
| Wikipedia — bandas y músicos (140 artículos) | 8 años de formación · 1 foto · 124 discos de sus tablas de discografía que faltan |
| Wikipedia — artículos de disco (49) | 2 sellos en los 17 que casan; 32 sin artista leído del infobox → leerlo de la categoría «Álbumes de X» (9 con lista de pistas) |
| Rockshop · Paltoque · La Guía de Caracas (30 bandas) | sus 29 bandas ya tienen bio; solo aportan miembros, formación y estilo (revisión) |
| El Estímulo | **no fue capturado**; hay que capturarlo (1 artículo) |
