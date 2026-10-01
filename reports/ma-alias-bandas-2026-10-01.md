# Alias de banda desde Metal Archives (lista VE) — 2026-10-01

Pedido del propietario: *«cuando alguien busca por un nombre antiguo, por ejemplo Power Age →
Arkangel, debe salir como alias; igual con todos los artistas: al buscar por sus alias aparece
la ficha»*.

## Cómo funciona

- La búsqueda del API **ya indexa los alias** (`src/api/search-index.ts:76-88`: carga
  `ingest.{artist,person,organization}_aliases` junto a los nombres). Faltaba la fila de alias en
  la base, no el mecanismo. Tras una escritura, el índice se invalida y se refresca en segundo
  plano (TTL 60 s): la segunda búsqueda ya ve el cambio.
- Camino de escritura: `createAlias` + `withOperatorRun` (`src/api/repositories/aliases.ts:58`;
  el mismo que usa la web vía `POST /artists/:id/aliases`). Reversible y reindexa al commit.

## Padrón y aplicación

- `scripts/ma-alias-scan.py` (dataset): para las 611 fichas MA toma las fases de nombre
  (nombre de página + «(as X)» del `years_active`), las resuelve contra el catálogo (compacto con
  ligaduras æ→ae/œ→oe y v↔u) y emite los alias faltantes. Resultado: **20 alias en 18 artistas**.
- Aplicado en el run **10755** (`hermes:ma-alias-bandas`,
  `tmp-analysis/ma-alias-2026-10-01/apply-ma-alias.mts --confirm`): 20/20 añadidos, 0 errores.
  Reporte: `reports/apply-ma-alias-run10755.json`.
- Verificación: `scripts/verify-alias-api.py` → **20/20** alias devuelven su ficha por
  `GET /search?q=<alias>&types=artist`. La ficha `GET /artists/46` ya lista «Power Age» como alias.

| Artista | Alias añadido(s) |
|---|---|
| Nota Profana | Proyecto Haggard |
| Arkangel | Power Age |
| Tinieblas | Corpse Killer, Poseidón |
| Moriturio | Nigrium Mortualia |
| Sexto Sonar | 6Sonar |
| Bleeding Tears | Tenebrum Lukretia |
| Dargothar | Argoth |
| Behated Reign | Beheaded |
| N.W.D. | Epidia |
| Theurgia | Daemonhorn |
| Godless | Godless Crown |
| Nox Desperatio | Desperatio Dei |
| Nocturnal | Nocturnal Art |
| Laverno | Laberno |
| Necroprogenie | Vicarius Filii Dei |
| Incruento | Cruento, Agape |
| Drahcko | Anti-Régimen |
| Leviathan | Leviathan A.C. |

## Revisión pendiente (posible duplicado de catálogo)

16 fichas MA cuyas fases de nombre resuelven a **dos artistas distintos** del catálogo (los dos
nombres existen como fichas separadas; lo probable es fusión, no alias). Detalle en
`consolidado/alias-revision.json` + `revision-pares-catalogo.txt`:

Lake of Tears ⇄ Dreams of Tears · Hodah ⇄ Exordium Profanum · Bajo Cero ⇄ Bajo Zero ·
Baphomet ⇄ Baphometh · Abaddon ⇄ Natastor · Gorepriest ⇄ Sol Nocturno · Wismar ⇄ Lithopedion ·
REMEMBRANCE ⇄ Across The Ruins · Okkvlt ⇄ Cthonica · Ak47 ⇄ Stalingrado · Abraxas ⇄ Kolman

## Para la etapa de fichas nuevas

Cuando se creen las 186 fichas nuevas, aplicar su historial de nombres como alias con el mismo
mecanismo (los «(as X)» ya están en `band-details-full.jsonl`).
