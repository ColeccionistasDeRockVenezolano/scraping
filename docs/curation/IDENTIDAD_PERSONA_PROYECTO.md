# Identidad persona ↔ proyecto (caso Ashwave, 2026-09-30)

**Problema.** «Ashwave» es el proyecto solista de Pedro Castillo, pero el catálogo tenía la
persona y el artista sin vínculo, con seudónimos (Sandrus, Alexium) como personas sueltas y
21 discos «de participación» colgados del artista «Pedro Castillo» (índice personal de
Sincopa) que duplicaban los discos reales de Ashwave, Aditus, Témpano y PP's.

**Modelo.** No se fusionan fichas de tipos distintos: la persona queda como *titular* del
artista (`artist_members.role = 'Titular del proyecto'`). Los seudónimos son personas y se
funden con la regla de proyecto común (mismo disco no recopilatorio).

**Operaciones nuevas** en `src/review/person-corrections.ts` (plan JSON, `crv review persons`):
`link_project`, `add_alias`, `merge_albums`. Todas dentro de una transacción, con auditoría
y en el diario (se deshacen por run).

| Run | Plan | Efecto |
|-----|------|--------|
| 10576 | `docs/decisions/2026-09-30-caso-ashwave-pedro-castillo.json` | Pedro Castillo titular de Ashwave y de su artista solista; alias Petrus; Sandrus y Alexium fundidos; 21 discos duplicados fusionados |
| 10580 | `docs/decisions/2026-09-30-identidad-persona-proyecto.json` | 28 solistas vinculados; 51 «personas» que eran grupos convertidas en el artista; 35 discos de participación fusionados |

**Reglas duras** (decisión de Brian: «solo reglas duras», solistas «solo si el nombre parece de persona»):
1. Artista sin integrantes + persona homónima con forma de nombre propio + créditos de músico/productor en sus discos → titular. Veto: Laya «distinta» ≥ 0,7 o créditos solo técnicos.
2. Artista con ≥ 2 integrantes + homónima no integrante, sin forma de nombre propio, sin otras bandas → la «persona» es el grupo (`to_artist`). Excluidos Atkinson y Druidas.
3. Disco sin pistas ni créditos bajo un artista-persona, con mismo título normalizado y año que un disco real donde esa persona figura → `merge_albums`.

**Laya.** 243 expedientes (`scripts/export-identity-link-dossiers.ts`,
`scripts/run-laya-identity-links.py`, salidas en `reports/identity-link-*.jsonl`). En esta
tarea Laya **no es fiable** (marca «misma_persona» a Los Amigos Invisibles con 43 de 53 grupos
claros); solo se usó como veto. Sirve para ordenar, no para decidir.

**Pendiente** (`reports/identity-link-pending-2026-09-30.json`): ~142 artistas sin integrantes con
nombre tipo banda (Bélica, Cabaret…) y su «persona» homónima; sin regla dura, queda para revisión.
Discos de participación sin contraparte (p. ej. «Atabal Yémal» bajo Pedro Castillo) siguen sin reubicar.

**Entorno.** El 29-09 FileCleaner borró archivos de `node_modules`; el de este proyecto se
reinstaló desde `package-lock.json` (tsx, tsc, vitest OK).
