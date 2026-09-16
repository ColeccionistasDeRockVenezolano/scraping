-- CRV · filas exactas por tabla de los tres schemas del catálogo.
-- Lo usan scripts/db-backup.sh (al respaldar) y scripts/db-restore-check.sh
-- (sobre la base restaurada): los dos archivos deben ser idénticos.
SELECT format('%I.%I', n.nspname, c.relname) AS table_name,
       (xpath('/row/n/text()',
              query_to_xml(format('SELECT count(*) AS n FROM %I.%I', n.nspname, c.relname), false, true, '')))[1]::text AS n
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE c.relkind IN ('r', 'p')
   AND n.nspname IN ('public', 'ingest', 'media')
 ORDER BY 1;
