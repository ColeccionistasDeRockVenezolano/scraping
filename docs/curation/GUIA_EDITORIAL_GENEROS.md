# Guía editorial de géneros

Para quien resuelve géneros en la Mesa de Cotejo (pestaña **Géneros**). Plan:
`PLAN_GENEROS_CATALOGO_Y_RADIO_CRV.md`, etapa 3. La misma guía, resumida, está
al pie de la pestaña.

## Antes de decidir

- **Entra con tu cuenta de herra** (la misma de CRV Catálogo). Sin sesión puedes
  mirar todo; decidir requiere ser administrador del proyecto o superadministrador.
  Tu decisión queda firmada como `herra:<usuario>`: la Mesa no usa el nombre que
  escribas en la cabecera.
- **Escribe siempre el motivo.** Qué evidencia miraste y por qué. Queda en el
  historial de la ficha y en el diario de cambios.

## Principios

1. **Disco y artista son cosas distintas.** El género del artista describe su
   trayectoria; el del disco, ese disco. Una banda de rock puede tener un disco
   de baladas.
2. **El género del artista es contexto, nunca evidencia.** En la ficha de un disco
   aparece en un recuadro azul «Del artista, no del disco». No lo copies al disco.
3. **Las pistas heredan del disco, nunca del artista.** Confirmar el género de un
   artista no cambia ningún disco ni ninguna pista, ni lo que suena en cada
   estación de la radio.
4. **Sin evidencia, sin género.** «Sin clasificar» es un estado válido. Si ninguna
   fuente lo dice y no puedes citarlo, usa **Evidencia insuficiente**.
5. **No inventes precisión.** Si la fuente solo dice «Rock», el disco queda en la
   familia Rock; no lo bajes a «Hard rock».

## Ejemplos

| La fuente dice | Qué hacer |
|---|---|
| `Heavy/Thrash Metal` | Lista: Heavy metal principal, Thrash metal secundario (el primero manda). |
| `Pop-Rock`, `Rock-Pop` | Un solo término con guion: Pop rock. No se divide. |
| `Rock` | Familia Rock, principal. Es una asignación completa, no pendiente. |
| `Melodic Death Metal` | Death metal melódico; no lo reduzcas a Death metal. |
| `Independent`, `EP`, `Venezolano`, `Underground` | No son géneros (sello, formato, lugar, adjetivo). Rechaza la propuesta o marca evidencia insuficiente. |
| Una fuente `Jazz`, otra `Thrash Metal` | Desacuerdo: mira las dos evidencias y el disco; elige el principal o marca insuficiente. Nunca decide el rango de la fuente. |
| `Latin World/Rock` («Latin World» no existe) | Confirma Rock si es seguro; pide «Latin world» como término nuevo con su familia. No lo sustituyas por uno parecido. |
| Disco sin ningún texto de género | Déjalo sin clasificar o marca evidencia insuficiente. El género del artista no sirve. |

## Acciones

- **Confirmar principal / Elegir como principal**: fija el principal. El anterior
  pasa a secundario; nunca hay dos principales.
- **Agregar secundario**: añade un género sin tocar el principal.
- **Rechazar**: la propuesta queda rechazada y ninguna regla la reabre. Si una
  fuente nueva la vuelve a afirmar, aparece un aviso («contradice una decisión»).
- **Revertir**: borra tu decisión (queda en el historial) y la ficha vuelve a lo
  que digan las fuentes **hoy**, no a una foto antigua.
- **Solicitar término nuevo**: deja el caso para quien administra la taxonomía;
  el vocabulario solo cambia por CLI con aprobación.
- **Evidencia insuficiente**: la ficha queda sin clasificar y sale de la cola.
  **Reabrir** la devuelve.
- **Lote**: solo casos con exactamente el mismo texto de fuente. Ves la lista
  completa; si cambia mientras la miras, el servidor rechaza el lote.

## Sugerencias de fuentes externas (MusicBrainz y demás)

Desde la etapa 4 la cola puede traer propuestas de fuentes de fuera del
catálogo. Cambian poco tu trabajo, pero conviene saber tres cosas:

- **No son evidencia de CRV.** Una propuesta externa dice «allá esto figura
  así». Mírala junto a lo que dicen las fuentes del catálogo, la carátula y las
  pistas; si no hay con qué sostenerla aquí, recházala o marca evidencia
  insuficiente. Confirmarla es una decisión tuya, con tu motivo.
- **Mira primero la identidad.** La ficha muestra con qué entrada externa se
  emparejó, con qué puntaje y con qué señales (nombre, país, año, pistas…). Si
  la identidad no te convence, lo que traiga esa entrada no vale: esa es la
  causa más común de un género raro.
- **Los casos propios.** «Identidad dudosa» pide comprobar el emparejamiento;
  «una fuente externa discrepa» aparece cuando propone algo distinto de lo que
  CRV ya confirmó (tu decisión sigue vigente mientras no la cambies);
  «término externo sin equivalencia» se resuelve pidiendo un término nuevo o
  descartándolo.

Nada de esto se publica solo: una propuesta externa no entra en el catálogo ni
en la radio mientras nadie la confirme.

## Qué se publica y cuándo

- El catálogo muestra solo lo **confirmado** (`primaryGenre`, `genres`); un texto
  de fuente sin confirmar aparece marcado como pendiente y no entra en filtros.
- La Radio CRV lo recoge en la **siguiente anotación** (cada madrugada, tras la
  exportación de herra; o a mano con `npm run radio:genres`): cada canción lleva
  los géneros confirmados de su disco. Sin
  principal confirmado suena en la radio general, pero no en estaciones por género.
- Con `GENRES_PROJECTION_ENABLED=true`, `albums.genre` pasa a mostrar el nombre
  del principal confirmado en la misma decisión.
