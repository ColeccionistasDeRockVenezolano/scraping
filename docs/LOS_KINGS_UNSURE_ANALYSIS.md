# Análisis de los 77 `unsure` de Los Kings

Fecha de corte: 2026-09-11.

Estado: **resuelto y aplicado** en `merge_run` 102; la reanudación del claim
histórico de año de *Cuando Te Hablo De Amor* quedó auditada en el run 103.
La Mesa terminó con 195/195 decisiones aplicadas y ningún `unsure`.

## Conclusión

Los 77 renglones no representan 77 dudas discográficas independientes. Se
agrupan en seis identidades de álbum de **Los Kings** que el resolvedor
histórico comparó con discos canónicos sin relación:

| Álbum reclamado | Año / catálogo en Síncopa | `unsure` | Candidato incorrecto |
|---|---:|---:|---|
| Los Kings | 1970 · Palacio LP-6286 | 15 | Fusión IV — *Tarde Pero Temprano* |
| Los Kings Vol.2 | 1971 · Palacio LP-6298 | 15 | Fusión IV — *Tarde Pero Temprano* (13) y Sangre — *Sangre* (2) |
| Cuando Me Faltas Tú | 1972 · Palacio LP-6309 | 15 | Fusión IV — *Tarde Pero Temprano* |
| Cuando Te Hablo De Amor | 1974 · Palacio LPS-66334 | 12 | Fusión IV — *Tarde Pero Temprano* |
| El Super Grupo | 1975 · Palacio LPS-66357 | 5 | Fusión IV — *Tarde Pero Temprano* |
| Concierto De Otoño | 1977 · Palacio LPS-66398 | 15 | Fusión IV — *Tarde Pero Temprano* |

**Recomendación:** cambiar los 77 veredictos de `unsure` a `different` y
aplicarlos por identidad. Los candidatos mostrados pertenecen a otros artistas,
por lo que no hay una base razonable para fusionarlos. El aplicador creará o
vinculará una sola entidad canónica por cada disco de Los Kings; no creará 77
álbumes.

## Evidencia contrastada

1. La [discografía de Los Kings en Síncopa](https://sincopa.com/rock_pop/artist_rock/los_kings.htm)
   atribuye los seis títulos a Los Kings y conserva sus años y números de
   catálogo. Sus páginas individuales aportan además los tracklists.
2. La [discografía comentada de Richard Falk](https://rf3769.wixsite.com/richardfalksreviews/kh-ky)
   coincide título por título, incluido sello, catálogo y año: LP-6286 (1970),
   LP-6298 (1971), LP-6309 (1972), LPS-66334 (1974), LPS-66357 (1975) y
   LPS-66398 (1977).
3. El [catálogo de fonogramas de IASA](https://www.iasa-online.de/files/Brand_Sammelverzeichnis_Latin_Schalllplatten.pdf)
   confirma explícitamente *Los Kings* (LP-6286, 1970) y *Los Kings - Vol. 2*
   (LP-6298, 1971).
4. La prensa musical de 1973 registra “Cuando Me Faltas Tu — Los Kings —
   Palacio” en la lista venezolana: [Record World, 31 de marzo de 1973](https://www.worldradiohistory.com/Archive-All-Music/Record-World/70s/73/RW-1973-03-31.pdf).

## Causa del falso positivo

Los claims persistidos proceden de una versión histórica del adaptador de
Síncopa que usaba el título aislado como `identity_raw`. Al faltar el artista
padre en la identidad, el resolvedor produjo candidatos globales débiles. El
adaptador actual ya usa `artista::título`, por lo que una reingesta no debería
repetir este patrón.

## Única salvedad

Para *El Super Grupo*, Síncopa, el catálogo LPS-66357 y otra evidencia del
ejemplar físico apuntan a **1975**, mientras algunas reseñas biográficas lo
enumeran como **1976**. Esto no cambia la decisión de identidad: en ambos casos
es un álbum de Los Kings y no *Tarde Pero Temprano*. Si se incorpora una fuente
que sostenga 1976, debe abrirse un conflicto de `release_year` separado y
mantener 1975 como valor respaldado por catálogo hasta resolverlo.

## Aplicación segura propuesta

1. Cambiar únicamente los 77 veredictos activos agrupados arriba a
   `different`; conservar intactas las 118 decisiones ya aplicadas.
2. Ejecutar primero la previsualización de `review apply-decisions` y exigir
   `invalid: 0`.
3. Aplicar con una nota que cite esta revisión y comprobar que se creen seis
   discos bajo Los Kings, con sus claims agrupados y sin afectar los álbumes de
   Fusión IV ni Sangre.
4. Reingestar las páginas de Síncopa con la identidad compuesta actual para
   demostrar idempotencia.
