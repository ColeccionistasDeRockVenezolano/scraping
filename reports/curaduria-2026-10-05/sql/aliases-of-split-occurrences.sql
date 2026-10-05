-- Alias heredados de la fusión de dos ocurrencias: al separarlas, el título de la otra ocurrencia
-- (u otra versión) quedó como alias de la primera y choca con la ficha que ahora lo lleva.
DELETE FROM ingest.track_aliases a USING ingest.curation_findings f
 WHERE f.status='open' AND f.detector='alias_que_choca_con_otra_ficha' AND f.entity_kind='track'
   AND a.track_id=f.entity_id AND a.alias=f.value;
DELETE FROM ingest.album_aliases WHERE album_id=14610 AND alias='Tonadas Favoritas';
