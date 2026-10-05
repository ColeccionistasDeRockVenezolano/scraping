# Curaduría a cero — 2026-10-05

Objetivo: llevar a 0 los hallazgos de curaduría, los conflictos de campo y la cola de revisión, sin tocar portadas ni fotos.

## Estado final (análisis 762)

| Qué | Abiertos |
|---|---|
| Hallazgos de curaduría (`ingest.curation_findings`) | 0 (0 nuevos, 0 reabiertos) |
| Conflictos de campo (`ingest.conflicts`) | 0 |
| Cola de revisión (`ingest.review_queue`) | 0 |
| Portadas y fotos (`ingest.image_candidates`) | 74, **sin tocar** (las revisa Brian) |

Los 4.311 hallazgos que el detector sigue viendo están ignorados con motivo: 3.021 `correcto_a_proposito`, 1.204 `fuera_de_alcance` y 86 `falso_positivo`.

## Runs

Son 3.282 runs correctos entre el 13400 y el 16828; todos llevan una nota que empieza por «Curaduría 2026-10-05» y se deshacen con `runs undo <id>`.

| Acción | Runs | Primero | Último |
|---|---:|---:|---:|
| `review:resolve-conflict` | 1638 | 13402 | 15049 |
| `api:curation:fix:retirar_huerfana` | 522 | 15128 | 15654 |
| `review:reject` | 353 | 14880 | 16768 |
| `api:curation:fix:fijar_tipo_de_disco` | 128 | 16286 | 16413 |
| `api:curation:fix:extraer_interprete` | 122 | 15949 | 16692 |
| `api:curation:fix:convertir_en_organizacion_existente` | 88 | 15746 | 15871 |
| `api:curation:fix:quitar_prefijo_artista` | 85 | 15953 | 16205 |
| `api:curation:fix:extraer_interprete_creando` | 58 | 15950 | 16689 |
| `api:curation:fix:convertir_creando_organizacion` | 45 | 15745 | 15881 |
| `api:curation:fix:dividir_persona` | 33 | 15890 | 15926 |
| `api:curation:fix:vincular_como_miembro` | 26 | 16792 | 16817 |
| `api:curation:fix:convertir_en_artista` | 18 | 16774 | 16791 |
| `curation:person-to-organization` | 16 | 15929 | 16824 |
| `curation:add-track-credits` | 14 | 16419 | 16729 |
| `curation:persons-ops` | 12 | 15873 | 16756 |
| `curation:rename-track` | 10 | 16282 | 16736 |
| `curation:merge-person` | 10 | 15875 | 16820 |
| `genre_decision` | 9 | 14801 | 16823 |
| `curation:rename-artist` | 8 | 15935 | 16769 |
| `curation:rename-organization` | 6 | 15934 | 16758 |
| `curation:rebuild-sincopa-order` | 6 | 15102 | 15120 |
| `curation:merge-discography-twins` | 5 | 15635 | 16677 |
| `curation:merge-artist` | 5 | 16633 | 16770 |
| `curation:merge-organization` | 5 | 15874 | 16757 |
| `curation:remove-relations` | 5 | 16634 | 16750 |
| `curation:rename-album` | 4 | 15948 | 16744 |
| `curation:merge-albums` | 3 | 16737 | 16771 |
| `api:curation:fix:extraer_autores` | 3 | 16416 | 16418 |
| `curation:split-flattened-discs` | 2 | 15122 | 15123 |
| `curation:la-24` | 1 | 16697 | 16697 |
| `curation:last-title-conflicts` | 1 | 15050 | 15050 |
| `curation:ma-orphan-members` | 1 | 14504 | 14504 |
| `curation:manual-flattened-discs` | 1 | 15124 | 15124 |
| `curation:manual-split-composers` | 1 | 16629 | 16629 |
| `curation:membership-open-periods` | 1 | 16825 | 16825 |
| `curation:membresias-periodo` | 1 | 16818 | 16818 |
| `curation:merge-balzehaguaos` | 1 | 15051 | 15051 |
| `curation:merge-betsayda` | 1 | 15099 | 15099 |
| `curation:disc2-compilations` | 1 | 15111 | 15111 |
| `curation:nemesis-lara` | 1 | 16819 | 16819 |
| `curation:nemesis-lara-claims` | 1 | 16828 | 16828 |
| `curation:organization-to-artist` | 1 | 16724 | 16724 |
| `curation:pending-composer-credits` | 1 | 15127 | 15127 |
| `curation:curation:duration-fix` | 1 | 16414 | 16414 |
| `curation:channel-order` | 1 | 15109 | 15109 |
| `curation:cazadores-credits` | 1 | 15119 | 15119 |
| `curation:aliases-split-occurrences` | 1 | 15126 | 15126 |
| `curation:alias-the-vnote` | 1 | 16821 | 16821 |
| `curation:repeated-versions` | 1 | 15125 | 15125 |
| `curation:restore-channel-order` | 1 | 15108 | 15108 |
| `curation:restore-youtube-durations` | 1 | 15105 | 15105 |
| `curation:rol-contra-tipo` | 1 | 16749 | 16749 |
| `curation:roles-compuestos` | 1 | 16751 | 16751 |
| `curation:short-titles` | 1 | 15112 | 15112 |
| `curation:split-homonym-artists` | 1 | 16738 | 16738 |
| `curation:split-jihad` | 1 | 16741 | 16741 |
| `curation:split-labels` | 1 | 13401 | 13401 |
| `curation:split-moises-pena` | 1 | 15097 | 15097 |
| `curation:split-repeated-tracks` | 1 | 13400 | 13400 |
| `curation:split-tonadas-favoritas` | 1 | 15115 | 15115 |
| `curation:stale-durations` | 1 | 15101 | 15101 |
| `curation:album-pairs` | 1 | 15638 | 15638 |
| `curation:album-labels-from-sincopa` | 1 | 14411 | 14411 |
| `curation:durations-mb-deezer` | 1 | 15657 | 15657 |
| `curation:durations-deezer` | 1 | 15655 | 15655 |
| `curation:durations-metal-archives` | 1 | 15656 | 15656 |
| `curation:external-tracklists` | 1 | 15660 | 15660 |
| `curation:extract-guests` | 1 | 16415 | 16415 |
| `curation:fix-carlos-morean` | 1 | 15103 | 15103 |
| `curation:fix-carlos-morean-credit` | 1 | 15104 | 15104 |
| `curation:fix-puma-en-ritmo` | 1 | 15036 | 15036 |
| `curation:gap-albums-manual` | 1 | 15121 | 15121 |

