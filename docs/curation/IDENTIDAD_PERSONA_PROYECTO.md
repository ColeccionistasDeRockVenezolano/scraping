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

---

## El apodo no va en el nombre (caso Canserbero, 2026-10-01)

**Problema.** El artista 57 «Canserbero» (el proyecto, con sus tres discos y su
biografía) y la persona 411 ya estaban vinculados desde el 2026-09-30, pero la
persona arrastraba el apodo dentro del nombre —`Tirone González "Canserbero"`—,
las letras de *Muerte* y *Vida* figuraban a nombre del ARTISTA (en la ficha del
disco se leía «Canserbero» donde debía decir quién las escribió) y la ficha del
proyecto no decía de quién era.

**Regla de Brian.** El nombre de una persona es su nombre. El apodo que la
fuente pegó al final pasa a `ingest.person_aliases`: la búsqueda mira nombres y
aliases ([`src/api/search-index.ts`](../../src/api/search-index.ts)), así que se
sigue encontrando por los dos, y los créditos muestran el nombre de la persona.
Nada se descarta: el nombre anterior se conserva también como alias.

| Qué | Dónde |
|-----|-------|
| Separar el apodo final | `splitTrailingNickname` en `src/normalization/entity-name.ts` |
| Que no vuelva a entrar | `createEntity` en `src/merge/engine.ts` (la ficha nace con el nombre limpio y el apodo de alias) |
| Barrido del catálogo | `scripts/plan-person-nicknames.ts` → plan para `crv review persons` |
| Créditos del proyecto a su titular | `scripts/retarget-titular-credits.ts` |
| Las dos fichas se ven como una | «Nombre real» y las fechas del titular en la ficha del artista; «Proyecto» en la de la persona |

**Solo el apodo final, y solo con base de dos palabras.** `Rafael "Pollo" Brito`
es la forma en que se lo nombra (apodo intercalado: no se toca, decisión de
Brian) y de `Pablo "El Che"` quedaría «Pablo», que no identifica a nadie. Si el
nombre limpio ya es de otra ficha no se renombra: el mismo nombre es una señal
de nombre, y una señal de nombre sola no funde a nadie: hace falta proyecto
común (misma banda, disco, pista o artista). El par va a la mesa como
`person_duplicate`.

| Run | Efecto |
|-----|--------|
| 10895 | Caso Canserbero: persona 411 → «Tirone González»; alias `Canserbero`, `Tirone José González Orama` y el nombre anterior |
| 10896 | 63 créditos de 14 proyectos solistas pasan del artista a su titular; 5 quedaban repetidos y se unieron |
| 10898 | 167 fichas más con el apodo al final: nombre limpio + apodo de alias |
| 10899 | 4 revisiones `person_duplicate` abiertas (Julio Rojas, Víctor Rodríguez, Ricardo Tirado, Luis Enrique) |

Sin tocar: 239 apodos intercalados y 21 cuyo nombre limpio sería una sola
palabra (detalle en `reports/person-nicknames-2026-10-01.jsonl`).

---

## Caso Canserbero extendido a todo el catálogo (2026-10-02)

**Decisiones de Brian** (clarify del 2026-10-02): extender las cinco piezas del
caso a todas las fichas; con el paréntesis al revés («Frankie Devil (Francisco
Belda)») queda el nombre real; **todo apodo es también alias**, aunque no salga
del nombre (los intercalados siguen sin renombrarse); aplicar con respaldo.

| Pieza | Herramienta |
|-------|-------------|
| Paréntesis, @usuario, «aka», «Firma - Persona» | `scripts/plan-canserbero-extendido.ts --stage=parens` (tabla revisada a mano) |
| Nombre real según fuente | `--stage=realnames`: Metal Archives (`persons.real_name`) y biografías citadas en la tabla del script |
| Apodos como alias | `--stage=nicknames` |
| Proyecto como alias del titular | `--stage=projects` (sin nombres de grupo: «Chulius & The Filarmónicos») |
| Nombre nuevo que ya es de otra ficha | `scripts/merge-canserbero-collisions.ts`: fusiona con proyecto común; si no, `person_duplicate` |
| Créditos del proyecto al titular | `scripts/retarget-titular-credits.ts` (ahora enlaza claims en la auditoría) |
| Que no vuelva a entrar | `splitTrailingNickname` separa también el `@usuario` final |

