# Cierre de `datos_incoherentes` — 25 de septiembre de 2026

## Estado comprobado

El análisis completo **276** terminó con `status=ok`, sin fallos, y la consulta a `ingest.curation_findings` devolvió **0 hallazgos abiertos** en `datos_incoherentes`. Hay 210 hallazgos ignorados con motivo registrado y 1076 resueltos en el historial de esta categoría; estas cifras incluyen análisis anteriores y hallazgos encadenados, no son un recuento de cambios de una sola ejecución. La línea de partida de esta intervención era 867 abiertos.

El servicio local `crv-api.service` se reinició para cargar la corrección del detector. `npm run typecheck` y los 19 tests de `test/unit/curation-rules-v2.test.ts` pasaron.

## Correcciones materiales

- Se clasificaron 501 discos con formato explícito en el título, además de 11 correcciones individuales de tipo. El detector ya no aprende `en` o `vivo` como palabras aisladas de `en vivo`; evitó falsos conflictos en títulos como «En Llamas».
- Se restauraron 47 primeras pistas y 77 pistas internas con número y título cotejados en páginas fuente. Se corrigieron varios números importados de forma errónea. Después, la [página oficial de G-CORE](https://guarapacore.bandcamp.com/album/g-core-2) permitió añadir «Guarapa Core» en la posición 2, y los listados de [Los Claners](https://open.spotify.com/album/0LBfw2N1LbJWyF9QcUNJuZ) y [Ángel Rada](https://open.spotify.com/playlist/2rhMVKhn9LiYFNH1kV7Dbh) confirmaron desplazamientos en la numeración.
- Se corrigieron la fecha de formación de Sentimiento Muerto según [El Punk en Venezuela](https://punkenvenezuela.com/cap02/), 23 duraciones de «Escalofrío XX Aniversario» según [Metal Archives](https://www.metal-archives.com/albums/Gillman/Escalofr%C3%ADo_XX_aniversario/1161046), la duración de «Latex», 13 créditos duplicados, tres tipos de crédito y un año de publicación.
- Se retiró con auditoría la falsa ficha «Tributo 50 Aniversario de Vida Artística» (run **5971**): la [página de origen](https://hippitoysuschatarritas.blogspot.com/2015/01/trino-mora-tributo-50-aniversario-de.html) es una nota biográfica que menciona un sencillo de 1981, no un disco con ese título. Sus claims se rechazaron y la pista/crédito asociados se retiraron con el mecanismo de historial.

## Hallazgos clasificados sin cambiar datos

- Los años que forman parte de títulos artísticos, las compilaciones de demos y los formatos mixtos se marcaron `correcto_a_proposito` con explicación individual.
- Los valores de duración atípicos que coinciden con fuentes se marcaron `correcto_a_proposito`. Los atípicos sin prueba contradictoria se marcaron `fuera_de_alcance`; un extremo estadístico no demuestra un dato incorrecto.
- Las pistas sin duración se marcaron `fuera_de_alcance` cuando no existe claim de duración para ellas. Sigue siendo metadato incompleto, pero no una contradicción con otras pistas del disco.
- Ocho avisos de numeración quedaron `fuera_de_alcance`: las propias fuentes omiten un número o listan solo una selección promocional, y no se halló un título independiente verificable. Son los álbumes **1699, 2509, 3062, 3254, 3290, 736, 1642 y 1411**. Las notas de cada hallazgo conservan la URL examinada. La ficha se puede enriquecer en el futuro si aparece otra fuente; no se crearon pistas inventadas ni se renumeró sin evidencia.

## Trazabilidad

Los cambios de catálogo se registraron mediante lotes de curaduría y `withOperatorRun`; entre los runs finales están **5968** (tipos), **5969** (numeración y pistas) y **5971** (ficha falsa). Las exclusiones usan `ignoreFinding` con razón y nota por hallazgo. Los scripts de trabajo y resultados intermedios están en `tmp-analysis/`.
