# CRV — Notas de dependencias (excepciones auditadas)

Registro de vulnerabilidades de `npm audit` evaluadas y aceptadas
conscientemente, con la razón por la que no aplican a este uso.

## uuid <11.1.1 (vía exceljs)

- **Advisory:** GHSA-w5hq-g745-h8pq — falta de comprobación de límites del
  buffer en `uuid` v3/v5/v6 **cuando la llamada pasa un `buf` propio**.
- **Por qué no aplica aquí:** `exceljs` (usado solo para leer los dos XLSX
  del proyecto, F1) únicamente llama a `uuid.v4()` sin `buf`
  (`node_modules/exceljs/lib/xlsx/xform/sheet/cf-ext/cf-rule-ext-xform.js`),
  la única ruta de código con la que `exceljs` toca `uuid`. La ruta
  vulnerable nunca se ejecuta.
- **Alternativa considerada y descartada:** `npm audit fix --force`
  degradaría `exceljs` a la serie 3.4.0 (breaking change, API distinta),
  cambio peor que mantener la versión actual con esta excepción documentada.
- Revisar de nuevo si `exceljs` cambia su uso interno de `uuid`, o si
  aparece una versión de `exceljs` que actualice su dependencia.
