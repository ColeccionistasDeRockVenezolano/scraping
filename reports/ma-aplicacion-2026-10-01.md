# Aplicación Metal Archives → catálogo CRV (COMPLETA)

Fecha: 2026-10-01 · Fuente: captura manual MA-VE (`data/raw/metal-archives-ve-2026-10-01/`:
611 bandas, 1.824 discos, 11.409 pistas, 3.017 personas; todas las imágenes en disco).
Respaldo previo: `/mnt/datos/backups/crv/crv-pre-ma-apply-20261001.dump` (145 MB, PGDMP, sha256).

## Resultado por etapa

| Etapa | Resultado | Runs |
|---|---|---|
| E0 respaldo | dump 145 MB verificado | — |
| E1 campos de banda | 1.152 campos en 410 fichas (status 413 · temas 258 · años activos 383 · ubicación 54 · bio 4 · disolución 33 · formación 7) — 0 errores | 10757-10760 |
| E2 campos de persona | 1.638 campos en 583 personas — 0 errores | 10761-10764 |
| E2 altas de persona | 1.888 creadas — 0 errores; 40 a cola (variantes cercanas) | ~10765-10794 |
| E3 membresías | 2.382 creadas · 117 ya estaban · 9 review (período contradictorio) — 0 errores | 10795-10805 |
| E4 discos: campos | 1.644 campos (fecha literal 688 · formato 688 · tipo 111 · catálogo 135 · notas 22) | 10778-10782 |
| E4 discos: sellos | 99 organizaciones creadas · 189 discos con sello · 14 orgs en review | 10776-77, 10783 |
| E5 duraciones | 1.529 aplicadas (9 ya) — 0 errores | 10806-10813 |
| E5 pistas ausentes | 277 creadas; 432 posiciones ocupadas → `tracks-bloqueadas-posicion.jsonl` | 10815-10819 |
| E6 fichas nuevas | 181 bandas (+13 alias) · 391 discos · 1.999 pistas · 718 membresías · 511 créditos · 73 sellos (36 orgs) · 1.097 imágenes — 0 errores | 10820-10856 |
| E7 géneros | 595 claims crudos; backfill: +504 asignaciones · ~75 actualizadas · +260 avisos | 10857-10862 |

## Estado del catálogo (antes → después)

- artists **2.622 → 2.803** · persons **9.841 → 11.729** · albums **4.562 → 4.953** ·
  tracks **38.030 → 40.306** · artist_members **≈1.520 → 4.620** ·
  album_credits **≈19.110 → 19.621** · organizations **≈839 → 974**.
- Claims de fuente `metal-archives` con URL+evidencia: person 10.317 · track 5.441 ·
  album 4.382 · artist 4.236 · membership 3.100 · album_credit 511 · organization 99.

## Pendientes (con default recomendado)

1. **40 personas + 115 variantes cercanas** → cola de revisión del ER (triaje normal).
2. **14 orgs E4 + 4 orgs E6 en review** (sellos con nombre similar a orgs existentes).
3. **4 bandas «a revisar»** (Xtremauncion/Living Death/Sorte/Nocturna) — no creadas.
4. **192 pistas bloqueadas por posición** (tracklists MA ≠ orden de otras fuentes) —
   informe; default: dejarlas, curación manual futura si interesa.
5. **260 avisos de género** abiertos — lista de trabajo en `reports/genres-backfill-confirm.md`.
6. **323 personas sin ficha** en membresías/créditos pendientes — dependen de 1/3.

## Evidencia

- Reportes por fase: `reports/apply-ma-*.json` · alias: `reports/ma-alias-bandas-2026-10-01.md` ·
  géneros: `reports/genres-backfill-{dry-run,confirm}.{json,md}`.
- Dataset durable: `data/raw/metal-archives-ve-2026-10-01/` (`aplicacion/` = reportes y mapas;
  `scripts/` = generadores y aplicadores; `consolidado/` = ledgers).
- Cada campo/alta/relación escrita dejó claim de fuente + evidencia + run reversible del operador.

## Lecciones (skill `crv-coleccionistas` → `references/ma-aplicacion-campana.md`)

- **El ER carga la tabla completa por alta** (pistas 38k / álbumes 4.9k con tracklist) —
  para altas masivas de pistas/álbumes: `allowSimilar:true` (vía `humanDifferentDecision`,
  documentada en engine.ts:547-551) + guarda barata de duplicado dentro de su padre.
- **Pitfall de claims**: no reutilizar el mismo `$n` para `field` (varchar) y `to_jsonb($n::int)`.
- **Géneros**: claim crudo + `genres backfill` — `resolveGenreValue` ya corta listas y
  sufijos compartidos; desconocidos → cola de revisión (no escribir asignaciones a mano).
- **Imágenes E6**: copia a `web/public/media/` + `/crv/media/…` solo si el campo está vacío;
  auditoría = `imagenes.csv` + claims.
