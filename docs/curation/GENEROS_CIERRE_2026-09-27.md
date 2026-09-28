# Géneros: cierre operativo del 27-09-2026

## Orden de decisión

Primero se aplican los libros de fuentes verificadas. `source-over-laya.ts`
deshace principales previos de Laya cuando una fuente identificada los
contradice; `apply-source-genres.ts` confirma el género que nombra la fuente.
Bandcamp precede a Deezer cuando ambos tienen el mismo disco, porque sus
etiquetas suelen ser más específicas. iTunes de discos se aplicó solo a los 23
discos que no aparecían en los dos libros anteriores. Laya v6 se aplica al
final con `--min=0`: sus abstenciones siguen sin género.
Para iTunes por artista, `scripts/prepare-itunes-artist-ledger.ts` separa las
filas nuevas de las ya cubiertas por un género reconocido de Last.fm.

## Fuentes aplicadas

| Paso | Ensayo | Confirmación | Resultado |
| --- | ---: | ---: | --- |
| Bandcamp y Deezer sobre Laya | 10388 | 10389 | 14 principales de Laya deshechos |
| Bandcamp y Deezer | 10390 | 10391 | 16 discos confirmados, 0 errores |
| Last.fm sobre Laya | 10393 | 10394 | 13 principales de Laya deshechos |
| Last.fm | 10395 | 10396 | 56 fichas confirmadas, 3 términos sin resolver, 0 errores |
| iTunes discos nuevos sobre Laya | 10398 | 10399 | 6 principales de Laya deshechos |
| iTunes discos nuevos | 10400 | 10401 | 6 discos confirmados, 0 errores |

Last.fm terminó la cosecha con 1.832 artistas buscados, 576 identificados y
cero peticiones fallidas. Las páginas de Last.fm pueden reunir homónimos bajo
un solo nombre; compartir un título de disco no basta cuando la biografía
describe otra banda. `scripts/genre-source-skip.ts` excluye 14 filas de
artista con contradicción visible, además de la exclusión previa de Trujillo.
`scripts/export-laya-dossiers.ts` también excluye sus biografías del texto de
Laya. Las exclusiones quedan auditables por fuente y ficha.

## Listas alfabéticas y Laya

El exportador encontró 78 fichas con principal de fuente, fila localizable,
lista alfabética y al menos dos géneros aplicables. Laya propuso 73 principales
y se abstuvo en 5. El ensayo y la confirmación coincidieron: 39 principales
reordenados, 34 iguales y cero errores. Corrida confirmada en
`reports/genres-source-alphabetical-confirm-2026-09-27.json`.

v6 contiene 307 expedientes aún sin principal, con texto propio y opciones
mencionadas en ese texto. Laya sugirió 214 géneros y se abstuvo en 93. El
ensayo inicial `--min=0` (run 10404) encontró 214 aplicables y cero errores.
Tras iTunes por artista, 4 ya tenían principal de fuente y se confirmaron 210
(run 10412), con cero errores.

## Cierre de iTunes por artista y v6

iTunes reunió 92 filas con género; 64 no estaban cubiertas por Last.fm. La
fuente deshizo 11 principales de Laya (run 10408) y confirmó 49 artistas
(run 10410), con 14 ya clasificados, 1 término sin resolver y 0 errores. El
término pendiente es «Urbano latino» de Bolívar (`artist:402`): la taxonomía no
lo equipara a un único género. Laya v6 confirmó 210 fichas (run 10412), con
93 abstenciones y 4 ya clasificadas por fuentes.

La revisión posterior encontró que el expediente de Bolívar tenía la
biografía de Simón Bolívar, ajena al músico. Se deshizo su `death-metal` de
Laya (ensayo 10413, confirmación 10414) y se excluyó esa fila de Wikipedia de
futuros expedientes. También se excluyó la página del pueblo Chaima; esa banda
sí conserva su evidencia musical independiente de RHV.

## Comprobaciones

- Escaneo final de curaduría #425: 1.306 hallazgos, 0 nuevos y 0 resueltos.
- `npm run typecheck`: pasa.
- Pruebas dirigidas de géneros: 89 pasan en 4 archivos.
- Suite completa: 98 archivos y 811 pruebas pasan; 1 archivo y 1 prueba se omiten.