**Nombre real.** Si la ficha ya lleva una forma del nombre real (comparte un
apellido, aun con errata: «Carlos Baute» ⊂ «Carlos Roberto Baute Jiménez»), el
nombre completo solo se suma como alias. Si no comparte ninguno, la ficha lleva
el nombre artístico y pasa a llamarse por el real: «Kerch» → «Juan Aponte»,
«Edgar Alexander» → «Édgar Enrique Quintero Castillo»; el artístico queda de
alias. Fuentes que se contradicen no se tocan (Luz Marina, MASA, José Martínez,
Ezequiel Serrano Valencia). Nombres reales de una palabra o con palabras
repetidas («Pedro Pedro Arvelo») se descartan.

| Run | Efecto |
|-----|--------|
| 11306 | Paréntesis/@/aka: 39 renombres, 70 alias (11 fichas que no son personas quedan en `reports/canserbero-parens-2026-10-02.jsonl`) |
| 11307 | Nombre real: 134 renombres, 242 alias |
| 11308 | 11 fusiones con proyecto común (p. ej. Rocky Devil → Francisco «CoCo» Díaz; Argel → Argel Trejo) |
| 11309, 11310 | 25 revisiones `person_duplicate` (choques sin proyecto común y pares marcados a mano) |
| 11311 | 344 apodos como alias |
| 11312 | 112 nombres de proyecto como alias de su titular |
| 11313 | 364 créditos de proyectos a su titular; 24 repetidos unidos |
| 11314 | Mesa (Brian: «apruébalos según lo que recomiendes», `scripts/resolve-canserbero-reviews.ts`): 9 fusiones con evidencia (Luz Verde = Frankie & The Blue Devils, Niño Nuclear = Los Spectors, «El gordo», A.K.A. Trece, «El Cura ex La Corte», C-funk, DJ Rey); 13 pares descartados como personas distintas, que pasan a su nombre limpio. Quedan 8 abiertos: mismo nombre y mismo rol sin proyecto común |
| 11361 | Tanda 2 de la mesa: el detector solo comparaba con el PRIMER homónimo. Con prueba escrita: Gilberto Lazo (3 fichas), Eduardo Malavé y Francisco «Frank» Issa (Big Mandrake la formaron músicos de Sin Sospechas), Felipe Nevado (Factor Mental → Arian, 2005) y Christian Estepa (dos fichas de bajista de Intemperia). Quedan abiertos Christian Estepa/Malegua, Jonathan Piñeiro, Jesús Dávila y José Barrios; las fichas 360 «Daniel» y 6387 «Fernando» juntan a varias personas (Metal Archives da dos nombres reales a 6387) y piden separarse |
| 11362 | Separación de 360 «Daniel» y 6387 «Fernando» (`scripts/split-mixed-persons.ts`, Brian: «sepáralas»): el importador de Metal Archives emparejó cinco perfiles solo por el nombre de pila. 360 se queda con Skatz y sus créditos de Sincopa; nacen Daniel Díaz (Secta Canibal), Daniel «Lord Cruz» (Demonical Rites), Daniel (Aria) y Daniel (Los Riff). 6387 se queda con el diseño de Retrovértigo; nacen Fernando Guillén (Ritual) y Fernando Villa (Optofobia). Cada integración se mueve (no se copia, como hace `split`) con sus claims; se quitan el nombre real y el alias ajenos. Pares 1171514/1171515 descartados; abiertos 360↔Los Riff, Fernando Villa↔Disentir y Daniel Díaz↔2392 (solo nombre). `personas-cruce.jsonl` apunta ya a las fichas nuevas |

Respaldo previo: `/mnt/datos/backups/crv/crv-20261002T035652Z`.
