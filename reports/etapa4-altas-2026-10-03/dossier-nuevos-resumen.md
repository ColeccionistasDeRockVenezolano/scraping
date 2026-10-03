# Dossier de revisión — 1.591 artistas «nuevos» de RYM (etapa 4 «Altas» — preparación)

Generado: 2026-10-03 20:32 por `scripts/etapa4-altas-2026-10-03/dossier-nuevos.py` (solo lectura).
Regenerar en cualquier momento (≈1 min): `python3 scripts/etapa4-altas-2026-10-03/dossier-nuevos.py`

Fuentes por fila (columnas `fuente_cruce` y `fuente_evidencia`):

- **Cruce** contra el catálogo **vivo**: `public.artists` (3.779) · `public.persons` (35.361) ·
  `ingest.artist_aliases` / `ingest.person_aliases` (6.478 + 63.497 claves) ·
  `ingest.entity_redirects` (985 fusiones) · `public.albums` (10.095) — consultado por psql contra
  `crv-postgres` al generar este dossier.
- **Evidencia** capturada: `data/raw/fuentes-web-2026-10-01/rym-nuevos/pages/<slug>.json|.html`
  (página de artista de RYM, fase 1 completa: 1.591/1.591, capturadas el 02–03/10) + su
  `<meta name="description">` (formado/nacido/géneros).
- Clasificación previa de la etapa 2: `consolidado/rym-final/candidatos-clasificados.csv`.
- Snippet de la cosecha asistida: `consolidado/rym-final/nuevos.csv`.

Archivos: `dossier-nuevos.tsv` (1.591 filas × 33 columnas; `decision` y `nota_revisor` van vacías —
las llenas tú al revisar), `dossier-nuevos.jsonl` (misma data; la consumirá el motor de altas),
`dossier-nuevos-resumen.json` (conteos).

## Buckets (columna `accion_sugerida`)

| acción | n | significado | recomendación |
|---|---|---|---|
| `ya_ambos` | 96 | ya existe **artista Y persona** con ese nombre | NO alta; revisar posible duplicado interno |
| `ya_artista` | 39 | ya existe artista (exacto/compacto: «Chino y Nacho»=«Chino & Nacho») | NO alta; alias opcional |
| `ya_artista_alias` | 3 | ya existe artista vía alias | NO alta; alias ya enlaza |
| `ya_persona` | 216 | ya existe persona | NO alta |
| `ya_persona_alias` | 11 | ya existe persona vía alias («Ríal Guawankó»→Kenys Santiago) | NO alta |
| `revisar_homonimo` | 79 | nombre parecido (sim≥0,86) a ficha del catálogo: 18 vs artista / 69 vs persona / 8 ambos | revisar 1-a-1 antes de alta/alias |
| `alta_persona_miembro` | 55 | persona miembro de banda (31 [cat] + 24 [nuevo]) con evidencia | alta sugerida (**tú apruebas**) |
| `alta_artista_banda` | 222 | banda (formed 154 / miembros-con-instrumentos 195; 715 discos propios) | alta sugerida (**tú apruebas**) |
| `revisar_persona_solista` | 369 | persona con discografía/géneros (232 con «born»; 1.768 discos) — ¿solista o persona? | decidir tipo (artista `solo_artist` vs persona) |
| `revisar_persona` | 354 | persona sin evidencia musical (193 stub vacío); incluye no-musicales del barrido (cineastas, políticos, animadores) | triaje rápido: descartar / alta |
| `revisar_tipo` | 124 | acto musical (géneros/discos) sin señal banda/persona (ej. Lienzos, rip_sakura) | clasificar tipo |
| `cola_fria` | 23 | sin señales ni evidencia (stubs vacíos) | cola fría |

## Hallazgos medidos

1. **365 (23 %) ya están cubiertos por el catálogo** (ya_*): 216 persona · 39 artista · 96 ambos ·
   14 por alias. **485 de esos matches se crearon desde el 01-10** (135 artistas, 350 personas) por
   el workstream «Nuevo lote» (otra sesión) — sus claims llevan la fuente `lote-investigacion-2026-10-02`.
   → Este dossier es una foto viva: **re-correrlo justo antes de aplicar altas**; lo que esa sesión
   haga mientras tanto aparecerá como `ya_*` y no se duplicará (además el ER del motor frena duplicados).
2. **279 altas sugeridas con evidencia**: 222 bandas + 55 personas-miembro.
3. **869 para revisión**: 369 solistas potenciales, 354 personas (246 sin evidencia musical),
   124 sin tipo, 23 frías. Los no-musicales del barrido de localidades caen aquí.
4. **79 homónimos** a discriminar antes de tocar alias/altas.
5. **Evidencia capturada**: 712 con géneros · 437 sin discos · 1.059 con imagen (portada de relleno RYM)… **pero 0 retratos
   reales** (todas las imágenes de artista son portada de relleno de RYM, `photoEsCover=true`).
   La foto real de estos artistas requeriría una campaña de imágenes (patrón etapa 3) — no está capturada.
6. `discos_match_cat_n/ej`: títulos de disco coincidentes con OTRO artista del catálogo (ej. «Reflejos»);
   es aviso de homonimia de títulos, **no** duplicado por sí mismo.

## Incertidumbres explícitas

- «Member of» del snippet RYM a veces marca grupos (ej. «Prieto Gang»), no solo personas → los
  `alta_persona_miembro` necesitan tu ojo.
- «born»/«formed» sale del meta de la página; páginas sin ninguna de las dos señales quedan como
  `revisar_tipo`/`cola_fria` aunque sean actos reales (ej. Bear Bones, Lay Low con 36 discos).
- Los near-match (79) usan similitud ≥0,86; falsos positivos («Los Jets»≈«Los Pets») son esperables.

## Siguiente entregable

Cruce de discos (547 del ledger de los 222 + los de la fase 2 de «nuevos», que se completa al
terminar la extracción — no bloquea) y después el motor de altas en seco.
