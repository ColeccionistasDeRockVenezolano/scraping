# Biografías y reseñas: síntesis de todas las fuentes

Pedido de Brian (2026-09-27): completar o mejorar la biografía de **todas** las
fichas (artistas, personas, organizaciones) y la reseña de **todos** los discos
con todo lo que publican las fuentes del proyecto y las que se usaron para los
géneros. La síntesis la hace un subagente **Claude Sonnet 5 (esfuerzo medio)**
por lote; las biografías de Rock De Vzla que ya estaban se **enriquecen**, no se
reemplazan.

## Flujo

1. `tsx scripts/export-biography-catalog.mts > reports/biography-catalog-<fecha>.json`
   — catálogo entero (solo lectura).
2. `python3 scripts/harvest-biography-texts.py <catálogo> <fuente>` — un proceso
   por fuente, cada una con su caché en `data/raw/<fuente>-bio` y su libro en
   `reports/bio-texts/<fuente>.jsonl` (texto, URL, idioma, datos de ficha y
   prueba de identidad).
3. `tsx scripts/export-biography-dossiers.ts` — un expediente por ficha en
   lotes `reports/bio-dossiers/<tipo>-NNN.jsonl` (+ `manifest.json`).
4. Subagente Sonnet 5 por lote: lee el lote y esta guía y escribe
   `reports/bio-synth/<tipo>-NNN.jsonl`.
5. `tsx scripts/apply-biographies.ts` (ensayo) y `--confirm` — valida y escribe
   en el core dentro de un run propio, reversible por el diario de cambios.

## Fuentes

| Fuente | Qué aporta | Identidad |
|---|---|---|
| Rock De Vzla, Rockzuela, Hippito, RHV (blogspot), CRV (WordPress), Descargas Metal, El Punk, Rock Hecho | posts de origen (capturas locales) y biografías ya aceptadas | URL de origen aceptada en el catálogo |
| Canal de YouTube del proyecto | descripciones de los videos enlazados a cada disco | enlace video–disco del catálogo |
| Sincopa | ficha estructurada (formación, ciudad, miembros, sello) y prosa ocasional (en inglés) | URL de Sincopa aceptada como origen |
| Lobotoradio | ficha (tipo, origen, actividad, instrumentos, roles, miembros), biografía en español, reseña y créditos de discos, enlaces a otras fuentes | nombre exacto, sitio exclusivamente venezolano, sin homónimos; personas: la ficha nombra una banda o disco relacionado en el catálogo; discos: enlazados desde la ficha ya casada del artista |
| Last.fm (API) | biografía del artista y reseña del disco, en español y en inglés | nombre exacto + etiqueta venezolana, o Venezuela al abrir la biografía, o nombra un disco de la ficha; se descartan páginas de homónimos agrupados |
| Wikipedia (es/en) | extracto completo del artículo | título exacto o con desambiguador musical + categoría/entrada venezolana, o nombra algo relacionado, o enlazado desde Lobotoradio |
| La Venciclopedia | artículo completo | título exacto + artículo musical, o nombra algo relacionado, o enlazado desde Lobotoradio |
| Discogs (API) | perfil de artista y de sello, miembros, grupos, nombre real; notas, país, sello y créditos del lanzamiento | identidad ya confirmada por géneros, enlace de Lobotoradio, o nombre exacto con perfil que nombra Venezuela o algo relacionado |
| MusicBrainz | tipo, área, fechas de inicio/fin, miembros | nombre exacto + país Venezuela, candidato único |
| TheAudioDB | biografía ES/EN | nombre exacto + país venezolano, candidato único |
| Directorio RHV (rockhechovenezuela.com) | biografía completa | nombre exacto, sin homónimos (directorio solo de rock venezolano) |
| Vzla Rockea | posts de discografía y de disco | nombre/título exacto (blog solo venezolano) |

Sin biografías por las vías permitidas: **Deezer** (su API no tiene campo de
biografía), **Spotify** (su Web API no la da; ya se descartó para géneros el
2026-09-27) y **Bandcamp** (solo API de búsqueda; las páginas piden un desafío
anti-bot que no se evade). Metal Archives sigue sin tocarse (solicitud pendiente).

## Instrucciones para el subagente de síntesis

Cada línea del lote es un expediente JSON:
`{caseId, kind, entityId, name, catalog, currentText, sources:[{ref, source, url, lang, identity, text, facts?}]}`.
Escribe **una línea JSON por expediente, en el mismo orden**, en el archivo de salida:

```json
{"caseId":"artist:12","text":"…","sourcesUsed":["catalog","current","s1","s3"],"discarded":[{"ref":"s2","reason":"habla de una banda homónima de Chile"}],"note":null}
```

- `text`: la biografía (artista, persona, organización) o reseña (disco), en
  **español**, texto plano, párrafos separados por una línea en blanco (`\n\n`).
  Sin Markdown, sin títulos, sin viñetas, sin enlaces, sin citas entre corchetes.
- `sourcesUsed`: refs de las fuentes de las que tomaste algún dato; `catalog` si
  usaste datos del catálogo y `current` si partiste de la biografía actual.
- `discarded`: fuentes que no usaste porque hablan de otra entidad (homónimo),
  contradicen el catálogo o son ruido; con el motivo en una frase.
- `note`: dudas para revisión humana (contradicción no resuelta, identidad
  dudosa) o `null`.
- Si el expediente no tiene **ningún** dato aparte del nombre, `text: null` y
  `note: "sin datos"`.

### Reglas de contenido

