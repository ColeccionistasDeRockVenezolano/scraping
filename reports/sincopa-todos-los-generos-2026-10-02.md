# Sincopa: todos los géneros al catálogo (2026-10-01/02)

Decisión de Brian: la primera ola solo leyó rock/pop de Sincopa; ahora entran **todas
las secciones** (si el artista es venezolano, entra). Resultado: **ingerido como
claims candidatos (`low`), sin tocar el core**; falta promover.

## Qué se hizo

| Paso | Resultado |
|---|---|
| Adapter `sincopa` 1.2.0 | Lee las siete secciones con la misma plantilla de ficha: jazz, latin pop, clásica, new age, tradicional, étnica, más el árbol `musicians` (que no emite registros: son índices). `crawlLimit` 12.000. |
| Rastreo (runs 10863, 10864) | **5.772 páginas** guardadas (antes 2.370). 13 enlaces rotos (404) de la propia fuente. Los índices enumeran solo una parte: las fichas de disco se descubren desde la ficha del artista. |
| Ingesta `low` (131 runs ok) | Claims de Sincopa: **158.136 → 1.074.640** (+916.504 candidatos). Cola de revisión: 248.692 → 1.166.792 (+918.100 abiertas). |
| Core | **Intacto por estos runs**: 0 filas de `merge_audit` en los 137 runs. Los cambios de artistas/álbumes/personas desde la línea base son de las otras sesiones (fusiones y correcciones de personas). |

## Qué trae cada sección (identidades distintas con claim de nombre/título)

| Sección | Artistas | Álbumes | Pistas | Personas | Sellos |
|---|---:|---:|---:|---:|---:|
| jazz | 255 | 928 | 5.512 | 6.173 | 182 |
| latin pop | 140 | 1.850 | 15.407 | 8.766 | 241 |
| tradicional | 109 | 1.117 | 10.323 | 4.813 | 207 |
| étnica | 162 | 565 | 4.845 | 3.831 | 101 |
| clásica | 64 | 362 | 3.320 | 2.022 | 81 |
| new age | 27 | 221 | 1.368 | 527 | 28 |
| rock/pop (páginas nunca ingeridas) | 640 | 2.271 | 20.308 | 14.768 | 441 |

De esas identidades, ya existían en el core muy pocas fuera de rock (p. ej. jazz: 7
artistas y 13 álbumes). En rock/pop, 23 artistas, 177 álbumes y 14.887 pistas son nuevos:
eran páginas que la primera ola no había alcanzado.

## Géneros

- 23 géneros nuevos propuestos en `data/genres/taxonomy.json`, entre ellos **Música
  tradicional** (Brian: «Traditional» va ahí, no a Folk), Gaita, Descarga, Son, Merengue,
  Guaracha, Mambo, Cha-cha-chá, Vallenato, Timba, Samba, Calipso, Tango, Aguinaldo, Nueva
  trova, Smooth jazz, Big band, Acid jazz, Nu jazz, Música de cámara, coral, antigua y
  neoclásica; alias para lo existente y 8 instrumentos como no-género.
- **Ya está aplicado en la base** (lo aplicó Hermes el 2026-10-01 22:07 UTC, no esta
  sesión). El dry-run actual dice 0 operaciones.
- Con la taxonomía aplicada: de 3.517 valores de género de las secciones no rock,
  **3.423 resuelven completos**, 47 parcialmente y 47 no resuelven (65 términos distintos,
  casi todos compuestos con guion de una sola aparición: «Jazz-Bolero», «Ska-Jazz»,
  «Latin-Urban»…). Esos van a `genre_unknown` por la regla de no inventar. Detalle en
  `reports/sincopa-genre-gaps-2026-10-02.json`. Aún no hay géneros asignados a entidades
  del core: eso ocurre al promover.

## Casos dudosos

- **Origen no venezolano (7 fichas):** The Vnote Ensamble y The Snake Trio (CA), Ya Gozó
  The Latin Jazz Band y Marea Alta (FL), Recoveco (Francia), Orinoko (Alemania), El
  Ensamble MCV (España). Son agrupaciones de venezolanos en el exterior; por la regla
  «toda ficha de Sincopa entra» se quedan. Solo se mide el país de formación.
- **Compilaciones (`compilations1/`) y una ficha (`pedrobelisarioorq_besamenegro`)** no
  emiten registros; las compilaciones de Various Artists no son señal venezolana.
- Personas: ~24.000 identidades nuevas de créditos (músicos, compositores); la
  resolución las compara contra 11.7k–14.6k personas del catálogo, sin crear nada.

## Trampas encontradas (para la próxima ingesta grande)

1. **El ER recorre todo el catálogo por claim**: ~1 s por persona y 1,4 s por pista a
   40.000 candidatos. Con ~1M de claims no terminaba nunca. Arreglo opt-in
   `withCandidateSnapshot` (`src/er/repository.ts`): candidatos leídos una vez por lote,
   pistas filtradas por disco/título (equivalencia probada en
   `test/unit/candidate-snapshot.test.ts`) y `normalizeEntityName` memoizado en
   `src/er/scoring.ts` (5× en personas).
2. **Cada decisión de ER guarda todos los candidatos** (~280 kB por persona o disco; la
   tabla llegó a 19 GB en otra ingesta). Dentro de la instantánea se guarda ya
   compactada (20 mejores + `candidates_count`), igual que la retención. La tabla pesa
   4,1 GB; al compactar 6 runs a mano quedó basura de TOAST (`VACUUM (ANALYZE)
   ingest.entity_resolution_decisions` la devuelve al reuso).
3. **Reingerir una página vieja con el extractor actual choca** (`claims_dedupe_uk`):
   el título multilínea («Pueblo Chico» / «Pueblo Chico Infierno Grande») se lee distinto
   y ambos apuntan al mismo disco. `scripts/ingest-sincopa-stored.ts --only-unseen` salta
   páginas con claims.
4. **El rastreo repite todo el caché dentro del TTL de 7 días**: ampliar el techo y
   relanzar no vuelve a pedir lo ya bajado.
5. Paralelizar por secciones (4 procesos) funciona: las secciones son disjuntas y el
   candado por entidad evita choques.

## Scripts nuevos

- `scripts/ingest-sincopa-stored.ts` — ingesta por lotes, con avance y `--section`,
  `--except-rock`, `--only-unseen`.
- `scripts/sincopa-genre-gaps.ts` — géneros de Sincopa que la taxonomía no resuelve.
- `scripts/probes/sincopa-sections-probe.ts` — qué extrae el adapter por sección.

## Pendiente (a decisión de Brian)

1. **Promover al core** lo candidato (artistas, discos, pistas, personas, sellos),
   respetando la regla de pertinencia y con run + nota; luego proyectar géneros
   (`harvest-sincopa-genre-evidence` / `apply-source-genres`) para que los géneros de las
   fichas lleguen a álbumes y artistas. Conviene hacerlo por sección, empezando por jazz
   y clásica (identidades casi todas nuevas, sin choques con rock).
2. Revisar las 7 fichas de origen extranjero si se quiere afinar.
3. `VACUUM (ANALYZE)` de `entity_resolution_decisions` en un momento sin respaldo.
