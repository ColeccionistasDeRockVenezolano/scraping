# Clasificador de nombres de persona — dry-run (E11.7)

Sonda de **solo lectura** contra la base de desarrollo (`127.0.0.1:5433/crv`):
`./scripts/with-node22.sh node_modules/.bin/tsx scripts/probes/person-junk-dryrun.mts`.
Es el mismo módulo que usan la API (aviso de la ficha y filtro `suspect` del
listado) y el plan de correcciones (`src/review/person-junk.ts`), así que estos
son los números que verá el propietario.

## Conteos

| clase | fichas | plan (§1.2) | desvío |
| --- | ---: | ---: | ---: |
| `ok` (nombre de persona) | 9628 | — | — |
| `organization_like` | 488 | 477 | +2,3 % |
| `duration` | 22 | 22 | 0 % |
| `fragment` | 13 | — | — |
| `multiple_people` | 97 | — | — |
| **total** | **10248** | | |

El desvío de `organization_like` (+2,3 %) queda dentro del 15 % que admite el
plan: la lista de palabras añade `producciones`, `mastering` y `films` al regex
de §1.2 (estudios que ya estaban en el catálogo con otro nombre), y hay nombres
artísticos que contienen `studio`/`records`.

## Muestras

### `organization_like` — palabra de estudio, sello o productora
| id | nombre | motivo |
| --- | --- | --- |
| 8403 | «199 Studios» | contiene una palabra de estudio, sello o productora |
| 5755 | «311 Studio» | contiene una palabra de estudio, sello o productora |
| 7936 | «360 Mastering» | contiene una palabra de estudio, sello o productora |
| 7533 | «880 Studios» | contiene una palabra de estudio, sello o productora |
| 4639 | «ACL Studios» | contiene una palabra de estudio, sello o productora |
| 4950 | «ADP Record Dogma Infinito Studio» | contiene una palabra de estudio, sello o productora |
| 3815 | «AGP Estudios» | contiene una palabra de estudio, sello o productora |
| 8701 | «AJM Sound Studios» | contiene una palabra de estudio, sello o productora |

### `duration` — solo números o marcas de tiempo
| id | nombre | motivo |
| --- | --- | --- |
| 6250 | «(66)» | solo números o marcas de tiempo |
| 6248 | «(67)» | solo números o marcas de tiempo |
| 6999 | «2:05» | solo números o marcas de tiempo |
| 6996 | «3:03» | solo números o marcas de tiempo |
| 6997 | «3:10» | solo números o marcas de tiempo |
| 6983 | «3:48» | solo números o marcas de tiempo |
| 4429 | «4'03» | solo números o marcas de tiempo |
| 4430 | «4'06» | solo números o marcas de tiempo |

### `fragment` — fragmento de texto, no un nombre
| id | nombre | motivo |
| --- | --- | --- |
| 9635 | «B.» | fragmento de texto, no un nombre |
| 2789 | «Oscar Alcaíno "Oscarello» | fragmento de texto, no un nombre |
| 1824 | «PK» | fragmento de texto, no un nombre |
| 8674 | «Pa» | fragmento de texto, no un nombre |
| 5749 | «Part 1» | fragmento de texto, no un nombre |
| 5744 | «Part 2» | fragmento de texto, no un nombre |
| 5745 | «Part 3» | fragmento de texto, no un nombre |
| 3987 | «Pe» | fragmento de texto, no un nombre |

### `multiple_people` — varias personas en una ficha
| id | nombre | motivo |
| --- | --- | --- |
| 7011 | «"El Mosaico de la Alegría" by Abraham Gustin» | demasiados tokens para un nombre |
| 6544 | «Albert Marquina & Fernando Guzmán» | parece una lista de varias personas |
| 12212 | «Aldemaro Romero y Su Onda Nueva» | parece una lista de varias personas |
| 6640 | «Alejandro Araujo & Eduardo Soto» | parece una lista de varias personas |
| 8311 | «Ana Valencia Pimpi Santistevan Carlos Moreán Gonzalo "Chile" Veloz» | demasiados tokens para un nombre |
| 8315 | «Ana Valencia Pimpi Santistevan Carlos Moreán Gonzalo "Chile" Veloz Alvaro Serrano» | demasiados tokens para un nombre |
| 8329 | «Ana Valencia Pimpi Santistevan Carlos Moreán Gonzalo "Chile" Veloz Carlos Acosta» | demasiados tokens para un nombre |
| 8341 | «Ana Valencia Pimpi Santistevan Carlos Moreán Gonzalo "Chile" Veloz Edgar Salazar» | demasiados tokens para un nombre |

## Comprobaciones del paso

- [x] El caso obligatorio del plan («Ana Valencia Pimpi Santistevan Carlos
  Moreán Gonzalo "Chile" Veloz», id 8311) **no** clasifica como `ok`.
- [x] Un nombre largo real no se marca: «Carlos Alberto Abuchaibe Ferreira
  "Cabeto"» → `ok`. La regla de 6+ tokens solo salta sin apellido compuesto al
  final: «de Las Casas» salva, «De Ferrari Alejandro Londoño» no.
- [x] `duration` coincide exactamente con §1.2 (22 fichas): `(66)`, `2:05`,
  `4'03`, `Part 1` son el mismo material que el propietario ya conocía.
- [x] La sonda no escribe nada (ni transacción) y no se aplicó ninguna
  migración a la base de desarrollo.
- [x] Resultado de la sonda: `RESULTADO: OK` (ningún conteo se aleja >15 %).
