# Informe · Links de streaming por artista y álbum (etapas 1–4, 2026-10-04)

Plan aprobado por Brian («implementa todas las etapas»): cosechar los links de las
plataformas de streaming por **perfil de artista** y por **álbum**, guardarlos en
el catálogo con evidencia y aplicarlos en runs reversibles.

## Etapa 2 · Esquema — COMPLETA

- **Migración `0039_streaming_links`** (sexta excepción aprobada al core):
  `public.streaming_links` — un link por (artista **o** álbum, plataforma);
  `platform`/`method`/`source` documentados; `verified` (candidato → revisión);
  UNIQUE parcial por entidad+plataforma; FKs en cascada; registrada en el
  diario (0028, `soft`), así un `run:undo` de la aplicación retira lo insertado.
- Contratos en verde: `crv doctor` → «huella exacta (210 objetos)»;
  `core-and-schema` 7/7 (diff de `public` vacío tras migrar + rollback completo);
  `npm run typecheck` ✓.
- Fix lateral: `vitest.config.ts` ahora ignora `**/.claude/**` (los worktrees
  ajenos contaminaban las corridas — mismo bug que ya tuvo `eslint.config.js`).

## Etapa 1 · Piloto (100 artistas aleatorios del catálogo) — COMPLETA

Vías activas en el piloto (APIs oficiales, sin scraping de plataformas):

| fuente | qué aporta | estado |
| --- | --- | --- |
| Deezer (API pública) | perfil + álbumes | ✓ |
| iTunes/Apple Music | perfil (`artistViewUrl`) + álbumes | ✓ |
| MusicBrainz (`url-rels`) | perfil en Spotify/Deezer/YouTube/SoundCloud/Bandcamp/Tidal… | ✓ |
| Wikidata (P1902/P2722/…) | refuerzo de perfil | ✓ |
| Spotify (API oficial) | perfil + álbumes | ⏳ castigado con 429 (lo consume otra campaña) — pase quirúrgico armado |

**Cobertura del piloto (sin Spotify):**

- Con al menos un perfil de plataforma: **61/100 (61 %)**; sin ningún link: 36/100.
- Perfiles por plataforma: deezer 59 · spotify (vía MB/WD) 14 · apple_music 7 ·
  youtube 6 · soundcloud 6 · tidal 5 · bandcamp 4 · amazon_music 3.
- Álbumes: 213 en catálogo (de esos 100 artistas) → **101 con link (47 %)**;
  apple_music 47 · deezer 94 (varios discos con ambas).

**Precisión (auditoría con APIs inversas de los 29 matches fuzzy):** casi todos
son variantes tipográficas o de año del mismo título (`score ≥ 0.98` = título
idéntico, reedición); quedan ~4 sospechosos para revisión humana («Luis
Oberto»↔«Luis Roberto», «Sabotaje»↔«SAIBOTAJE», «Beraca»↔«Beracah»,
«Incendiario»↔«Incendiarios»), todos ya visibles en `notes`.

## Etapa 4 · Aplicación — PILOTO APLICADO

- `scripts/apply-streaming-links.ts` (valida contra la BD viva: artista existe,
  el disco sigue siendo suyo; upsert idempotente; dry-run por defecto).
- **Run 13399: 245 links aplicados** (162 fichas; fuzzy 29; `verified=false`).

## Etapa 3 · Campaña completa — EN MARCHA

- `crv-streaming-campana.service` (systemd --user, duradero): los 4.483
  artistas × sus 11.747 álbumes, sin Spotify (~16 h de ETA; los 100 del piloto
  ya están hechos y se saltan vía `campana/`).
- Reanudable: un archivo `links-<artistId>.json` por artista; si el servicio
  muere, relanzarlo retoma donde quedó.

## Spotify (pendiente de ventana)

- Ambas credenciales castigadas (429) por uso concurrente. En cuanto expire:
  1. `crv-spotify-watch.service` (activo) sondea cada 20 min (hasta 10 h) y al
     primer OK hace el **pase quirúrgico** del piloto
     (`scripts/streaming-spotify-pase.py`, solo Spotify, merge sin perder MB/WD)
     y **re-aplica** a `public.streaming_links`;
  2. para la campaña grande, el mismo pase sobre `campana/` cuando termine
     (comando en el README de abajo).

## Bios de RYM (dato faltante, preparado)

- Cola lista: **774 pendientes** de las 1.591 fichas de «nuevos» (817 ya tienen
  bio) — `data/raw/fuentes-web-2026-10-01/rym-bios/cola-bios.jsonl`.
- Capturador `scripts/rym-bios-auto.py` (pestaña `/artist/<slug>/biography`,
  mismo motor marionette, ritmo humano). **Se lanza cuando cierre la fase 2 de
  «nuevos»** (una sola sesión RYM a la vez), p. ej.:
  `systemd-run --user --collect --unit=crv-rym-bios python3 scripts/rym-bios-auto.py`

## Comandos útiles

```bash
# Progreso de la campaña
journalctl --user -u crv-streaming-campana -f
ls reports/streaming-links-2026-10-04/campana/links-*.json | wc -l

# Pase de Spotify para la campaña (cuando haya ventana y la campaña cierre)
python3 scripts/streaming-spotify-pase.py --dir reports/streaming-links-2026-10-04/campana \
  --artistas data/raw/streaming-2026-10-04/artistas.jsonl \
  --albumes data/raw/streaming-2026-10-04/albumes.jsonl
./scripts/with-node22.sh npx tsx scripts/apply-streaming-links.ts reports/streaming-links-2026-10-04/campana --confirm
```
