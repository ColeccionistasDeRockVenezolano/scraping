-- Duraciones desde MusicBrainz/Deezer: edición enlazada al disco, mismo título y al menos otra pista que ya coincide (±3 s) sin ninguna en contra; solo donde faltaba.
UPDATE public.tracks SET duration_seconds=138 WHERE id=164150 AND duration_seconds IS NULL; -- https://musicbrainz.org/release/28a7e2ec-fc76-4826-b791-b3a0e9028d47
UPDATE public.tracks SET duration_seconds=227 WHERE id=164905 AND duration_seconds IS NULL; -- https://musicbrainz.org/release/28a7e2ec-fc76-4826-b791-b3a0e9028d47
UPDATE public.tracks SET duration_seconds=175 WHERE id=54918 AND duration_seconds IS NULL; -- https://www.deezer.com/album/10234054
UPDATE public.tracks SET duration_seconds=192 WHERE id=59037 AND duration_seconds IS NULL; -- https://www.deezer.com/album/245104872
UPDATE public.tracks SET duration_seconds=115 WHERE id=14841 AND duration_seconds IS NULL; -- https://musicbrainz.org/release/fe820d95-9f43-4fc4-b7fb-c5507673a02a
UPDATE public.tracks SET duration_seconds=200 WHERE id=164146 AND duration_seconds IS NULL; -- https://musicbrainz.org/release/b2447900-ff9e-499c-ace8-1403ab2b8f2e
UPDATE public.tracks SET duration_seconds=224 WHERE id=164792 AND duration_seconds IS NULL; -- https://musicbrainz.org/release/612c5454-4233-41ec-9041-4ae1b9d5b903
