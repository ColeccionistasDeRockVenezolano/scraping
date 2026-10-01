# Verificación de 2721 hallazgos de `fichas_repetidas`

Fecha: 24 de septiembre de 2026. Último escaneo: **237**.

## Alcance y método

Se cotejó cada hallazgo inicial con los claims, páginas y créditos scrapeados conservados en el servidor. Para los careos de identidad se reconstruyó el contexto desde los claims hermanos de las ingestas 307 y 308: artista, disco, pista, número de pista y función. También se consultaron los créditos existentes del catálogo. La base de datos se usó solo para lectura; todas las correcciones se hicieron por la API.

El campo `hasContextSupport: false` del candidato ER **no describe toda la evidencia disponible**: 2178 de los 2486 careos sí tienen contexto de crédito en los claims hermanos. Por eso el cotejo de datos scrapeados debía ser el primer paso. La primera evaluación que interpretó ese campo como ausencia general de contexto fue incorrecta y quedó sustituida por esta auditoría.

Los archivos adjuntos son [`hallazgos.csv`](hallazgos.csv), con una fila por cada uno de los 2721 hallazgos iniciales; [`careos-identidad.csv`](careos-identidad.csv), con una fila por los 2486 careos de persona u organización y los créditos comparados; y [`hallazgos-nuevos.csv`](hallazgos-nuevos.csv), con las siete emisiones posteriores que siguen abiertas.

## Estado comprobado

| Medida | Cantidad |
| --- | ---: |
| Hallazgos iniciales verificados | 2721 |
| Hallazgos iniciales resueltos | 734 |
| Hallazgos iniciales abiertos | 1987 |
| Nuevas emisiones abiertas de revisiones antiguas | 7 |
| **Hallazgos abiertos en el escaneo 237** | **1994** |

Las siete emisiones nuevas corresponden a **siete revisiones antiguas**, no a siete entidades nuevas: sus candidatos ER son IDs absorbidos por fusiones posteriores. Sustituyeron siete hallazgos iniciales. Las revisiones subyacentes permanecen abiertas y la API rechaza aprobarlas con un candidato inexistente.

| Hallazgos abiertos ahora | Cantidad | Resultado de la verificación |
| --- | ---: | --- |
| Careos de persona u organización | 1904 | 1141 tienen candidato ER equivocado pese a existir otra ficha con nombre y crédito exactos; 34 señalan otra ficha mediante variante y crédito; 416 tienen contexto pero sin coincidencia concluyente; 308 no tienen contexto de crédito; 5 apuntan a un ID ya absorbido. |
| Alias ambiguos en revisión | 44 | Requieren contexto de artista, disco o versión. |
| Pistas aparentemente repetidas | 23 | 17 tienen duraciones distintas; 6 se repiten en una fuente sin corroboración independiente suficiente. |
| Alias en colisión con otra ficha | 22 | 17 de pista, 3 de persona y 2 de disco; algunos se solapan con las pistas anteriores. |
| Personas escritas de otra forma | 1 | «E. Martínez» / «E. Martinez» sin corroboración suficiente. |

La distribución por detector del escaneo 237 es 1950 revisiones de cola, 23 pistas repetidas, 22 alias en colisión y 1 par de personas equivalentes.

## Decisiones aplicadas por la API

- **582 careos de identidad aprobados**: 488 por nombre exacto y crédito exacto, más 94 por variante de nombre y crédito compatible. Otros cinco careos de variantes se intentaron, pero la API los dejó abiertos por colisión de alias. Tras fusionar las fichas abreviadas, el reintento devolvió «persona inexistente» porque el candidato ER conserva el ID antiguo.
- **34 pares de pistas fusionados** tras comprobar título, disco y fuentes scrapeadas independientes. Los claims de ambas fuentes permanecen en las pistas conservadas. Se restauró la posición de tres pistas y se renumeraron 11 discos; sus listados quedaron consecutivos.
- **11 pares de personas fusionados**, incluidos George Henríquez/Henríquez, Pedro Castillo/Castillo y Sandro Liberatoscioli/Liberatoscioli. Los tres últimos se comprobaron con créditos de obras de Aditus en varios discos; las vistas previas no mostraron conflictos y las fusiones conservaron créditos y claims.
- **3 pares de discos fusionados**: *The Venezuelan Zinga Son Vol. 1*, *MF Radio* y *7* de Colina. En *MF Radio* coincidieron las 12 pistas de ambas fichas.
- **1 par de artistas fusionado**: Chulius &/and The Filarmónicos. Las dos bandas Osteoporosis Aguda se declararon distintas por ciudades y discografías diferentes en la fuente scrapeada.
- **68 revisiones de alias descartadas** porque eran nombres de intérprete confundidos con títulos o pistas de distintos artistas que comparten título. Otras tres revisiones de alias generadas durante los intentos fallidos se descartaron tras las fusiones de personas: su destino antiguo ya no existe.

## Pendientes y límite de la API

Los **1141 careos con candidato ER equivocado** son el bloque principal. El crédito scrapeado señala otra ficha existente con nombre exacto; aceptar el candidato propuesto fusionaría o atribuiría datos a la entidad incorrecta. La ruta `POST /review-queue/:id/accept` solo acepta el candidato ER principal para estos tipos de revisión y rechaza `targetId` distinto. Rechazar el careo también perdería la vinculación correcta. Se necesita una vía auditada para corregir el candidato o regenerar la decisión ER antes de resolverlos en lote.

Las 17 parejas de pistas con duración diferente siguen separadas. En *The Collapse Of Singularity* la propia página scrapeada enumera dos veces cuatro canciones; esa repetición de origen no prueba que sean la misma grabación.

## Jev y Laya

Pueden servir para **ordenar los 450 casos con contexto pero sin resolución exacta** (416 sin coincidencia concluyente y 34 con variante de otra ficha) y los alias ambiguos. La entrada debe contener los créditos y las fuentes ya cotejados; la salida debe admitir «misma entidad», «entidades distintas» y «evidencia insuficiente». Una decisión del modelo no sustituye el crédito documentado ni corrige el límite de la API.

Jev es un modelo alojado de decisiones estructuradas que requiere clave de TypeSafe; no hay una configurada aquí. Laya tiene pesos abiertos y variante multilingüe, por lo que es viable para una prueba local con expedientes en español. No está instalado y la GPU de este entorno no inicia con el controlador actual; una prueba comenzaría en CPU. Sus propios materiales recomiendan calibrar probabilidades y advierten sobre sobreconfianza. Fuentes: [TypeSafe: Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev), [SDK oficial](https://github.com/typesafe-ai/typesafe-sdk-python), [modelo Laya](https://huggingface.co/convaiinnovations/laya), [evaluación de Laya](https://github.com/NandhaKishorM/laya/blob/main/BENCHMARKS.md).
