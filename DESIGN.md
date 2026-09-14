---
name: "CRV · Catálogo"
description: "Archivo editorial y panel de operación para la memoria del rock venezolano."
colors:
  archive-black: "#0a0a0a"
  surface-ink: "#141414"
  surface-raised: "#1c1c1c"
  surface-high: "#242424"
  border-structural: "#2a2a2a"
  border-soft: "#1e1e1e"
  text-primary: "#f5f5f5"
  text-secondary: "#ababab"
  text-faint: "#858585"
  brand-red: "#e50914"
  brand-red-strong: "#ff0f1b"
  brand-red-soft: "rgba(229, 9, 20, 0.16)"
  archive-amber: "#ffb02e"
  archive-amber-soft: "rgba(255, 176, 46, 0.16)"
  reference-violet: "#b185e3"
  reference-violet-soft: "rgba(177, 133, 227, 0.16)"
  verified-teal: "#2ec4b6"
  verified-teal-soft: "rgba(46, 196, 182, 0.16)"
typography:
  display:
    fontFamily: "Anton, Arial Black, sans-serif"
    fontSize: "clamp(28px, 5vw, 44px)"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.01em"
  headline:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "30px"
    fontWeight: 700
    lineHeight: 1.1
    letterSpacing: "-0.01em"
  title:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "18px"
    fontWeight: 700
    lineHeight: 1.55
  body:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.55
  control:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "13.5px"
    fontWeight: 600
    lineHeight: 1.55
  field:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "Inter, system-ui, -apple-system, sans-serif"
    fontSize: "11px"
    fontWeight: 700
    lineHeight: 1.55
    letterSpacing: "0.1em"
  data:
    fontFamily: "JetBrains Mono, ui-monospace, SF Mono, Menlo, monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.55
rounded:
  sm: "8px"
  md: "12px"
  lg: "18px"
  pill: "999px"
spacing:
  compact: "6px"
  control: "8px"
  field: "14px"
  mobile-gutter: "16px"
  desktop-gutter: "24px"
  section: "36px"
components:
  button-default:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  button-primary:
    backgroundColor: "{colors.brand-red}"
    textColor: "#fff"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  button-danger:
    backgroundColor: "transparent"
    textColor: "#ff8b90"
    typography: "{typography.control}"
    rounded: "{rounded.sm}"
    padding: "9px 16px"
  input:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-primary}"
    typography: "{typography.field}"
    rounded: "{rounded.sm}"
    padding: "9px 12px"
  card:
    backgroundColor: "{colors.surface-ink}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.md}"
    padding: "16px 18px"
  badge:
    backgroundColor: "{colors.surface-raised}"
    textColor: "{colors.text-secondary}"
    typography: "{typography.label}"
    rounded: "{rounded.pill}"
    padding: "3px 10px"
---

# Design System: CRV · Catálogo

## Overview

**Creative North Star: "El Archivo en Operación"**

CRV se siente como un archivo musical editorial que está siendo consultado y cuidado, no como una aplicación de consumo ni como un dashboard corporativo genérico. El negro cálido crea continuidad y concentración; las superficies apenas elevadas organizan discos, personas, créditos y evidencia con una densidad serena. La portada, el nombre y la relación entre entidades siempre importan más que el ornamento.

Este sistema trabaja en modo **Operate**: lectura compacta, acciones directas, estados inequívocos y trazabilidad visible. El rojo es la voz de marca y acción; ámbar, violeta y teal son señales medidas para jerarquía, referencia y verificación. Los datos largos y los casos extremos deben seguir siendo legibles sin romper el flujo ni expandir el viewport.

**Key Characteristics:**

- Archivo oscuro, cálido y editorial.
- Densidad informativa con jerarquía clara y aire entre secciones.
- Rojo de marca reservado para acción, foco y selección.
- Acentos secundarios semánticos, nunca decorativos.
- Tipografía funcional: Inter para interfaz, Anton para momentos de identidad y JetBrains Mono para datos.
- Operación segura: estados, confirmaciones, evidencia y notas de auditoría visibles.

