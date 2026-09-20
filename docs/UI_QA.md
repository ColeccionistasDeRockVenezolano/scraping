# QA visual de la interfaz CRV

Fecha: 14 de septiembre de 2026  
Alcance: fases 8 y 9 del plan. Interfaz React contra la API Fastify, sin acceso directo del navegador a PostgreSQL.

## Resultado

La interfaz se verificó en Chromium a 1440 × 1000 y 390 × 844. El recorrido real del criterio de salida funciona:

1. Buscar `Caramelos`.
2. Abrir **Caramelos De Cianuro**.
3. Abrir **Las Paticas De La Abuela**.
4. Ver sus cuatro pistas, incluida **Nadando a Través De La Galaxia**.
5. Abrir **Asier Cazalis** desde los créditos.
6. Volver al disco.
7. Abrir **Mad Box's Studios** desde producción.

El recorrido está automatizado por `cd web && npm run qa:smoke`.

## Problemas demostrados y correcciones

| Problema observado | Evidencia antes | Corrección | Evidencia después |
|---|---|---|---|
| La cabecera móvil excedía el viewport en 64 px y ocultaba navegación. | `ui-qa/before/before-mobile-disco-las-paticas.png` y las otras siete rutas móviles. | Navegación inferior de seis destinos, iconos coherentes, etiqueta compacta para organizaciones y control de operador reducido. | `ui-qa/after/after-mobile-disco-las-paticas.png`; el detector de overflow da 0 px en todas las rutas. |
| La tabla de pistas comprimía títulos hasta volverlos difíciles de leer. | `ui-qa/before/before-mobile-disco-las-paticas.png`. | La tabla conserva un ancho legible dentro de un contenedor desplazable; el documento no crece horizontalmente. | `ui-qa/after/after-mobile-disco-las-paticas.png`. |
| Un nombre y una biografía extremos forzaban 91 px de overflow en la ficha móvil. | Fallo cuantificado por `test:visual-extreme`; los ofensores fueron el título, descripción y metadatos del hero. | `min-width: 0`, cortes seguros y badges flexibles en la ficha. | `ui-qa/extreme/mobile-nombre-biografia-largos.png`; prueba posterior con 0 px de overflow. |
| El texto secundario tenía contraste débil en pantallas oscuras. | Capturas `before`, especialmente roles y metadatos. | Neutros secundarios elevados sin alterar el rojo ni el fondo de la identidad CRV. | Capturas `after` de álbum, persona, organización y revisión. |
| Los modales no protegían foco ni bloqueaban el scroll de fondo y los formularios largos eran incómodos en móvil. | `ui-qa/before/before-mobile-form-editar.png`. | Portal a `body`, foco inicial, ciclo de Tab, Escape, restauración de foco, bloqueo de scroll y hoja inferior móvil con acciones fijas. | `ui-qa/after/after-mobile-form-editar.png`. |
| La cola obligaba a interpretar JSON para conocer candidato y confianza. | `ui-qa/before/before-*-revision-detalle.png`. | Resumen visible de campo, confianza, candidato, valor actual/propuesto y claims con fuente; el payload íntegro se conserva. | `ui-qa/after/after-*-revision-detalle.png`. |
| “Editar aliases” solo permitía añadir, marcar principal o retirar. | Inspección funcional de E8. | Edición real de texto y tipo, con nota de auditoría; retiro con confirmación. | Contrato de alias y controles visibles en fichas con token de operador. |
| La navegación inferior quedaba anclada al `backdrop-filter` de la cabecera y cubría el control del operador. | Revisión independiente en Chromium: navegación en `top=-6` y clic de operador interceptado. | En móvil la cabecera usa fondo sólido, la navegación vuelve a fijarse al viewport y el operador tiene un target de 44 × 44 px. | Medición final a 390 × 844: navegación en `y=780`, operador en `y=7`, modal abre por clic y overflow 0 px. |
| La prueba extrema medía overflow en el disco, pero no después de navegar al artista largo. | La revisión detectó capturas de 1367 px para un viewport de 390 px. | Se añadió la segunda aserción y se corrigieron los títulos/subtítulos inline de las tarjetas para que el truncado sea efectivo. | La prueba falló primero con 46 px en desktop y luego pasó en desktop y móvil con 0 px. |
| Búsqueda, filtros y selectores de entidad no tenían toda su semántica accesible. | Inspección independiente de etiquetas y controles. | Etiquetas asociadas, combobox/listbox con estado ARIA y teclado, nombres accesibles en decisiones y targets táctiles móviles. | Typecheck, build e interacción real del operador móvil superados. |

## Matriz de capturas

Las carpetas contienen capturas reales de buscador, lista de artistas, artista, disco, persona, organización, cola de revisión, detalle de revisión y formularios de creación/edición:

- Antes: `docs/ui-qa/before/`
- Después: `docs/ui-qa/after/`
- Extremos desechables: `docs/ui-qa/extreme/`

Cada grupo `after` tiene versión `desktop` y `mobile`. Las capturas principales usan datos reales de la base local; los archivos `extreme` se generaron exclusivamente desde un PostgreSQL Docker temporal.