1. **Solo hechos del expediente.** Nada de conocimiento propio: ni fechas, ni
   miembros, ni ciudades, ni valoraciones que no estén en `catalog`,
   `currentText` o `sources`. Si dudas, omite.
2. **Enriquecer, no perder.** Si hay `currentText`, conserva todos sus hechos
   (salvo que el catálogo o una fuente mejor los desmienta, o hablen de otra
   entidad: entonces anótalo en `note`) y súmale lo nuevo. Corrige ortografía,
   puntuación y redacción.
3. **Identidad.** Descarta la fuente que por país, época, género o miembros no
   encaja con el catálogo (p. ej. una banda homónima extranjera). Las fuentes
   venezolanas especializadas (Lobotoradio, directorio RHV, Sincopa, blogs del
   proyecto, La Venciclopedia) pesan más que las generales (Last.fm, TheAudioDB).
4. **Contradicciones.** Manda el catálogo; después la fuente venezolana
   especializada. Si no se puede resolver, omite el dato y anótalo en `note`.
5. **Traduce** al español lo que venga en inglés; no dejes frases en inglés
   (salvo títulos de canciones o discos).
6. **Tono enciclopédico**, tercera persona, sin adjetivos promocionales
   («legendaria», «increíble», «imperdible») salvo atribuidos a quien los dice
   («considerada por la crítica…» solo si la fuente lo dice). Convierte la
   primera persona de las bandas («nuestra música») a tercera.
7. **Ruido fuera:** enlaces de descarga, contraseñas, pedidos de comentarios,
   saludos del blog, listas de temas, tiempos y créditos completos. Se pueden
   nombrar productor, estudio o sencillos si las fuentes los destacan.
8. **Nada de metadatos en el texto:** no nombres «el catálogo», «el
   expediente», «la fuente» ni las fuentes concretas («según Sincopa»,
   «Last.fm dice»). Si dos fuentes discrepan en un dato (un año, la grafía de
   un nombre), usa el del catálogo sin comentarlo y deja la discrepancia en
   `note`. Solo se atribuye una opinión («considerado por la crítica…») cuando
   la fuente la atribuye.
9. **Nada de listas en prosa:** como mucho **3** temas nombrados (los que las
   fuentes destacan como sencillos o éxitos) y como mucho **5** personas en un
   párrafo de créditos; el resto se resume («y otros músicos invitados»).
10. **Longitud proporcional al material:** solo datos del catálogo → una o dos
   frases; material moderado → uno o dos párrafos; material rico → hasta cinco
   párrafos (≈450 palabras como máximo).

### Por tipo de ficha

- **Artista:** qué es (banda, solista, proyecto), género y ciudad/país de
  origen, formación, integrantes clave, trayectoria y discografía principal
  (en prosa y con años), hitos, separación o estado actual.
- **Disco (reseña):** qué es (tipo, año, sello, formato), lugar en la carrera
  del artista (una frase), estilo y sonido según las fuentes, músicos,
  productor o estudio destacados, sencillos o temas que las fuentes resalten,
  recepción si hay fuente. **No repitas la biografía del artista**: nada de su
  historia, nacimiento o bandas anteriores más allá de una frase de contexto.
- **Persona:** instrumentos y roles, bandas con años, créditos más relevantes
  (resumidos: «participó como bajista en tres discos de X»; como mucho seis
  bandas o discos nombrados), fechas de nacimiento o muerte **solo** si están
  en el expediente. **Nacionalidad** solo si `nacionalidad` la dice o una
  fuente la afirma: `venezolano: true` por sí solo no basta, porque el catálogo
  lo deduce de los créditos (un intérprete extranjero en un recopilatorio
  venezolano también lo tiene). Un crédito de composición, letra o arreglo es
  de un **tema**, no de la banda: «compuso temas grabados por X en el disco
  «Y»», nunca «es compositor de X». Los créditos son hechos pasados: «tocó»,
  «participó», «grabó», mejor que «es guitarrista de» si no consta que siga.
- **Organización:** tipo (sello, estudio, productora…), país si consta,
  artistas y discos que publicó o grabó (resumidos, con rango de años),
  personas vinculadas.

## Procedimiento del subagente

Cada subagente recibe una lista de lotes (p. ej. `album-003, album-004`) y los
procesa uno tras otro, por tramos de ~10 expedientes (~25 si son personas u
organizaciones con pocos datos), desde el directorio del proyecto:

1. Leer lo que falta: `python3 scripts/bio-batch-tool.py missing <lote> <cuántos>`
   (un lote puede venir a medias de un agente anterior: nunca rehagas lo ya
   escrito). `show <lote> <desde> <cuántos>` sirve para mirar por posición.
2. Redactar una línea JSON por expediente y guardarlas con un heredoc de
   comillas simples: `python3 scripts/bio-batch-tool.py append <lote> <<'JSONL'`
   … `JSONL`. Cada línea debe ser JSON válido; los párrafos van como `\n\n`
   dentro del string. Si `append` informa `ERROR`, corregir y reenviar.
3. Al acabar el lote, `python3 scripts/bio-batch-tool.py check <lote>` debe
   decir «completo»; si faltan, completarlos.
4. Respuesta final muy breve (máx. 4 líneas): lotes completos, cuántos
   `text: null`, problemas relevantes. Sin pegar textos.

Los directorios salen de `BIO_DOSSIERS_DIR` y `BIO_SYNTH_DIR` (por defecto
`reports/bio-dossiers` y `reports/bio-synth`); la segunda pasada usa otros.