**The Evidence Before Ornament Rule.** Cada superficie debe ayudar a identificar, comparar, decidir o navegar una relación del catálogo; no se añade decoración que compita con esos trabajos.

## Colors

La paleta construye profundidad con negros próximos y usa el color saturado como señal escasa sobre un campo casi monocromo.

### Primary

- **Rojo CRV:** voz de marca, botones primarios, navegación activa, foco, selección y estados destructivos.
- **Rojo CRV intenso:** respuesta hover de la acción primaria y énfasis de controles destructivos.
- **Rojo CRV velado:** fondo de navegación activa, anillos de foco y estados de peligro sin llenar grandes superficies.

### Secondary

- **Ámbar de archivo:** marca el alias principal y avisos; su versión velada sostiene estados sin dominar la página.
- **Violeta de referencia:** identifica vínculos o información contextual, como un sello discográfico; se usa solo cuando la categoría lo justifica.

### Tertiary

- **Teal verificado:** confirma éxito y presencia activa del operador; su halo velado comunica estado sin parecer un CTA.

### Neutral

- **Negro de archivo:** fondo continuo de toda la aplicación.
- **Tinta de superficie:** tarjetas, filas y hero de entidad.
- **Superficie elevada:** cabeceras de tabla, campos y comparación de evidencia.
- **Superficie alta:** chips internos, scrollbar y toasts.
- **Borde estructural:** delimita contenedores, controles y tablas.
- **Borde suave:** separa filas internas sin fragmentar visualmente el contenido.
- **Texto principal:** títulos, valores y acciones legibles.
- **Texto secundario:** descripciones y controles de menor jerarquía.
- **Texto tenue:** metadatos, etiquetas y ayudas; ya está calibrado para el fondo oscuro y no debe reducirse más.

**The Red Is a Signal Rule.** El rojo CRV no cubre tarjetas ni secciones completas: aparece en marca, acción primaria, foco, selección y peligro.

**The Accent Has a Job Rule.** Ámbar, violeta y teal solo entran cuando comunican una categoría o estado; no se alternan para producir variedad visual.

## Typography

**Display Font:** Anton (con Arial Black y sans-serif como fallback)

**Body Font:** Inter (con system-ui, -apple-system y sans-serif como fallback)

**Data Font:** JetBrains Mono (con ui-monospace, SF Mono, Menlo y monospace como fallback)

**Character:** Anton aporta la contundencia de cartel musical únicamente en marca, placeholders y el encabezado del buscador. Inter sostiene el trabajo diario con una voz neutral y firme; JetBrains Mono estabiliza años, duraciones, IDs, conteos y payloads.

### Hierarchy

- **Display:** peso regular y escala fluida; se reserva para el encabezado central del buscador.
- **Headline:** peso fuerte, interlineado compacto y tracking ligeramente negativo; identifica una entidad. En móvil baja de 30px a 24px para preservar el ancho.
- **Page title:** 26px, peso fuerte y tracking ligeramente negativo; abre listas y tareas.
- **Modal title:** 18px; nombra una acción contenida sin competir con el contexto de fondo.
- **Body:** 15px con interlineado 1.55; base de la aplicación. Descripciones de entidad usan 14px y un ancho máximo de 72ch; introducciones de página, 68ch.
- **Control:** 13.5px y peso 600 en botones; 13.5px regular en tablas y campos.
- **Label:** 11–12px, peso 700, mayúsculas y tracking de 0.06–0.1em para kickers, títulos de sección y cabeceras de tabla.
- **Data:** monoespaciada con cifras tabulares para números, duraciones, intervalos, conteos, comparaciones y evidencia técnica.

**The Display Is a Stamp Rule.** Anton funciona como sello de identidad, no como tipografía general de titulares o controles.

**The Metadata Stays Quiet Rule.** Metadatos y etiquetas reducen tamaño y contraste, pero mantienen el peso y espaciado necesarios para seguir siendo escaneables.

## Layout

