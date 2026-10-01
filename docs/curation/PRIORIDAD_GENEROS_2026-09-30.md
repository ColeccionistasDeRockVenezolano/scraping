# Prioridad de géneros: fuente > Laya > heredado (2026-09-30)

Regla del propietario (Brian, 2026-09-30, durante la campaña del canal «Full album»):

> «fuente gana sobre laya y laya gana sobre género heredado de artista — o sea,
> fuente gana sobre los dos».

Orden de precedencia al decidir el género de un disco o artista:

1. **Fuente publicada** que nombra un género (catálogo, artículo, archivo) — máxima
   prioridad. Entra por los libros de evidencia (`apply-source-genres.ts`,
   `decided_by='auto:<fuente>'`) o por una decisión que la cite.
2. **Laya** (`auto:laya`): lo que el clasificador dejó se conserva mientras no
   aparezca una fuente; una fuente posterior lo desplaza.
3. **Género heredado del artista** (regla del 2026-09-30: un disco sin género
   hereda el del artista ya documentado) — la prioridad **más baja**. Tanto una
   fuente como una decisión de Laya sobre el disco lo desplazan.

## Mecánica

`confirmGenre` (`src/genres/human.ts:83-112`) demota el principal anterior a
secundario al confirmar uno nuevo. Aplicar el nivel superior en cualquier momento
deja al inferior como secundario, dentro de su propio run (reversible desde el
historial). Los géneros heredados quedan con la nota explícita «Herencia de
artista… LA FUENTE GANA» (campaña 2026-09-30).

## Notas

- Esta jerarquía NO cambia la regla ya vigente «la fuente manda sobre Laya» de la
  campaña de fuentes externas (2026-09-26/27): la extiende por abajo con el nivel
  heredado.
- Un conflicto entre dos fuentes no lo resuelve esta regla: se decide con
  documentación explícita y queda anotado en la decisión.
