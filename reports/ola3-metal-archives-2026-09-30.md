# Ola 3 — Metal Archives: cruce de la lista VE con el catálogo (2026-09-30/10-01)

Contexto: Brian abrió `https://www.metal-archives.com/lists/VE` en su Firefox («rompo el
captcha y tú haces el trabajo»). El challenge managed de Cloudflare pasó solo en el navegador
real; no hizo falta intervención manual.

## Acceso
- La sesión se tomó del perfil de Firefox en texto plano: `cookies.sqlite` → `cf_clearance`
  (`~/.mozilla/firefox/d4qtp99b.default-esr`). Con esa cookie, `curl_cffi`
  (`impersonate="firefox133"` + UA `Firefox/140.0` exacto) responde 200.
- Detalles del sitio que costaron descubrir:
  - La tabla de bandas carga por AJAX: `POST/GET /browse/ajax-country/c/VE/json/1`.
  - Ese endpoint ignora `iDisplayStart`/`iDisplayLength`/`sSearch` (devuelve siempre la
    primera página de 500) pero honra `sEcho` y **`sSortDir_0`** → la lista completa se
    obtiene uniendo una pasada `asc` (500) y una `desc` (500; 111 nuevas): 611 bandas.
  - Los `href` de los enlaces vienen con **comillas simples**; las respuestas llegan en
    **zstd** (usar `r.body` de curl_cffi, no `r.text`).
  - Las imágenes (`/images/…`) responden 200 **sin cookie**; los descargadores masivos de
    Node (undici) reciben **HTTP 429** de Cloudflare (ver Fotos).

## Cosecha
- Fuente nueva: `ingest.sources.slug='metal-archives'` (id 8635).
- 611 bandas de Venezuela (nombre, género, ciudad, estado).
- Cruce contra los 2623 artistas del catálogo (tildes/puntuación normalizadas, variante
  sin-espacios, difflib ≥0.87): **421 matches** — 410 exactos + 3 sin-espacios + 1 fuzzy
  avalado (Anatomiæ Occultii, ligadura æ). 7 casos **excluidos por ambigüedad**:
  - nombres comunes con dos bandas en MA: Agonia, Nemesis, Orion (revisar a mano);
  - fuzzy dudosos: Arpía↔Aria, Bélica↔Belia, Sorthe↔Sorte, SINAPSIS↔Sinopsis.
- 368 fichas de banda descargadas (349 con foto, 336 con «Formed in») + 12 discografías.
- 380 HTML crudos → `data/raw/metal-archives/` + `ingest.raw_pages` (run **10748**).

## Aplicado (todo con claim + evidencia + merge_audit + journal reversible)
| Ítem | Run | Resultado | Cobertura |
|---|---|---|---|
| Año de formación de bandas | **10749** | 328 fichas | sin formed: 2221 → **1893** |
| Años de discos (discografías) | **10750** | 8 discos | sin año: 138 → **130** |
| Fotos de artistas | media:localize (localizar-imágenes) | 322 de 338 candidatas | sin foto: 2260 → **1938** |

- **Fotos**: se descargaron 338 y se clasificaron con visión en 29 mosaicos de 12; 16
  descartes (logos/arte/colajes sin personas legibles): índices 20, 29, 35, 37, 53, 80, 119,
  144, 160, 167, 189, 244, 251, 253, 303, 327. Las 322 aprobadas entraron por
  `media:localize --candidates`; la primera pasada completa dio 94 ok / 228 con HTTP 429
  (throttling de Cloudflare al ritmo 2 concurrentes), y el **reintento lento**
  (`--concurrency 1 --delay-ms 2500`) aplicó las 228: **0 fallos**.
- **Años de discos**: solo 8 con título exacto y año; 42 dudas descartadas (los «laxo» eran
  falsos: p.ej. «Official Promo 2016» no es «Official Promo 2017»). Lista en
  `reports/ola3-ma-album-doubts.json`.
- Claims de la fuente metal-archives: 336 (328 + 8) + las de media-localizer.

## Salvedades
- Los 3 nombres comunes (Agonia/Nemesis/Orion) y los 4 fuzzy quedaron fuera de la
  aplicación automática; si se quieren resolver, las señales útiles son ciudad/estado de la
  ficha MA contra `origin_city` (Agonia catálogo=Merida coincide con MA «Agonía» Merida).
- Los 368 artistas con ficha MA pero **sin** foto en MA (19) o sin formación (32) no aportan.
- La foto de MA es una foto (no logo) en la gran mayoría de casos; se revisó cada mosaico.

## Archivos
- `tmp-analysis/ola3-metal-archives/`: `prepare-raw-pages.mts` (crudas), `apply-ma-artists.mts`
  (formación), `apply-ma-album-years.mts` (discos).
- `reports/ola3-ma-*`: lista de bandas, cruce, dudas de discos, lista de descartes de fotos.
- Crudas: `data/raw/metal-archives/` (382 páginas; excluidas de git como todo `data/raw`).