El contenido vive en un contenedor centrado de ancho máximo 1180px, con gutter de escritorio de 24px y gutter móvil de 16px. La barra superior mide 64px, es sticky y usa fondo negro al 90%, blur de 10px y borde inferior; el contenido principal comienza con 32px de separación y conserva 96px al final. Las secciones se separan verticalmente 36px: la densidad existe dentro de cada bloque, no por comprimir toda la página.

Las fichas de entidad abren con una retícula de arte + contenido: portada de 132px, gap de 24px y padding de 24px. Las listas de entidades usan columnas automáticas de mínimo 230px; formularios, columnas automáticas de mínimo 200px; créditos, columnas de mínimo 320px; hechos de revisión, mínimo 170px; evidencia, mínimo 260px. Estos mínimos son límites de legibilidad, no objetivos para amontonar columnas.

A 760px o menos, la interfaz cambia de modelo: la navegación principal se fija abajo en seis columnas iguales, mide 64px más el safe area, muestra iconos de 18px y etiquetas de 9.5px. El `body` reserva 70px más el safe area para que nunca tape contenido. La cabecera superior pasa a 58px, fondo sólido sin blur, marca compacta y control de operador con target mínimo de 44×44px. Acciones de página y formularios pueden ocupar el ancho disponible.

A 640px o menos, el hero pasa a una columna, la imagen baja a 88px y comparaciones de revisión pasan de dos columnas a una. A 560px, el gutter se fija en 16px. En móvil, listas de tarjetas y grupos de créditos se apilan; los modales se convierten en hojas inferiores y sus acciones permanecen sticky.

Las tablas no se remaquetan como tarjetas: preservan un ancho mínimo de 620px dentro de un contenedor con desplazamiento horizontal y una pista visible “Desliza para ver más →”. Las tablas largas limitan su alto a 60vh con scroll vertical. Ningún nombre, biografía, badge o subtítulo puede ampliar el viewport; se usa truncado en tarjetas y corte seguro en contenido largo.

**The Density Inside, Air Between Rule.** Filas, créditos y campos son compactos; los grupos semánticos conservan 22–36px de separación para que el archivo siga siendo escaneable.

**The Viewport Never Expands Rule.** Los datos extremos se truncan, cortan o desplazan dentro de su contenedor; el documento no admite overflow horizontal.

## Elevation & Depth

La profundidad es híbrida pero contenida. En reposo, el sistema se organiza con capas tonales y bordes de 1px; las sombras no son decoración permanente de tarjetas. La sombra pequeña (`0 6px 16px rgba(0, 0, 0, 0.35)`) está disponible para elevación baja, la media (`0 14px 32px rgba(0, 0, 0, 0.45)`) sostiene menús de selección y toasts, y la grande (`0 24px 64px rgba(0, 0, 0, 0.55)`) separa modales del archivo subyacente. El botón primario añade un halo rojo (`0 8px 20px rgba(229, 9, 20, 0.35)`) solo al hover.

El topbar desktop usa blur para mantener contexto durante el scroll. En móvil se elimina ese blur del topbar para no crear un containing block que desplace la navegación fija; el bottom nav conserva blur de 16px sobre un fondo casi opaco.

**The Flat-at-Rest Rule.** Tarjetas, filas y tablas dependen de tono y borde; las sombras aparecen solo donde existe elevación funcional o respuesta interactiva.

## Shapes

La geometría es suavemente redondeada y utilitaria. El radio pequeño redondea botones, campos, navegación y filas compactas; el medio pertenece a tarjetas y tablas; el grande identifica heroes, búsqueda y modales. El radio píldora se reserva para badges, chips, estado del operador y ayudas flotantes. Los bordes de 1px son estructurales y de bajo contraste.

Las imágenes de entidad son cuadrados redondeados y recortados con `object-fit: cover`. Los placeholders mantienen la misma silueta y usan Anton, de modo que una imagen ausente no cambie la composición. En móvil, las hojas inferiores conservan únicamente las esquinas superiores grandes; los lados y el borde inferior llegan limpios al viewport.

**The Radius Signals Scale Rule.** 8px para controles, 12px para contenedores y 18px para superficies protagonistas o superpuestas; no se elige un radio por ornamento.

## Components

### Navigation

