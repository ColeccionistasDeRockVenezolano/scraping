-- Segundas ocurrencias que la ficha distingue (versión, en vivo, demo) y títulos que eran de otra entrada.
UPDATE public.tracks SET title='Decadencia (Live)' WHERE id=164914;
UPDATE public.tracks SET title='Manifestación (Live)' WHERE id=164746;
UPDATE public.tracks SET title='Americano (Live)' WHERE id=164747;
UPDATE public.tracks SET title='La Vida Sigue (Acoustic Version)' WHERE id=164751;
UPDATE public.tracks SET title='Los Que Se Quedan, Los Que Se Van (Acoustic Version)' WHERE id=164791;
UPDATE public.tracks SET title='A Mí Me Gusta El Desorden (Coco-Munchen Version)' WHERE id=164792;
UPDATE public.tracks SET title='Tomorrow (Acoustic Version)' WHERE id=164799;
UPDATE public.tracks SET title='Behold the Zombie Nation (Demo)' WHERE id=164878;
UPDATE public.tracks SET title='Dónde Estará Margot (Portugués Version)' WHERE id=164892;
UPDATE public.tracks SET title='A Bailar (Radio Version)' WHERE id=24163;
UPDATE public.tracks SET title='A Bailar (Long Version)' WHERE id=164752;
UPDATE public.tracks SET title='No Te Quiero Olvidar (Ballad Version)' WHERE id=164804;
UPDATE public.tracks SET title='Diferente Amanecer (Latin Pop Version)' WHERE id=164805;
UPDATE public.tracks SET title='Que Nos Dejen En Paz (Long Version)' WHERE id=54149;
UPDATE public.tracks SET title='Que Nos Dejen En Paz (Short Version)' WHERE id=164153;
UPDATE public.tracks SET title='Una Pena Tengo Yo (Long Version)' WHERE id=54150;
UPDATE public.tracks SET title='Una Pena Tengo Yo (Short Version)' WHERE id=164154;
UPDATE public.tracks SET title='Tu La Tienes Que Pagar (Long Version)' WHERE id=54151;
UPDATE public.tracks SET title='Tu La Tienes Que Pagar (Short Version)' WHERE id=164908;
-- La pista 4 de cada disco llevaba el título de la B4 (fusión por título); la ficha dice otra cosa.
UPDATE public.tracks SET title='Cuando La Luna Canto' WHERE id=23618;
UPDATE public.tracks SET title='Una De Vaqueros' WHERE id=24704;
-- Caramelos De Cianuro · Flor De Fuego: el DVD «The Making of Flor De Fuego» es el disco 2.
UPDATE public.tracks SET disc_number=2, track_number=track_number-10 WHERE album_id=140 AND disc_number=1 AND track_number BETWEEN 11 AND 26;