## Escenario extremo aislado

`npm run test:visual-extreme` crea un contenedor PostgreSQL desechable, aplica el core y las migraciones, inserta fixtures marcados `VISUAL_QA_TEMP`, levanta API y Vite en puertos efímeros/de prueba, captura y elimina el contenedor en `finally`.

Se verificó:

- 30 músicos de álbum;
- 50 créditos adicionales;
- 100 pistas, con la pista 100 accesible tras scroll;
- nombre extremadamente largo;
- biografía/descripción de 18 párrafos;
- 0 px de overflow horizontal en 1440 px y 390 px, tanto en el disco denso como en la ficha de artista con contenido largo;
- ausencia de errores de ejecución en la página.

La base de desarrollo no recibe escrituras durante esta prueba.

## Comparación con los SVG de modelo

Se compararon `crv_simple_conceptual.svg` y `crv_simple_relational.svg` con la navegación presentada:

- `ARTISTS → ALBUMS → TRACKS`: artista muestra discografía; disco muestra pistas.
- `PERSONS ↔ ARTIST_MEMBERS`: artista y persona enlazan la misma membresía y su período.
- `PERSONS/ARTISTS/ORGANIZATIONS ↔ ALBUM_CREDITS/TRACK_CREDITS`: los destinos acreditados son clicables; los créditos de pista se despliegan dentro del disco.
- `ORGANIZATIONS ↔ ALBUMS/PERSON_ORGANIZATIONS`: sellos, estudios y personas asociadas se muestran con navegación recíproca cuando hay datos.
- `ALBUM_FORMATS`: se muestra y administra desde el disco.

No se detectó una contradicción conceptual entre los SVG y las relaciones mostradas. Los alias y enlaces de medios pertenecen a esquemas auxiliares posteriores y, por ello, no aparecen en esos SVG del core.

## QA visual de Curaduría (plan de Curaduría, C-E8)

Fecha: 2026-09-20. Harness: `npm run test:visual-curation`
(`web/tests/visual/curation-qa.ts`). **Nunca corre contra la base de
desarrollo**: levanta su propio PostgreSQL en contenedor, siembra un catálogo
con casos conocidos, analiza con el código real, arranca API y web, entra como
admin de QA y captura a **1280 px y 400 px**.

Las 38 capturas están en `docs/ui-qa/curaduria/` (19 de escritorio + las mismas
19 en móvil, con el prefijo `desktop-`/`mobile-`):

| Qué demuestra | Captura |
|---|---|
| Panorama y menú por categoría | `*-panorama.png`, `*-menu.png` (a 400 px el menú se pliega en un botón) |
| Listado de una categoría y «Otros» por tandas | `*-nombres-sucios.png`, `*-otros.png`, `*-otros-mas.png` |
| Vista previa antes → después con el tramo resaltado | `*-vista-previa.png` |
| Otras correcciones de la tarjeta | `*-otras-correcciones.png` |
| Resultado del lote, detalle e historial | `*-lote-aplicado.png`, `*-lote-detalle.png`, `*-correcciones.png` |
| Deshacer a mano tras aplicar | `*-deshacer.png` |
| Verificación dirigida y lo que desencadenó | `*-verificacion.png`, `*-desencadenados.png` |
| Motivo obligatorio al ignorar y «Son distintas» | `*-ignorar-motivo.png`, `*-son-distintas.png` |
| Selección de los N que cumplen el filtro | `*-seleccion-total.png` |
| Valores en disputa decididos desde la tarjeta | `*-conflictos.png` |
| Autocorrección: reglas, panorama y lo de hoy | `*-autocorreccion.png`, `*-autocorreccion-panorama.png`, `*-autocorreccion-hoy.png` |
| **Triaje con teclado** (`j/k` mover, `x` seleccionar, `c` corregir, `i` ignorar, `o` abrir, `?` ayuda) | `*-teclado.png` |
| Acciones en hoja inferior a 400 px | `mobile-acciones-hoja.png` |

El harness no solo captura: falla si hay overflow horizontal, si la consola
registra errores, si «No es un problema» no exige motivo, si «Son distintas» no
guarda el par, si el botón principal no lleva el nombre de la acción
recomendada, si la vista previa no resalta el tramo que cambia o si los atajos
no mueven el foco. En CI es una puerta que bloquea el PR.

> Regla del harness (§0.1.8 del plan de Curaduría): cualquier harness nuevo debe
> poner `process.env["CRV_SESSION_COOKIE_PATH"] = "/"` antes de
> `resetEnvCache()`/`buildApp()`. Con el `/crv` del `.env` el login «funciona»
> pero todo lo admin responde 401.

## Verificación ejecutada

```text
cd web && npm run typecheck
cd web && npm run build
cd web && npm run qa:smoke
cd web && npm run qa:capture
npm run test:visual-extreme
npm run test:visual-curation
npm run test:contract
```

El detector mecánico de Impeccable sobre `web/src` devolvió `[]`.