- **Desktop:** marca a la izquierda, destinos en una fila flexible y operador a la derecha. Los links usan texto secundario y pasan a texto principal sobre superficie de tinta al hover; el activo usa blanco sobre rojo velado.
- **Mobile:** bottom nav fija de seis destinos con icono sobre etiqueta. El topbar retiene marca y operador, pero no duplica los links.
- **Accessibility:** el `nav` se nombra “Principal”; los iconos son decorativos y la etiqueta de texto siempre permanece en el árbol accesible.

### Buttons

- **Shape:** control compacto con radio pequeño, borde de 1px y gap interno de 6px.
- **Primary:** rojo CRV, texto blanco y padding de 9px × 16px; el hover intensifica el rojo y añade halo. El active baja 1px.
- **Default:** superficie elevada, texto principal y borde estructural; el hover eleva el contraste del borde.
- **Danger:** fondo transparente, borde rojizo y texto rojo claro; llena con rojo velado al hover. Se usa para retirar o rechazar, no como alternativa estilística.
- **Ghost:** sin borde ni fondo; sirve para acciones subordinadas dentro de una sección o fila.
- **Small:** padding de 5px × 10px, 12.5px y radio de 7px. En móvil conserva altura táctil mínima de 44px.
- **States:** foco visible de 2px en rojo con offset de 2px; disabled a 45% de opacidad, sin desplazamiento ni sombra.

### Badges & Chips

- **Badges:** píldoras de 11px, peso 700, mayúsculas y tracking de 0.04em. Por defecto usan superficie elevada, borde estructural y texto secundario.
- **Semantic badges:** fondos velados y texto saturado en rojo, ámbar, violeta o teal. La variante outline es transparente y mantiene el borde.
- **Chips:** píldoras de texto de 12.5px con padding asimétrico para alojar acciones circulares de 18px. El alias principal usa borde ámbar y estrella ámbar; las acciones internas responden con rojo velado.
- **Mobile:** las acciones internas del chip crecen a 44×44px y el padding derecho se reduce para absorber el target sin hinchar toda la píldora.

### Cards / Containers

- **Entity card:** superficie de tinta, borde estructural, radio medio y padding de 16px × 18px. Miniatura cuadrada de 52px, título en una línea y subtítulo truncado.
- **Entity hero:** radio grande, superficie de tinta y borde estructural. Es la única tarjeta que recibe padding de 24px y arte de 132px.
- **Credit row:** superficie de tinta, borde suave, radio pequeño y padding de 8px × 10px; contrapone quién a la izquierda y rol a la derecha.
- **Review surfaces:** hechos, comparaciones y claims mantienen bordes y tonos; los payloads usan mono, pre-wrap, corte seguro y scroll interno.

### Dense Tables

- **Container:** superficie de tinta, borde estructural y radio medio; recorta la tabla y asume el scroll.
- **Header:** sticky, superficie elevada, 11px en mayúsculas, peso 700, tracking de 0.07em y padding de 11px × 14px.
- **Rows:** texto de 13.5px, celdas de 10px × 14px y divisores suaves. El hover cambia la fila completa a superficie elevada.
- **Numeric data:** alineación derecha, JetBrains Mono y cifras tabulares. Las acciones se agrupan al extremo derecho.
- **Mobile:** se mantiene la geometría tabular y se desplaza dentro del contenedor; nunca se aplastan títulos o columnas numéricas hasta volverlos ilegibles.

### Inputs / Fields

- **Style:** etiqueta secundaria de 12px y peso 600; campo sobre superficie elevada, borde estructural, radio pequeño y padding de 9px × 12px.
- **Focus:** borde rojo y halo de 3px en rojo velado; el filtro compacto usa solo el cambio de borde.
- **Search:** campo protagonista de 16px, padding de 16px × 20px y radio grande dentro de un shell máximo de 720px.
- **Error:** borde rojo, mensaje de 12px rojo claro y banner rojo velado con borde rojizo. Las ayudas usan 11.5px en texto tenue.
- **Entity picker:** combobox con listbox elevado, altura máxima de 220px y navegación por flechas, Enter y Escape; conserva `aria-expanded`, `aria-controls`, `aria-activedescendant` y selección activa.

