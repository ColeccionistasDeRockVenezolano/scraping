# Cambios de nombre del rock venezolano: aplicación al catálogo (2026-10-01)

Fuente: `~/Downloads/investigacion_cambios_nombre_rock_venezolano.docx`. Qué decidió Brian:

- La **categoría 1** y el caso **Superglicerina → PAN** pasan a **alias**. Si los dos nombres ya tenían ficha propia, se **fusionan** con el nombre más reciente, sin perder datos (las bios se unen y DeepSeek flash las reescribe).
- Las **categorías 2 y 3** van a **«Artistas relacionados»**, guardadas como relaciones explícitas.
- Los casos **sin ficha** se crean con los datos que dan sus fuentes.

Respaldo previo: `/mnt/datos/backups/crv/crv-20261001T185132Z`. Todos los runs quedan en el diario y se deshacen run por run.

| Run | Qué hizo | Reporte |
|---|---|---|
| 10866 | 7 fusiones, Abraxas de 1987 separado y alias Abortion/Gyroscope | `apply-renombres-fusiones-run10866.json` |
| 10867 | `crv texts rewrite`: 6 bios unidas reescritas por DeepSeek flash | — |
| 10868 | 12 alias, bio de PAN corregida, retiro del alias Heylel y 13 fichas nuevas | `apply-renombres-fichas-run10868.json` |
| 10869 | 25 relaciones y géneros del Abraxas de 1987 | `apply-renombres-relaciones-run10869.json` |

## Fusiones (run 10866)

Sol Nocturno ← Gorepriest · Kolman ← Abraxas · Cthonica ← Okkvlt · Exordium Profanum ← Hodah ·
Dreams of Tears ← Lake of Tears · Salpachino ← Pzoom · PAN ← Superglicerina.

En cada fusión, el nombre absorbido queda como alias `former_name`. Así se eligió cada campo en conflicto:

- **Año de formación:** el más antiguo, porque es la misma banda desde su primer nombre.
- **Ciudad:** la más precisa.
- **Estado, años activos, foto y logo:** los de la ficha del nombre vigente. Lo que se descartó quedó en Notas.
- **Exordium Profanum:** el estado pasa a `unknown`, porque el `changed_name` de Hodah ya no aplicaba.

**Abraxas:** la bio de la ficha 651 (síntesis del run 10442) describía al Abraxas de rock de Caracas (1987-1996), no al de Cabimas que luego fue Kolman. Se movió a una ficha nueva, **Abraxas (3228)**, con sus discos *Tan Solo Una Parte* (1989) y *Entre Dos Mundos* (1994) y sus géneros según Lobotoradio. Kolman conserva su propia bio.

**PAN:** la IA escribió que PAN «también fue conocida como Superglicerina». Se corrigió a mano: la ficha reúne el material de las dos bandas, y Argel venía de Superglicerina.

## Alias en fichas existentes (run 10868)

The Thunderbirds → Los Impala · Flavio → Rudy La Scala · Dead Feeling → Sentimiento Muerto ·
Dark Fire → Zignia · Biosss → Aerea · Tempujo / AltoPana → Alto Pana · Black Rainbow → Arcuri Overthrow ·
Todosantos Dub → Todosantos · Zion The Promised Land → Zion TPL · Majarete → Majarete Sound Machine ·
Anatomiæ Occultii → Anatomiae Occultii (sección 4).

El run 10755 (MA) ya había cargado Power Age, Anti-Régimen, Proyecto Haggard, Daemonhorn, 6Sonar, Beheaded,
Desperatio Dei, Nigrium Mortualia, Godless Crown, Nanyuhe y Leviathan A.C.

## Fichas nuevas (run 10868)

