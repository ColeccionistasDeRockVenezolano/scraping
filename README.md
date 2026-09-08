# Coleccionistas de Rock Venezolano — DB v1 simplificada

## Archivos
- `crv_simple_v1.dbml`: pegar directamente en https://dbdiagram.io/
- `crv_simple_v1.sql`: PostgreSQL 15+
- `crv_simple_conceptual.svg`: vista simple para discutir el modelo
- `crv_simple_relational.svg`: vista técnica con PK/FK

## Importar en dbdiagram.io
1. Crear un diagrama nuevo.
2. Borrar el ejemplo inicial.
3. Copiar y pegar todo el contenido de `crv_simple_v1.dbml`.
4. dbdiagram.io dibujará las relaciones automáticamente.

## Idea central
`artists -> albums -> tracks`, con `persons` conectadas mediante membresías y créditos.
Las organizaciones representan sellos, estudios y productoras.
