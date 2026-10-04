# Hallazgo y reparación — fichas creadas desde filas «Appears On» (lote 1)

2026-10-04 · etapa 4 «Altas» · verificación posterior al lote 1. Reparado con runs reversibles;
**nada quedó pendiente en esta clase** (verificación al final).

## El mecanismo (causa raíz)

- Las páginas de artista de RYM mezclan en su vista de discografía filas propias
  (`Album`, `Single`, `Mixtape`…) con filas **`Appears On`** (créditos/apariciones: p. ej.
  los discos de **Apache** aparecen en la página de **Cuarto Poder** porque Apache es su
  integrante).
- El ledger de los 222 (`reports/rym-discos-fuera-2026-10-01.jsonl`, etapa 3) **no conservó
  la columna `ty`** de cada fila.
- La solicitud del lote 1 (`solicitud-lote.py` → `plan-lote1.jsonl`) generó items también
  para esas filas `Appears On`, con el artista de la página como padre.
- El motor creó las fichas bajo ese padre → **fichas con artista equivocado** (y, cuando el
  release ya existía en el catálogo para el artista real, duplicados).

## Víctimas (cruce de las 256 fichas creadas × capturas de página)

| ficha | título | creada bajo | fila de su padre | destino (ficha correcta) |
|---|---|---|---|---|
| 15474 | Sin afina' mucho | Cuarto Poder | `Appears On` | **3020** «Sin Afinar Mucho» (Apache) |
| 15475 | Afinando | Cuarto Poder | `Appears On` | **2753** «Afinando» (Apache, ya en catálogo desde 09-13) |
| 15450 | En vivo | C4 Trío | `Appears On` | **15549** «En vivo» (Movida Acústica Urbana) |
| 15498 | Tonada para Simón | Hana Kobayashi | `Appears On` | **15571** «Tonada para Simón» (Rodrigo Solo) |
| 15499 | No estás solo | Hana Kobayashi | `Appears On` | **316** «No Estás Solo» (Rodrigo Solo, ya en catálogo desde 09-11) |

Además, **2 duplicados de doble firma** (mismo release creado dos veces, una por cada
página donde consta como propio — legítimo en ambas): `15436` y `15627` («La energía»,
Vargas & Apache) y `15443` y `15610` («Tsee Mud... Bacro... LSD»). Regla aplicada: se
mantiene la **firma primera del slug del release** (15627 y 15610).

Nota: dos casos (15475, 15499) resultaron ser duplicados de fichas que **ya existían** —
el «fuera de catálogo» del ledger también tenía falsos negativos para filas mal-emparentadas.

## Reparación (runs reversibles)

- **run 11777** — 5 fusiones: 15474→3020, 15450→15549, 15498→15571, 15436→15627, 15443→15610.
- **run 11784** — 2 fusiones: 15475→2753, 15499→316.
- Camino sancionado: `mergeDuplicate` de `src/review/duplicates.ts` (el mismo de
  `crv review duplicates`), un `merge_run` propio por tanda, con `merge_audit` y
  `entity_redirects` (7 redirects) — deshacer por el diario 0028.
- Efecto colateral bueno: la review `album_match` 1819375 (bloqueada por la colisión de
  alias) se pudo aplicar — **run 11778**, careo de discos 40/40 cerrado; y el aviso
  `ambiguous_alias` 1825633 quedó cerrado con nota.

## Verificación final (2026-10-04)

`scripts/etapa4-altas-2026-10-03/verificar-filas-appears-on.py` (re-ejecutable):

```
creadas vivas del lote: 249 · víctimas «Appears On»: 0 · pares duplicados: 0
```

## Lecciones para el lote 2 / futuras altas

1. Al construir solicitudes desde el ledger de los 222, **excluir filas `ty == "Appears On"`**
   (el dato existe en las capturas; el ledger lo perdió — capturarlo al reconstruirlo).
2. El dossier-discos de «nuevos» **sí trae** `tipo_rym` (incluye «Appears On»): filtrarlo en
   la solicitud del lote 2.
3. El pre-chequeo del motor (padre correcto + título compacto) es la red que frenó varios de
   estos casos; con padres equivocados no puede actuar — por eso (1) es imprescindible.
4. Verificación repetible: correr `verificar-filas-appears-on.py` sobre cada apply nuevo
   (existe desde hoy).

## Objetos creados/afectados

- Scripts: `cerrar-careo-discos.mts`, `cerrar-alias-homonimos.mts`, `arreglar-appears-on.mts`,
  `verificar-filas-appears-on.py`.
- Salidas: `aplicacion-careo-discos.json`, `aplicacion-alias-homonimos.json`,
  `aplicacion-fix-appears-on.json`.
