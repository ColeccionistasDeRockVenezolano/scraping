# Cruce de discos — dossier revisable (etapa 4 «Altas» — preparación)

Generado: 2026-10-03 20:34 por `scripts/etapa4-altas-2026-10-03/dossier-discos.py` (solo lectura).
Regenerar (≈2 s; **re-ejecutar cuando termine la fase 2 de «nuevos»**):
`python3 scripts/etapa4-altas-2026-10-03/dossier-discos.py`

Archivos: `dossier-discos.tsv` / `dossier-discos.jsonl` (fila a fila, `decision`/`nota_revisor` vacías
para ti) / `dossier-discos-resumen.json`. Cada fila cita: ledger o página de discografía +
ficha de disco capturada + consulta viva a `public.albums/artists`.

## Sección «222» — los 547 fuera de catálogo (campaña de los 222)

| estado | n | nota |
|---|---|---|
| `fuera` | 504 | siguen fuera del catálogo (insumo de altas) |
| `ya_en_catalogo` | 43 | entraron desde el 01-10 (los creó el workstream paralelo el 02–03/10) |

- **547/547 con ficha de disco capturada** (`rym-etapa3/pages/rel_*.json`: pistas, géneros, portada, créditos).
- **352 de 547 traían el año mal en el ledger** («Released» mal parseado: 8312, 3540, 1067…). El dossier usa
  el año de la fila de la discografía RYM (columna `anio`, con la nota del discrepancy en `anio_nota`).
- **75 filas con colisión de título** con álbumes de OTROS artistas del catálogo (`colision_titulo`) — aviso
  de homonimia, no duplicado por sí mismo.
- 1 artista del ledger fue fusionado (Triangular Ascension 835 → Zardonic 795; sus 14 discos se muestran
  resueltos al destino).
- Tipos: Album 125 · Single 122 · Appears On 100 · V/A Comp 81 · EP 77 · DJ Mix 16 · Video 8 · Live 7 · Comp 4 · Mixtape 3.
  («Appears On» / «V/A Compilation» / «Video» **no** son discos propios del artista.)

## Sección «nuevos» — discos listados por los 1.591 (fase 2 en marcha)

| estado | n | nota |
|---|---|---|
| `artista_fuera` | 6.665 | artista aún fuera del catálogo (lo esperado: se crea en la etapa 4) |
| `ya_en_catalogo` | 604 | de los 135 artistas «nuevos» que la otra sesión ya creó (su disco ya existe) |
| `fuera` | 895 | de esos mismos artistas ya creados, discos que faltan |

- **8.164 filas** (títulos listados en las discografías; 354 artistas no listan ningún disco).
- Propias: **5.868** (Album 2.338 · Single 2.407 · EP 617 · Compilation 170 · Live 83 · DJ Mix 110 · Mixtape 61)
  · No propias: 2.296 (Appears On, V/A Compilation, Music video) → la columna `anio_nota` marca «no propio».
- **Captura fase 2: 123 fichas de disco** (de las ~7.255 en cola) — completar re-ejecutando este script al
  terminar la extracción; no bloquea nada.
- **135 artistas de los 1.591 ya están creados** por el workstream «Nuevo lote» (claims de
  `lote-investigacion-2026-10-02`): 604 discos ya están y 895 quedan fuera/revisión (mirar `tipo_rym`).
- **679 colisiones de título** (mismo aviso de homonimia que en A).

## Incertidumbres explicitas

- El match de disco usa título compacto (igual/prefix con ≥6 letras, la misma regla del ledger): puede
  marcar dos obras distintas como «ya» (revisar `ya_album` antes de decidir) o dejar pasar variantes raras.
- Foto viva: 43/604 pueden subir porque la otra sesión sigue creando discos; re-ejecutar antes de aplicar.
- El año de la fila RYM es la referencia razonable, pero RYM edita años retroactivamente: casos dudosos
  quedan con nota en `anio_nota`.

Siguiente: motor de altas en seco (dry-run) + muestra de 10–20 casos para tu OK.
