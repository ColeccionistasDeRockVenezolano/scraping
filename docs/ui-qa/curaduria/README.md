# QA visual de Curaduría — E7/E8

Este directorio es la salida reproducible de `npm run test:visual-curation`.
El harness levanta un PostgreSQL 16 desechable, aplica el core y migraciones,
siembra casos conocidos, levanta la API y la SPA y usa Chromium headless. Nunca
inicia sesión en el despliegue real ni escribe en la base de desarrollo.

## Criterios cubiertos

### E7 — disputas y cola dentro de Curaduría

- Tarjeta de `field_conflict` con lados A/B, fuente, `trust_level`, fecha y URL.
- Decisión A/B/otro valor desde la misma tarjeta con valor y motivo obligatorios.
- Acción grupal por fuente de mayor confianza.
- Un conflicto con empate de `trust_level` queda excluido del lote.
- El backend mantiene además contratos para A/B/otro, Accept/Reject,
  `person_duplicate` y contador de duplicados.

Capturas principales: `desktop-e7-conflicto-ab.png`,
`desktop-e7-otro-valor.png`, `desktop-e7-confianza-preview.png`,
`desktop-e7-confianza-aplicada.png`, `desktop-e7-revisiones.png` y
`desktop-e7-duplicado-precargado.png`.

### E8 — experiencia de corrección

En **1280×1000** y **400×900** se comprueba:

- ayuda y triaje por teclado, con focus trap y restauración del foco;
- acción recomendada real con nivel + consecuencia y contraste AA;
- hoja inferior de acciones en móvil;
- selección total por `filter` (más de una página) y selección explícita;
- vista previa antes → después, fichas tocadas y exclusiones;
- cambio de acción por fila con recálculo de vista previa;
- colisiones visibles antes de escribir;
- motivo obligatorio;
- aplicar y resultado/progreso del lote;
- toast individual «Deshacer»;
- deshacer con restauración;
- historial de correcciones;
- evidencia legible con JSON técnico colapsado;
- contraste AA de controles críticos y evidencia A/B;
- «Surgidos tras corregir» y «Marcar como revisado»;
- ausencia de overflow horizontal y errores de consola.

Capturas por viewport: `*-atajos.png`, `*-preview-lote.png`,
`*-lote-aplicado.png`, `*-lote-desecho.png`,
`*-correcciones.png`, `*-evidencia-legible.png`,
`*-verificacion.png` y `*-desencadenados.png`. En móvil se añade
`mobile-hoja-acciones.png`; en escritorio también
`desktop-seleccion-total-preview.png`, `desktop-seleccionados-preview.png`,
`desktop-accion-por-fila.png` y `desktop-colision-preview.png`.

## CI

El job bloqueante **Curaduría visual (desktop y móvil)** instala Chromium,
ejecuta `npm run test:visual-curation` y sube este directorio como artefacto
`curaduria-ui-qa`. Un PR no queda verde si cualquiera de estos flujos falla.
