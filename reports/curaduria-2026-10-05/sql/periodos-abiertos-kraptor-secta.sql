-- Alineaciones «(año-?)» de Metal Archives en bandas que no constan activas: Kraptor está separada (Split-up)
-- y Secta Canibal tiene estado Unknown. El fin es desconocido: is_current=false, to_year NULL. Phill Alvarez: 2007-2019.
UPDATE public.artist_members SET is_current=false WHERE id IN (2355,2356,2357,1669,1670,1671);
UPDATE public.artist_members SET from_year=2017 WHERE id IN (2356,2357) AND from_year IS NULL;
UPDATE public.artist_members SET from_year=2007, to_year=2019, is_current=false WHERE id=1021;
UPDATE public.artist_members SET from_year=2002 WHERE id=1669 AND from_year IS NULL;
UPDATE public.artist_members SET from_year=2009 WHERE id=1671 AND from_year IS NULL;
