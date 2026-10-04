# Motor de altas en seco — resumen (etapa 4 «Altas» — preparación)

Estado: **construido y aplicado (2026-10-04)**. Muestra de 16 (run 11722) y Lote 1 de 574
(runs 11726–11752) ejecutados, verificados y reversibles — ver `lote1-aplicado-resumen.md`
(522+16 fichas creadas; 49 `album_match` quedaron en cola). Este documento describe el motor.

## Piezas

- `scripts/etapa4-altas-2026-10-03/plan-altas.py` — convierte una **solicitud** de altas
  (`solicitud-muestra.json` es el formato) en `plan-altas.jsonl`: cada caso sale con sus
  `values`, su evidencia (URL RYM + extracto del meta/snippet + snapshot) y su padre, todo
  citado desde el dossier y la captura.
- `scripts/etapa4-altas-2026-10-03/altas-motor.mts` — **aplicador/revisor**:
  - **sin `--confirm` (EN SECO)**: (1) pre-chequeos de solo lectura (¿ya existe? guardas de
    nombre de persona: `classifyPersonName`, colisión con banda, duplicado compacto; duplicado
    de disco) y (2) **sonda ER**: repite las altas dentro de una transacción que se revierte al
    final (patrón `probe-er-person.ts` del proyecto) y dice qué crearía, qué ya existe y qué
    quedaría en cola, con score. Informe JSON por corrida.
  - **con `--confirm`**: aplica por lotes en **runs reversibles** (diario 0028; deshacer con
    `crv runs undo <id>` o desde el Historial), savepoint por entidad, guardas ER
    (needs_review con score<0,66 → `allowSimilar`; ≥0,66 → cola), **claim + evidencia por campo**
    (fuente `rateyourmusic`, extractor `captura-rym-nuevos`, snapshot citado) y auditoría del operador.

## Comandos

```
# 1) generar el plan desde una solicitud
python3 scripts/etapa4-altas-2026-10-03/plan-altas.py <solicitud.json> [salida.jsonl]

# 2) revisar EN SECO (cero escrituras)
./scripts/with-node22.sh node_modules/.bin/tsx scripts/etapa4-altas-2026-10-03/altas-motor.mts \
  --plan=reports/etapa4-altas-2026-10-03/plan-altas.jsonl            # [--sin-er] para omitir la sonda

# 3) aplicar SOLO con el OK de Brian (run reversible por lotes)
... altas-motor.mts --plan=... --confirm [--batch=200]
```

## Prueba en seco — muestra de 16 casos (pendiente de tu OK)

Propuesta en `solicitud-muestra.json` (su `plan-altas.jsonl` ya generado): **5 bandas**
(Serenada, Orquesta La Tremenda, Los Imperial's, La Danta Más Cabra, Anakena) + **5 personas
miembro** (Marianne Malí→Mochuelo, Ava Casas→Americania, Akilin→Bituaya, José Rosario→Sonero
Clásico del Caribe, Underaiki→Goat on Sale) + **6 discos** (2 del ledger de los 222:
La Puta Eléctrica «Automatron» y «A gogo maldito»; 4 de las bandas: primer álbum de Los
Imperial's, Serenada, Orquesta La Tremenda y La Danta).

Resultado de la sonda ER (`altas-dry-run-202610032340.json`):

- **10 crearían directo + 6 con `allowSimilar`** (scores 0,52–0,55, por debajo del umbral 0,66
  que exige revisión; es el comportamiento sancionado del proyecto) — **0 errores, 0 avisos**.
- La sonda estima ids provisionales (#4510+, #39864+, #15353+): solo orientativos, la secuencia
  no se revierte.

Verificación de «cero escrituras» tras la sonda (consultas a la BD viva):

| comprobación | resultado |
|---|---|
| runs `altas-er-sonda` en `ingest.scrape_runs` | 0 |
| claims `rym-nuevos:%` | 0 |
| fichas de la muestra en artists/persons/albums | 0 |
| decisiones ER nuevas de esos nombres | 0 |
| ids provisionales (4510, 39864, 15353) | 0 |

## Cómo se aplicaría (cuando des el OK) y cómo se deshace

- El `--confirm` sobre esta misma muestra es **el rodaje real del motor** (16 fichas + claims).
- El run queda en el Historial; deshacer: `npm run cli -- runs undo <id>` (o
  `POST /changes/:runId/undo`), que revierte fichas y claims por el diario.
- Si la otra sesión crea alguna de estas fichas antes, el motor lo detecta (ER `ya_existe`) y
  **no duplica**: lo deja listado en el informe.

## Lo que el motor aún NO hace (fases siguientes, a decidir)

- Portadas/fotos reales (la captura de «nuevos» solo tiene portada de relleno RYM;
  `photoEsCover=true`), tracklists, bandas sonoras de duplicados, vínculos de membresía
  (persona↔banda) y géneros (van por el flujo del vocabulario, no por este motor).

## Incertidumbre explícita

- El camino `--confirm` comparte toda su construcción con la sonda (mismo `createEntity`,
  mismos claims) y con el patrón de la etapa 1, pero **no se ha ejecutado contra la BD**:
  por diseño, la primera escritura será la que autorices.
- La muestra es una foto: si el catálogo cambia antes de aplicar, la sonda se repite y dirá
  la verdad del momento.