## Decisiones de criterio

- **Reglas de verdad:** el canal de YouTube y la hoja mandan. Basta una fuente para fijar un género. Dos personas solo se fusionan si comparten un proyecto; los homónimos sin proyecto común quedan como `falso_positivo`.
- **Membresías según Metal Archives** (runs 16818 y 16825):
  - Un periodo «present» deja al miembro como actual.
  - Un periodo con año de cierre deja de ser actual.
  - Un periodo «año-?» en una banda separada o de estado desconocido (Kraptor, Secta Canibal) deja de ser actual, con el año de fin en NULL.
- **Nemesis:** la Nemesis de Barquisimeto (1988–1996 y desde 2024, thrash) pasó a «Nemesis (Lara)» (1287) con su alineación, su bio, sus claims de MA y Rock De Vzla y sus alias (runs 16819 y 16828). La ficha 590 quedó para la Nemesis de Caracas (1999, heavy metal épico).
- **Demo de Nemesis (Caracas):** se queda en 2002. Lo dicen el blog Descargas Metal Venezolano y un video de YouTube («Demo Nemesis 2002 - Caracas»); solo MA dice 2000, y el nombre de la banda es de octubre de 2000.
- **Organizaciones:** los estudios, bancos e instalaciones que estaban cargados como personas pasaron a ser organizaciones.

## Trampas

- Descartar revisiones `person_match` crea personas duplicadas (se repararon en el run 16617). Las de `ambiguous_alias` sí se pueden descartar.
- Los créditos se borran con `removeRelation`, no con SQL: el SQL choca con la FK de `merge_audit_claims`.
- El fix `corregir_unidades` está mal y `extraer_invitado` mete a varios invitados en una sola persona; no se usaron a ciegas.
- `ingest.artist_genres` exige `superseded_by_id` cuando el estado es `superseded`; para descartar una fila sin reemplazo, se pone `rejected` con `decision_kind='human'`.

## Archivos

- Scripts: `scripts/curaduria-2026-10-05-*.ts`. El ejecutor de SQL dentro de un run es `scripts/curaduria-2026-10-05-sql-run.ts`.
- SQL puntuales: `reports/curaduria-2026-10-05/sql/`.
- Ensayos, planes y resultados: `reports/curaduria-2026-10-05/*.json`.
