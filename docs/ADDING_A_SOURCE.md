# CRV · Incorporar una fuente nueva

Esta guía describe el proceso de gobierno y desarrollo para una fuente futura.
No autoriza ni añade ninguna fuente: la lista vigente sigue siendo la de
`docs/SOURCES.md`.

La regla central es doble:

1. una fuente se registra primero como propuesta deshabilitada y requiere una
   decisión humana explícita;
2. aun aprobada en la base, no puede hacer red hasta que exista un adapter con
   alcance finito, pruebas y registro explícito en el código.

## 1. Proponer, sin habilitar

```bash
npm run cli -- sources:add "Nombre" https://ejemplo.invalid website \
  "qué aporta, quién la mantiene y qué páginas se solicitan"
npm run cli -- review list
npm run cli -- review show <id>
```

`sources:add` crea `ingest.sources.enabled=false`, confianza inicial `low` y
una revisión `new_source`. No descarga nada. Nombre, URL, tipo y justificación
deben quedar en el payload de esa revisión.

No se acepta como justificación «parece útil». La propuesta debe identificar:

- propietario o responsable editorial;
- datos concretos que aportaría;
- origen y rutas exactas que se desean consultar;
- licencia, permiso o superficie pública que habilita ese acceso;
- frecuencia prevista y volumen máximo.

## 2. Verificación humana previa

Una persona revisa la propuesta y documenta en `docs/SOURCES.md`:

- resultado y fecha de `robots.txt`;
- feed/API/sitemap público preferido sobre HTML;
- si requiere JavaScript, autenticación o sesión;
- codificación real del contenido;
- paginación y frontera finita confirmadas;
- límites publicados y demora de cortesía;
- confianza inicial por tipo de dato;
- prohibiciones y datos que el parser no debe inferir.

La sonda es de solo lectura, con User-Agent identificable, una petición a la
vez y pausa entre peticiones. No se prueban APIs privadas, credenciales,
CAPTCHAs, proxies ni técnicas de evasión. Si el sitio lo prohíbe, no ofrece una
superficie autorizada o exige login, la fuente queda `limited`/`disabled`. Si
solo admite evidencia manual, se implementa ese modo sin automatizar la red.

La aprobación de la propuesta se registra en la cola. La versión actual no
tiene un comando genérico para convertir una revisión `new_source` en adapter:
habilitar la fila es una operación explícita del propietario después de que el
cambio de código descrito abajo esté desplegado. Nunca se habilita primero.

## 3. Implementar el adapter

Un adapter implementa `SourceAdapter` de `src/adapters/contracts.ts` y solo
transforma snapshots en `RawRecord`; no escribe PostgreSQL ni decide merges.

Checklist mínimo:

- `slug` estable e idéntico al de `ingest.sources`;
- `requiresBrowser: false` mientras exista un canal HTTP estructurado;
- `listPages()` con frontera cerrada y `crawlLimit` duro;
- `isAllowedUrl()` para mismo origen y rutas aprobadas;
- `discover()` únicamente si los enlaces del snapshot amplían una frontera
  conocida y acotada;
- `decodeBody()` si la fuente no es UTF-8;
- `extractSnapshot()` para JSON/XML o cuando se necesita el cuerpo original;
- versión de extractor incrementada al cambiar semántica;
- evidencia por campo: URL y, cuando exista, extracto/selector/posición;
- cero inferencias desde prosa o desde un título aislado cuando la página no
  afirma el hecho.

Preferir Cheerio o JSON/XML directo. Playwright solo se considera si la
revisión aprobó expresamente una superficie pública que no funciona sin JS;
no se usa para saltar controles de acceso.

### Salida permitida

Cada registro debe pasar `rawRecordSchema` y la normalización común. Los tipos
válidos son los de `claimEntityKindSchema`: artistas, personas,
organizaciones, discos, pistas, relaciones, créditos, formatos, YouTube y
medios. Un crédito de músico nunca genera por sí mismo
`artist_membership`. Un video musical, documental o concierto nunca crea por
sí mismo un álbum.

