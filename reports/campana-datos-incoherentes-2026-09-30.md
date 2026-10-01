# Campaña «datos incoherentes» + cola de revisión — informe 2026-09-30

**Resultado: 508 hallazgos `datos_incoherentes` abiertos → 0 · cola de revisión → 0**
Scan final 467: 0 nuevos / 0 resueltos / 0 encadenados (estable). Sin reabiertos.

## Duraciones (453 hallazgos)

- `duracion_atipica` (93): verificación pista a pista contra Deezer/iTunes
  (`tmp-analysis/campana-datos-2026-09-30/check-dur-atipica.py`). 56 confirmadas y 34 sin
  dato cerradas con la cita de su fuente (claims: Deezer / segmento de video / sincopa /
  operador); **1 corregida**: «Vanessa» (Frank Quintero) 5 s → 201 s (run 10598; Deezer traía
  un fragmento de 5 s, Apple el máster de 3:21 del mismo disco). 7 atípicas nuevas generadas
  por los rellenos cerradas con su cita de tienda.
- `pistas_sin_duracion_en_disco_con_duraciones` (360 discos / 906 pistas): tres cosechas —
  páginas fuente (8), tiendas pase 2 con alineación por anclas (307 Deezer + 55 iTunes),
  Discogs API (78) — **448 pistas rellenadas** (run 10609, claim+evidencia+auditoría por
  pista; 13 trackIds con conflicto >3 s descartados por seguridad, 86 rellenos posicionales
  débiles filtrados). Las 458 pistas restantes se cierran `fuera_de_alcance` con nota
  (163 hallazgos): ninguna fuente autorizada las publica de forma inequívoca.

## Tipos de disco (55 hallazgos)

- 7 tipos fijados con evidencia (runs 10599–10605): recopilatorios «De Colección»
  (1238, 4245, 4253, 4265), aniversarios (2134), en vivo (1977, 3456).
- 49 cerrados como falso positivo del detector (palabra del título incidental: país,
  «grandes», «mejor», años, edición…).

## Cola de revisión (145 avisos)

- **143 `person_duplicate` → 138 fusiones** (run 10594) por evidencia por par
  (`reports/person-duplicates-evidence-2026-09-30.md`); plan auditado en
  `docs/decisions/2026-09-30-duplicados-personas-por-evidencia.json`. Erratas de apellido,
  apodos/hipocorísticos y alias cruzado; grafía descartada queda como alias; reversible.
- `ambiguous_alias` «MF* Radio» descartado (ficha ya fusionada; run 10595) y `genre_unknown`
  de la fusión de «The Witch» resuelto: Pop principal, Rock secundario (run 10596).
- 12 restos de grafía literal (otros/nombres_sucios/mal_segmentados) cerrados con la cita
  del post de origen.

## Géneros

- Pase Last.fm sobre los pendientes frescos (481 artistas casados, 76 con géneros):
  **0 contradicciones con Laya, 28 compatibles** — nada nuevo que aplicar (fuentes
  saturadas). Pendientes: 1.408 discos / 898 artistas con Laya o sin principal; sin
  NINGÚN principal: 391 artistas / 572 discos (cola larga sin cobertura en fuentes
  autorizadas).

## Artefactos

- Toolkit reanudable: `tmp-analysis/campana-datos-2026-09-30/` (archivado en la skill
  `crv-coleccionistas/scripts/campana-datos-2026-09-30/`).
- Receta y pitfalls: `references/campana-datos-incoherentes.md` de la skill.
- Reportes: `reports/apply-dur-fuentes-confirm-run10609.json`,
  `reports/person-duplicates-evidence-2026-09-30.{json,md}`.
- Nota: los scripts/informes viven fuera del control de versiones excepto los reportes;
  no se hizo commit en esta campaña (árbol compartido con otra sesión activa).
