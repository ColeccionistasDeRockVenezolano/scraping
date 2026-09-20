# QA visual de Curaduría — E7/E8

Este directorio es la salida reproducible de `npm run test:visual-curation`.
El harness levanta un PostgreSQL 16 desechable, aplica el core y migraciones,
siembra casos conocidos, levanta la API y la SPA y usa Chromium headless. Nunca
inicia sesión en el despliegue real ni escribe en la base de desarrollo.

## Criterios cubiertos

### E7 — disputas y cola dentro de Curaduría

- Tarjeta de `field_conflict` con lados A/B, fuente, `trust_level`, fecha y URL.
- Decisión A/B desde la misma tarjeta con motivo obligatorio.
- Acción grupal por fuente de mayor confianza.
- Un conflicto con empate de `trust_level` queda excluido del lote.
- El backend mantiene además contratos para A/B/otro, Accept/Reject,
  `person_duplicate` y contador de duplicados.

Capturas principales: `desktop-e7-conflicto-ab.png`,
`desktop-e7-confianza-preview.png` y
`desktop-e7-confianza-aplicada.png`.

### E8 — experiencia de corrección

En **1280×1000** y **400×900** se comprueba:

- ayuda y triaje por teclado;
- acción recomendada real;
- hoja inferior de acciones en móvil;
- vista previa antes → después;
- motivo obligatorio;
- aplicar y resultado/progreso del lote;
- toast individual «Deshacer»;
- deshacer con restauración;
- historial de correcciones;
- evidencia legible;
- «Surgidos tras corregir» y «Marcar como revisado»;
- ausencia de overflow horizontal y errores de consola.

Capturas por viewport: `*-atajos.png`, `*-preview-lote.png`,
`*-lote-aplicado.png`, `*-lote-desecho.png`,
`*-correcciones.png`, `*-verificacion.png` y
`*-desencadenados.png`. En móvil se añade `mobile-hoja-acciones.png`.

## CI

El job bloqueante **Curaduría visual (desktop y móvil)** instala Chromium,
ejecuta `npm run test:visual-curation` y sube este directorio como artefacto
`curaduria-ui-qa`. Un PR no queda verde si cualquiera de estos flujos falla.