### Modals

- **Desktop:** overlay negro al 60%, panel de hasta 560px o 760px en variante amplia, máximo 86vh, radio grande, borde estructural, sombra grande y padding de 22px × 24px.
- **Mobile:** hoja inferior de ancho completo, máximo `min(92dvh, 820px)`, solo esquinas superiores redondeadas y padding compatible con safe area. Las acciones permanecen visibles al final mediante posición sticky.
- **Behavior:** portal a `body`, scroll de fondo bloqueado, foco inicial, trampa de Tab, cierre con Escape o clic exterior y restauración del foco al origen.
- **Accessibility:** `role="dialog"`, `aria-modal="true"`, título conectado por `aria-labelledby` y botón de cierre con nombre accesible.

### Operator, State & Feedback

- **Operator pill:** comunica solo lectura o identidad activa. El dot neutral pasa a teal con halo cuando hay credenciales; en móvil queda un control circular mínimo de 44px.
- **Loading:** spinner de 22px con borde de 2.5px y rotación lineal de 0.7s; skeleton con shimmer de 1.4s ease.
- **Empty/error:** bloque centrado con 56px × 20px; error usa rol de alerta y ofrece reintento cuando aplica.
- **Toasts:** esquina inferior derecha, superficie alta, borde y sombra media; `aria-live="polite"`. Éxito y error cambian el borde a teal o rojo.

### Motion & Accessibility

Las transiciones de estado duran 120–150ms: transform de botón a 120ms y color, fondo, borde o sombra a 150ms. El overlay y los toasts entran con fade de 150ms. El movimiento es feedback, no espectáculo; no se animan reordenamientos de datos ni navegación entre registros.

Con `prefers-reduced-motion: reduce`, scroll animado se desactiva y toda animación o transición se reduce a 0.01ms con una sola iteración. Los links y botones deben conservar foco visible aun sin movimiento. Los targets móviles de operador, botones pequeños, cierre modal y acciones de chip alcanzan 44px. Inputs y selectores conservan etiquetas asociadas; los estados de carga y error usan roles de estado/alerta; imágenes decorativas o redundantes llevan texto alternativo vacío.

**The Motion Confirms Rule.** Una animación solo confirma entrada, carga o presión; nunca retrasa el acceso a datos o decisiones.

**The Keyboard Completes the Task Rule.** Todo flujo modal, selector y acción crítica debe poder completarse y abandonarse con teclado, con foco visible y restaurado.

## Do's and Don'ts

### Do:

- **Do** mantener el fondo negro de archivo y construir jerarquía mediante superficies cercanas y bordes discretos.
- **Do** reservar el rojo para marca, CTA primario, foco, selección y peligro.
- **Do** usar JetBrains Mono y cifras tabulares en años, IDs, duraciones, conteos y evidencia técnica.
- **Do** conservar tablas densas como tablas con scroll contenido en móvil.
- **Do** probar nombres, biografías, créditos y listas extremos sin overflow horizontal.
- **Do** mantener targets de 44px, safe areas, foco atrapado en modales y etiquetas accesibles.
- **Do** presentar valor actual, propuesta, confianza y fuente antes del payload completo en tareas de revisión.

### Don't:

- **Don't** convertir el panel en un dashboard de tarjetas grandes, gradientes o métricas decorativas.
- **Don't** usar ámbar, violeta o teal como colores alternos sin una semántica concreta.
- **Don't** cubrir superficies grandes con rojo ni usar sombras permanentes para elevar cada tarjeta.
- **Don't** sustituir la navegación inferior móvil por una cabecera horizontal comprimida o desplazable.
- **Don't** colapsar una tabla compleja en texto ilegible; desplázala dentro de su contenedor y muestra la pista de scroll.
- **Don't** ocultar acciones críticas bajo la navegación inferior o fuera de una hoja modal larga.
- **Don't** usar Anton para cuerpo, labels, tablas o formularios.
- **Don't** depender solo del color, del hover o del movimiento para comunicar estado y acción.
