# Piloto local de Laya para géneros

Complementa la etapa 5 de `PLAN_GENEROS_CATALOGO_Y_RADIO_CRV.md`. Laya clasifica
evidencia textual entre opciones aprobadas; este piloto **no escribe en la base**,
no cambia `albums.genre` y no publica géneros en catálogo ni radio.

## Preparar casos

Laya necesita el entorno virtual local de `~/.venvs/laya`. El exportador usa la
cola existente de la Mesa: desacuerdos, desconocidos, compuestos, sugerencias
externas y artistas sin clasificar que tienen una biografía aceptada. Omite
álbumes sin evidencia, principales ya confirmados en modo `pending` y términos
que la taxonomía ya marca como no-género. Para etiquetas externas aplica tanto la
política cargada en la base como las exclusiones del archivo revisable
`data/genres/external-sources.json`. Así una sugerencia antigua de Discogs
`Latin` no entra como `fusion-latina`.

```bash
npm run genres:laya:export -- \
  --limit=80 \
  --out=reports/genre-laya-cases-mi-lote.jsonl \
  --gold-template=reports/genre-laya-gold-mi-lote.jsonl
```

Cada línea del archivo de casos contiene nivel (`album` o `artist`), evidencia
con referencias a claim/asignación y hasta ocho slugs activos. El título se
conserva para que el revisor encuentre la ficha, pero **no se envía a Laya**.
El evaluador tampoco recibe género ni biografía del artista para un álbum.
Las opciones salen de géneros explícitos resueltos, sugerencias externas
vigentes, términos parecidos a fragmentos de género desconocidos o menciones
en biografías aceptadas de artistas. Una opción sin evidencia se descarta.

## Evaluar

```bash
npm run genres:laya:pilot -- \
  --input=reports/genre-laya-cases-mi-lote.jsonl \
  --gold=reports/genre-laya-gold-mi-lote.jsonl \
  --out=reports/genre-laya-pilot-mi-lote
```

Se generan `.jsonl` (cada predicción y sus probabilidades), `.json` (resumen) y
`.md` (lectura humana). El checkpoint es `multilingual`; el proceso carga el
modelo una sola vez. `LAYA_PYTHON=/ruta/al/python` permite usar otro entorno.
`--baseline=predicciones-otro-modelo.jsonl` añade una comparación: cada línea
del baseline requiere `caseId` y `primaryGenre` (slug o `null`).
El informe siempre añade como referencia simple el primer candidato ordenado
por el exportador.

Para obtener métricas reales, una persona edita la plantilla de oro: pone
`reviewed: true`, un `reviewer` identificable y `primaryGenre` en el slug que
corresponde, o `null` si la evidencia no permite decidir. Puede elegir un slug
que faltó entre los candidatos; el informe lo cuenta como fallo de
recuperación. Las líneas sin revisar **no** cuentan como aciertos ni errores.
Las probabilidades de Laya son señales por calibrar con las decisiones de CRV;
no se convierten en `confidence: high` por un umbral arbitrario.

Para comprobar el flujo con decisiones humanas que ya existen, exporta un lote
retrospectivo. La asignación humana se escribe **solo** en el archivo de oro;
no entra en el `state` ni en las preguntas enviadas a Laya:

```bash
npm run genres:laya:export -- \
  --mode=reviewed --limit=40 \
  --out=reports/genre-laya-reviewed-cases.jsonl \
  --gold-template=reports/genre-laya-reviewed-gold.jsonl

# Reserva otros casos sin repetir los que se usaron para ajustar el flujo.
npm run genres:laya:export -- \
  --mode=reviewed --limit=40 \
  --exclude=reports/genre-laya-reviewed-cases.jsonl \
  --out=reports/genre-laya-holdout-cases.jsonl \
  --gold-template=reports/genre-laya-holdout-gold.jsonl
```

Esta comprobación retrospectiva solo mide fichas humanas que todavía tienen
evidencia utilizable por el exportador; no representa a toda la cola pendiente.

Antes de incorporar sugerencias a la Mesa hay que comparar lotes revisados por
familia y nivel, medir falsos positivos y abstenciones, y verificar que las
razones y referencias de evidencia sigan siendo correctas. La aprobación
editorial sigue siendo obligatoria incluso para una opción de probabilidad alta.

## Primer ensayo local (26-09-2026)

`reports/genre-laya-pilot-2026-09-26.*` contiene 20 casos reales: 10 álbumes
con sugerencias externas y 10 artistas con biografías aceptadas. Laya devolvió
18 opciones, dos abstenciones y ningún error técnico. La plantilla humana todavía
no tiene etiquetas revisadas, así que **no hay una medida de precisión**. El
ensayo ya muestra por qué la revisión es necesaria: en algunas biografías el
modelo prefirió la familia `rock` aunque había un género más específico entre
las opciones.

Como comprobación retrospectiva, `reports/genre-laya-reviewed-pilot-2026-09-26.*`
comparó 40 principales elegidos por personas: Laya acertó 23/40 (57,5 %) y
el primer candidato 8/40 (20 %). Ese lote se usó para ajustar la recuperación
de candidatos, por lo que **no** es una validación independiente. El pequeño
lote separado en `reports/genre-laya-holdout-pilot-2026-09-26.*` tuvo 9 casos:
Laya acertó 6/9 y el primer candidato 3/9. Nueve casos no bastan para fijar
umbrales ni aprobar publicación; hace falta un conjunto prospectivo y más
amplio, revisado por responsables de CRV.