| id | Ficha | Alias | Datos |
|---|---|---|---|
| 3229 | Worst Emotions | Worst | 6 integrantes, sencillo 1970 |
| 3230 | Kámara de Tortura | La Panza de Buda, La Kamara | 7 integrantes (Yátu y Omar Quintero enlazados), *Vampiro* (2003), pop rock / rockabilly / new wave |
| 3231 | Malegua | Feeling XXI | 9 integrantes, Demo (2002), *Aní Tá Má* (2005), pop latino / reggae / ska |
| 3232 | Aire (Barinas) | Soplo de Vida | 3 integrantes |
| 3233 | La Venz | — | 4 integrantes, rock |
| 3234 | Gran Celaje | — | 5 integrantes, «Arde» (2019), *Espiral* (2020), rock alternativo |
| 3235 | People Pie | — | antecesora de Pastel de Gente |
| 3236 | Plymouth | Plymoouth | dúo formado en China, rock progresivo |
| 3237 | Los Aros de Saturno | — | dúo formado en Buenos Aires, rock psicodélico / progresivo |
| 3238 | Urbanda | — | *La Voz de la Ciudad* (1989); Pablo «Mulato» González |
| 3239 | Irie | Mulatos | Pablo «Mulato» González |
| 3240 | Los NoName | Los No Name | fusión temporal de Zignia |
| 3241 | Heylel | — | Varúlfr (2020-2021) |

Sobre los integrantes:

- Una persona ya catalogada solo se enlazó si había trayectoria común comprobada: Rafael Peñalver, César Sánchez Bello, Yátu, Omar Quintero, Pablo «Mulato» González y Varúlfr.
- Los demás se crearon como personas nuevas. Entre ellos hay homónimos que **podrían** ser la misma persona y no se fusionaron por la regla de proyecto común: Gabriel Quintero, Christian Estepa, Ricardo Castillo, Marcos López, David Molina y Rubén Strauss. Quedan para revisión.
- Solo se confirmaron géneros cuando la fuente los afirma.

## Relaciones (run 10869, `ingest.artist_relations`)

**Sucesor:** Radio Clip→RC2 · Sentimiento Muerto→Dermis Tatú · La Venz→Gran Celaje · People Pie→Pastel de Gente ·
Heylel→Blodmåne · Plymouth→Los Aros de Saturno · Irie→Mulato · Los Buitres→Los Beat3 · Urbanda→Irie.

**Nombre temporal:** Zignia→Los NoName.

**Proyecto de exintegrantes:** Dermis Tatú / Sentimiento Muerto / La Calle → PAN · Arkangel→Paul Gillman · Aditus→Ficción ·
Sentimiento Muerto→La Calle · Sentimiento Muerto / La Puta Eléctrica → Pixel · Arkangel / Paul Gillman → Arcuri Overthrow ·
Zapato 3→Solares · Sentimiento Muerto→Cero A La Izquierda · Agresión→Cultura Tres · Témpano→Poster · La Puta Eléctrica→Jacktürbo.

**Heylel:** había llegado como alias de Blodmåne en el run 10755. Se retiró, porque ahora es una ficha relacionada.

**No aplicado:** The Fuhrer → Incore (sección 5, pendiente de una segunda fuente).

## Código

- **Migración `0035_artist_relations`:** crea la tabla de relaciones en `ingest`, incluida en el diario. No tiene CHECK `from<>to`, para que una fusión futura no falle con el error 23514.
- **API:** `GET /artists/:id` → `related[].relations[]` devuelve tipo, dirección, integrantes puente, años, nota, fuentes y confianza. Las relaciones explícitas aparecen primero y se combinan con las calculadas por integrantes compartidos.
- **Web:** la pestaña «Artistas relacionados» muestra una etiqueta según la relación («Proyecto sucesor», «Proyecto anterior», «Proyecto de exintegrantes», «Banda de origen», «Nombre temporal»). La nota de evidencia aparece al pasar el cursor y la línea inferior dice «Vínculo: …» con el año.
- **Pruebas:** `api-read` (linaje en los dos sentidos e ignorar la relación consigo misma) y `core-and-schema` (0035). Pasan las suites api-read, core-and-schema y change-journal: 36/36.
