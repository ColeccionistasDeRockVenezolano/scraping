# Lote 1 de altas — APLICADO (etapa 4, 2026-10-04)

Brian aprobó («apruebo todo») el 2026-10-03; se aplicó con el motor en seco (`--confirm`),
por lotes reversibles. **Nada quedó aplicado sin verificar**: abajo, números medidos en la BD
viva después de cada fase.

## Muestra (run 11722) — 16/16 creadas

5 bandas (Serenada, Orquesta La Tremenda, Los Imperial's, La Danta Más Cabra, Anakena) ·
5 personas (Marianne Malí, Ava Casas, Akilin, José Rosario, Underaiki) · 6 discos
(La Puta Eléctrica ×2 del ledger + primer disco de 4 de las bandas). ER: 10 directas +
6 con `allowSimilar` (scores 0,52–0,55). Verificado: entidades, claims con evidencia
(fuente `rateyourmusic` + snapshot), run ok.

## Lote 1 (runs 11726 · 11729 · 11732 · 11741 · 11746 · 11752) — 522/574 creadas

| tipo | aplicadas | a cola | errores |
|---|---|---|---|
| bandas | **217/217** | 0 | 0 |
| personas | **49/49** | 0 | 0 |
| discos (ledger 222) | **256/308** | 52 | 0 |

- **52 a cola**: 49 `album_match` (ER score 0,72–0,86: posibles duplicados/variantes — adjudicar
  a mano; ejemplos: C4 Trío «Tiempo al tiempo», Cardopusher «Mutant Dubstep Vol. 2», Dimension
  Latina «Salsa Brava», Apache, Ananta) + **3 ya existían** (Evio di Marzo #15495, La Págara
  #15512, Vargas/Boston Rex #15622 — no se duplicaron).
- **2 excluidos por guardas** (no aplicados): «Gustavo Casas y los Que Buscan» (nombre de banda
  clasificado como persona) y el disco «El Clan de Victor & Dimension Latina» (ya está en el
  catálogo como álbum 6933; el normalizador TS ve «&»=«y» y lo cazó).
- **143 avisos cerrados con nota**: 102 automáticos en el run (allowSimilar deja el aviso de la
  primera pasada del ER sin objeto) + 41 de títulos normalizados coincidentes con álbumes de
  otros artistas (verificado: 0 del mismo artista; alias no registrado).
- **0 errores**. Informe JSON por corrida: `altas-apply-202610040020.json` (lista de creadas,
  cola y avisos por clave).

## Total etapa 4 aplicado hoy

**538 fichas**: 222 bandas · 54 personas · 262 discos, todas con claim de evidencia
(fuente `rateyourmusic`, extractor `captura-rym-nuevos`, snapshot citado en la nota).

## Deshacer

Cada corrida es reversible por el diario (migración 0028):
`npm run cli -- runs undo <runId> --note="motivo" --confirm` (o `POST /changes/:runId/undo`).
Runs: 11722, 11726, 11729, 11732, 11741, 11746, 11752.

## Qué queda (a propósito)

1. **49 `album_match` abiertos** del lote — adjudicar (saltar / allowSimilar / dejar).
2. **870 items en revisión** del dossier (solistas, personas, tipos, fríos) + **77 homónimos** (79 menos
   2 que un bugfix del cruce movió a `ya_artista`) — con paquetes de confirmación listos
   (`paquetes-revision.md`, `careo-discos` / `careo-homonimos` / `descartes`).
3. **Discos de los «nuevos»** (5.868 propios listados): se completan cuando termine la fase 2
   de captura (re-ejecutar `dossier-discos.py` entonces y generar lote 2).
4. Residuo técnico documentado: ~96 claims `candidate` de primeras pasadas del ER (los claims
   no se borran nunca por diseño); sin efecto.

## Cerrado esa misma noche (2026-10-04)

- **Careo de discos: 40/40 aplicadas** (11 «misma» / 29 «otra» — runs **11766** + **11778**);
  9 filas parqueadas para el ojo de Brian. Las 29 «otra» crearon álbum nuevo; las 11 «misma»
  adjuntaron el claim al álbum existente.
- **9 alias aplicados** del careo de homónimos (typos y variantes; runs **11786–11794**).
- **269 descartes + 59 «sin acción» anotados** en `decisiones-2026-10-04.jsonl` (overlay que el
  dossier respeta al regenerarse — ya no reaparecen como pendientes).
- **7 fichas del lote reparadas** (creadas bajo artista equivocado desde filas `Appears On` +
  2 duplicados de doble firma): fusiones en runs **11777** y **11784**, 7 redirects, verificación
  en cero → ver `hallazgos-lote1-appears-on.md`.
- **Pendiente humano real**: 611 items de revisión sugerida del dossier (369 solistas · 108 personas ·
  124 sin tipo · 9 homónimos) + 18 filas finas parqueadas (9+9) + los discos de «nuevos» (fase 2).
