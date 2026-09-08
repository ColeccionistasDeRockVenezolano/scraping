// CRV · Huella del catálogo core (CONTRACT §2, PHASES F0).
//
// El hash de `crv_simple_v1.sql` prueba que el ARCHIVO no cambió, y el diff
// de `pg_dump` en los tests prueba que las MIGRACIONES no tocan `public`.
// Ninguno de los dos detecta que alguien haya alterado `public` a mano en una
// base viva. Esta huella sí: enumera enums, columnas, vistas, constraints e
// índices reales y los compara contra el snapshot commiteado
// (`core-catalog.json`), generado desde el core aplicado verbatim.
//
// Estabilidad entre versiones: la huella se verificó byte a byte idéntica en
// PostgreSQL 15 y 16 (incluidos los `pg_get_viewdef`/`pg_get_constraintdef`
// deparseados), por eso puede vivir en un snapshot fijo.
import type { Pool } from "pg";
import snapshot from "./core-catalog.json" with { type: "json" };

export interface CoreCatalogSnapshot {
  /** sha256 de crv_simple_v1.sql con el que se generó esta huella. */
  coreSha256: string;
  generatedAt: string;
  /** Entradas normalizadas y ordenadas: "ENUM …", "COL …", "VIEW …", … */
  entries: string[];
}

export const CORE_CATALOG: CoreCatalogSnapshot = snapshot as CoreCatalogSnapshot;

const CATALOG_SQL = `
  SELECT 'ENUM ' || t.typname || '(' || string_agg(e.enumlabel, '|' ORDER BY e.enumsortorder) || ')' AS entry
    FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    JOIN pg_enum e ON e.enumtypid = t.oid
   WHERE n.nspname = 'public' AND t.typtype = 'e'
   GROUP BY t.typname
  UNION ALL
  SELECT 'COL ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
         || CASE WHEN a.attnotnull THEN ' NOT NULL' ELSE '' END
         || CASE a.attidentity WHEN 'a' THEN ' IDENTITY ALWAYS'
                               WHEN 'd' THEN ' IDENTITY BY DEFAULT' ELSE '' END
         || COALESCE(' DEFAULT ' || pg_get_expr(d.adbin, d.adrelid), '')
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
   WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'VIEW ' || c.relname || ' :: ' || regexp_replace(pg_get_viewdef(c.oid, true), '\\s+', ' ', 'g')
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = 'public' AND c.relkind = 'v'
  UNION ALL
  SELECT 'CONSTRAINT ' || rel.relname || '.' || con.conname || ' ' || pg_get_constraintdef(con.oid)
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = rel.relnamespace
   WHERE n.nspname = 'public'
  UNION ALL
  SELECT 'INDEX ' || indexname || ' ' || indexdef
    FROM pg_indexes
   WHERE schemaname = 'public'
`;

/** Lee la huella real del esquema `public` de una base viva. */
export async function readCoreCatalog(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ entry: string }>(CATALOG_SQL);
  return rows.map((r) => r.entry).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

export interface CatalogDiff {
  /** En el snapshot pero no en la base: alguien borró o alteró algo del core. */
  missing: string[];
  /** En la base pero no en el snapshot: alguien añadió algo a `public`. */
  extra: string[];
}

export function diffCoreCatalog(actual: string[], expected: string[] = CORE_CATALOG.entries): CatalogDiff {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  return {
    missing: expected.filter((e) => !actualSet.has(e)),
    extra: actual.filter((e) => !expectedSet.has(e)),
  };
}
