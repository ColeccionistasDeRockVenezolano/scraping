-- Títulos de Sincopa con el nombre del artista pegado al final; la discografía (alias) da el título real.
WITH fix(id, title) AS (VALUES (8315,'Recordando Al Rey Del Merecumbé Vol.2'),(8313,'Marcando El Ritmo'),(8314,'Al Que Le Pique!'),
  (8318,'Y Tu Como Estas?'),(8311,'El Sabor Tentador de...'),(8308,'En Acción'),(8320,'20 Aniversario'),(8317,'Los Melódicos'),
  (9086,'La Música de Venezuela'),(8322,'Noche De Fiesta Con Los Melódicos'),(8310,'Con Todos Los Hierros'),(8312,'Heavy'),(7956,'Nuestro Balance'))
UPDATE public.albums a SET title=fix.title FROM fix WHERE a.id=fix.id;
DELETE FROM ingest.album_aliases al USING public.albums a WHERE a.id=al.album_id AND lower(al.alias)=lower(a.title)
  AND a.id IN (8315,8313,8314,8318,8311,8308,8320,8317,9086,8322,8310,8312,7956);
-- Alias que era el título de otro disco del mismo año (enlace de discografía).
DELETE FROM ingest.album_aliases WHERE album_id=9426 AND alias='Quinteto Contrapunto';
