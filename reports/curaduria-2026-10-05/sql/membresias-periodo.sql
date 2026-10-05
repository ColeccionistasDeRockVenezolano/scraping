-- Membresías con periodo imposible, según la alineación de Metal Archives (band-details-full.jsonl, 2026-10-01).
-- 1) Siguen en la banda (MA: «…-present» en otro rol o tramo): actual, sin año de fin.
UPDATE public.artist_members SET to_year=NULL, is_current=true
 WHERE id IN (2272,3685,2283,1970,2815,3533,2768,1670,2355,2639,4210,4219,4258,4412,3001,2999,2378,3073);
-- 2) El resto: tramo cerrado (banda separada o miembro con años de salida): ya no es actual.
UPDATE public.artist_members SET is_current=false
 WHERE id IN (2278,2535,928,932,3029,2887,2888,2889,2546,2548,3111,2190,2189,2188,2206,2207,
              2704,2706,2703,2701,2700,2705,1405,1404,2371,2664,2663,2659,2656,2657,4030,4088,
              4205,4204,4206,4207,4267,4284,4283,4285,4282,4340,4570);
-- 3) Año de formación según la bio: los primeros integrantes llegaron antes.
UPDATE public.artists SET formed_year=1977 WHERE id=210;  -- Resistencia
UPDATE public.artists SET formed_year=1996 WHERE id=44;   -- Antena Mantis
UPDATE public.artists SET formed_year=2003 WHERE id=248;  -- Todosantos
