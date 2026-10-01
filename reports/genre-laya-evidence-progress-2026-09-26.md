# Avance de evidencia para Laya

Base fija: 4.128 fichas sin evidencia de género del mismo nivel en la auditoría inicial (2.621 álbumes y 1.507 artistas). El JSON homónimo contiene la lista de identificadores aún pendientes y la hora del último corte verificado.

| Nivel | Base sin evidencia | Evidencia recuperada | Pendientes |
|---|---:|---:|---:|
| Álbumes | 2.621 | 698 | 1.923 |
| Artistas | 1.507 | 81 | 1.426 |
| **Total** | **4.128** | **779** | **3.349** |

Este corte suma 709 fichas de Sincopa, 27 artistas con frases directas en Rock De Vzla/Rockzuela, 4 artistas de Wikidata con identidad corroborada y 65 sugerencias externas de álbum en la base. Hay 26 fichas compartidas entre Sincopa y las sugerencias externas. Los ledgers locales conservan URL, valor bruto y hash de la captura; las sugerencias externas siguen en estado `suggested`. Ninguna decisión de Laya se confirmó como género del catálogo.

Laya evaluó 739 fichas con evidencia y candidatos activos: 554 sugerencias, 185 abstenciones, cero errores. Falta una referencia humana para medir la precisión de este lote; estos números son cobertura y salida del modelo, no porcentaje de acierto.

## Fuentes examinadas

- **Sincopa:** 647 álbumes con enlace aceptado, 50 artistas con enlace aceptado y 12 álbumes encontrados por cruce único de título, artista y año compatible.
- **Rock De Vzla y Rockzuela:** 23 y 4 artistas nuevos, respectivamente, con frase directa sobre el género del propio artista y captura verificable.
- **Wikidata:** 4 artistas con propiedad P136, nombre exacto e identidad corroborada por Discogs o por un álbum compartido. Queda como piloto de evaluación.
- **Discogs:** 65 álbumes de la cohorte inicial tienen sugerencias externas; 26 también poseen evidencia de Sincopa. El último lote de 200 álbumes aportó 7 sugerencias y registró 3 errores 404 aislados. La fuente se usa solo para álbumes.
- **MusicBrainz:** muestra ampliada de 100 artistas, 54 identidades emparejadas, 13 comparables y precisión 6/13 (46,2 %) al contar acuerdo exacto o de familia. La importación masiva permanece deshabilitada.
- **TheAudioDB:** en 20 artistas, una identidad exacta y ningún género útil.
- **iTunes Search API:** 9 de 20 nombres de artista ambiguos por homónimos; solo 3 de 20 álbumes tienen título y artista exactos, y sus etiquetas Rock son demasiado amplias o discordantes frente a las referencias.
- **Lobotoradio:** la web declara 626 bandas con género y muestra géneros explícitos en fichas; es prometedora para artistas, pero aún no se ha medido el cruce con el inventario ni existe integración autorizada. Su robots.txt pide 10 segundos entre accesos.
- **Metal Archives:** el sitio bloquea acceso automatizado; no se realizará importación masiva mediante el sitio.

## Próximos pasos

1. Continuar Discogs solo si la productividad justifica su coste; el último lote de 200 aportó 7 sugerencias. Recalcular la unión tras cada lote.
2. Evaluar si Lobotoradio ofrece una vía de acceso programático permitida y medir identidad y precisión antes de integrar; solicitar permiso o un volcado al sitio si no existe una vía documentada.
3. Priorizar fuentes con género explícito del mismo nivel, identidad verificable y cobertura de los casos pendientes. No transferir el género de un artista a sus álbumes ni viceversa.
4. Pasar a Laya solo fichas con evidencia y opciones activas; revisar humanamente la salida antes de confirmar géneros. Conservar Sin clasificar cuando falte respaldo.