Todo adapter web nuevo entra con confianza `low`: sus claims quedan
`candidate` hasta revisión. Subir confianza requiere una decisión documentada,
no una constante conveniente en el parser.

## 4. Registrar la capacidad

Añadir la entrada a `src/adapters/registry.ts` como una de estas capacidades:

- `functional / automatic / enabled`: adapter HTTP probado;
- `limited / manual / disabled`: solo evidencia aportada por una persona;
- `limited / disabled / disabled`: no existe acceso autorizado.

El registro es una segunda barrera además de `ingest.sources.enabled`. El
fetcher exige ambas: una fila activada sin adapter funcional sigue sin poder
scrapear.

Si la fuente pasa a formar parte de la lista seed del proyecto, actualizar de
forma deliberada `Links for Data Scrapping.xlsx`, el bloque `ENRICHMENT` y los
conteos cerrados de `src/ingest/sources.ts`. No editar el XLSX ni esos conteos
antes de la aprobación. `sources:seed` conserva cambios operativos existentes
en `enabled`, `trust_level` y `public_display`.

## 5. Fixtures y pruebas obligatorias

Guardar un snapshot pequeño, representativo y sin secretos en
`test/fixtures/adapters/`. Debe conservar las rarezas reales que gobiernan el
parser: encoding, campos ausentes, listas largas, créditos, paginación o
marcado alternativo.

Actualizar:

- `test/support/adapter-fixtures.ts` (`ADAPTER_SLUGS`, URL, tipo y uno o más
  fixtures);
- `test/unit/adapters.test.ts` para contrato, evidencia, alcance e
  idempotencia de normalización;
- un test unitario específico si el marcado tiene reglas propias;
- `test/contract/adapters-ingestion.test.ts`, que procesa dos veces contra
  PostgreSQL y exige cero claims o entidades duplicadas en la segunda pasada;
- el test del registro cerrado y cualquier conteo de fuentes que cambie por la
  aprobación.

Casos que deben probarse expresamente:

1. URL fuera de origen o ruta no aprobada es rechazada;
2. descubrimiento termina en el límite fijado;
3. cada claim tiene evidencia de la página correcta;
4. campos ausentes no se inventan;
5. varias personas/créditos no se funden;
6. un invitado no se convierte en miembro;
7. repetir el snapshot reutiliza todos los claims;
8. un cambio real del snapshot conserva la evidencia anterior y abre conflicto
   cuando corresponde.

Ejecutar antes de habilitar:

```bash
npm run lint
npm run typecheck
npm test
npm run doctor
```

## 6. Despliegue gradual

Con aprobación, adapter y pruebas ya desplegados:

1. respaldar (`npm run db:backup`) y probar el respaldo;
2. completar `access_strategy`, `trust_level`, `notes` y el alcance aprobado;
3. cambiar `enabled=true`. No existe ruta de API ni comando CLI para eso
   (KI-05): es un `UPDATE ingest.sources SET enabled=true, … WHERE slug='<slug>'`
   que ejecuta el propietario, y la fecha, el autor y el motivo se anotan en la
   ficha de `docs/SOURCES.md` y en la nota de la revisión `new_source`;
4. ejecutar primero `scrape <slug> --observe`;
5. inspeccionar `raw_pages`, errores, encoding y frontera real;
6. ejecutar `scrape source <slug> --all --dry-run` sobre el crudo;
7. revisar una muestra de claims y evidencia;
8. ejecutar la ingesta real y trabajar la cola, nunca promover en lote sin
   vista previa y nota.

Si robots, estructura o autorización cambian, poner `enabled=false` y
reclasificar la capacidad. El crudo y los claims históricos se conservan: no
se borran para silenciar una fuente que dejó de estar disponible.

## 7. Criterio de aceptación

Una fuente está incorporada solo cuando existen, al mismo tiempo: aprobación
humana, documentación de acceso, registro explícito, frontera finita, fixture,
tests verdes, observación del crudo, ingesta idempotente y procedimiento de
desactivación. Una fila en `ingest.sources` por sí sola no cumple el proceso.
