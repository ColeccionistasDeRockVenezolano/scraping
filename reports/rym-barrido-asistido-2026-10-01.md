# RYM — barrido asistido (navegación humana) + cruce con catálogo (2026-10-01)

Contexto: rateyourmusic.com bloquea automatización (robots `Disallow: /` + hCaptcha tras ~40
páginas de un crawler). La vía usada fue navegación **humana** de Brian en Firefox controlado
por Marionette **en modo solo-lectura**: el cosechador (`/tmp/crv-recon/rym-harvest2.py`) nunca
navega, solo lee el DOM de las pestañas que Brian abre. El captcha lo resolvió Brian a mano.
Tablero local (`/tmp/crv-recon/rym-dashboard.html`, autorrefresco 8 s) con un clic por página:
nombre de ciudad → siguiente página pendiente; ✓ verde al capturarse.

## Cosecha

- **549 páginas** únicas cargadas y capturadas (25.210 filas de artista), **145 vistas de
  ubicación**, **2.472 artistas únicos** (clave = URL `/artist/…`).
- Cada fila trae snippet de detalle: `Born…/Died…/Members…` (p.ej. "Born12 March 1928,
  Valencia, Carabobo, VenezuelaDied15 September 2007 // Caracas").
- Unión con el crawl automático pre-bloqueo (Barbacoas 1.288): **no aporta nada nuevo** — el
  barrido asistido lo contiene (1.288 ⊆ 1.618) y lo supera (+330).
- Archivos:
  - `data/raw/fuentes-web-2026-10-01/pages/rym/asistido/` — 549 HTML + `artistas-asistido.jsonl`.
  - `data/raw/fuentes-web-2026-10-01/consolidado/rym-final/` — `rym-artistas.jsonl`,
    `cruce.csv`, `nuevos.csv`.

### Hallazgo: alias regionales ("artists near X")

RYM resuelve las localidades sin artistas como "artistas **cerca de** X" → **muchas ciudades
devuelven el mismo pool regional**. Verificado por href (no por nombre):

| Vista | artistas | nota |
|---|---|---|
| Villa de Cura, Zamora | 1.626 | pool Caracas |
| Barbacoas, Aragua | 1.618 | pool Caracas |
| Caracas, Distrito Capital | 1.617 | **Caracas ⊆ Barbacoas** (1.617/1.617) |
| Chacao, Miranda | 1.588 | pool Caracas |
| Caucagua, Miranda | 1.431 | pool Caracas |
| Charallave, Miranda | 1.029 | pool Caracas |

- Caracas y Barbacoas listan el MISMO conjunto, pero **con otro orden de paginación** (p.1 de
  una vs p.1 de la otra comparten ~3 nombres de 50) → capturar varias vistas del pool fue
  útil para completar la unión, aunque redundante en clics.
- Ciudades que **sí aportan** artistas distintos: Valencia 860, Guacara 373, Tinaquillo/Macapo
  346, San Felipe 343, Chichiriviche 331, La Victoria 239, Maracaibo 202, San Cristóbal 198,
  Coro 166, Cumaná 127, Punto Fijo 103, Mérida 97, Puerto Ordaz 44, Maturín 53, Tucupita 63…
- Variantes duplicadas por encoding/estado (Falcon/Falcón, Anzoategui/Anzoátegui,
  Merida/Mérida, Tachira/Táchira, Ciudad Bolívar ×3 estados) → listas idénticas.

## Cruce contra el catálogo (2.801 fichas de artista · 11.728 personas al corte)

| bucket | n | nota |
|---|---|---|
| Ficha de artista, nombre exacto | **617** | 226 sin foto · 21 sin bio |
| Ficha de artista vía alias | **17** | alias del catálogo (2.776) |
| Existe como **persona** (sin ficha) | **247** | 191 con fecha de nacimiento parseable · 45 con fallecimiento |
| Fuera del catálogo | **1.591** | candidatos (ver abajo) |

## Enriquecimiento viable (para la fase de escritura)

1. **Personas (247)**: `birth_date`/`death_date`/`birth_city` parseables del snippet RYM —
   191 nacimientos + 45 fallecimientos en formato consistente ("Born12 March 1928, Valencia,
   Carabobo, VenezuelaDied15 September 2007 // Caracas"). Añadir claim + evidencia (URL RYM).
2. **Fichas existentes (634)**: anclaje de identidad (URL RYM como source/evidencia). RYM **no
   aporta fotos** ni biografías → los huecos de foto/bio se cubren por las otras fuentes.
3. **Nuevos (1.591)**: **no crear fichas vacías**. La lista mezcla todos los géneros
   (orquestas, clásicos, folclor — incluso Hugo Chávez, Román Chalbaud, Oswaldo Vigas, que no
   son rock) y RYM solo aporta nombre + URL + fechas. Solo 3 de los 1.591 tienen datos ricos en
   las otras fuentes (Cuásar, Van Der Dijs, Pulpo — ya en el plan de 12 nuevos). El resto queda
   como **cola de candidatos** (`nuevos.csv`), pendiente de (a) pase near-miss contra el
   catálogo, (b) filtro de género/alcance, (c) enriquecimiento por otras fuentes.

## Pendiente (fase de escritura, requiere GO explícito)

- Aplicar como runs reversibles (`withOperatorRun` + claim/evidence): fechas de personas (191+45),
  sources RYM para las 634 fichas, fotos/bio de las otras fuentes (8 fotos verificadas + bio
  Caramelos de Cianuro), 12 artistas nuevos, 95 discos, 15 personas.
- Los 30 casi-duplicados de disco siguen fuera, a revisión manual.
