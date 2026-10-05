-- Curaduría 2026-10-05: roles compuestos repartidos; cada crédito lleva solo la parte del rol que corresponde a su tipo.
UPDATE public.album_credits SET role='Everything' WHERE id=20385;
UPDATE public.album_credits SET role='Songwriting, Lyrics (tracks 1 - 4, 6, 7, 8)' WHERE id=70939;
UPDATE public.album_credits SET role='All instruments' WHERE id=20429;
UPDATE public.album_credits SET role='Lyrics' WHERE id=70940;
UPDATE public.album_credits SET role='Producer, Executive producer' WHERE id IN (20458,20469);
UPDATE public.album_credits SET role='Songwriting' WHERE id IN (70941,70942);
UPDATE public.album_credits SET role='Remastered by' WHERE id=21639;
UPDATE public.album_credits SET role='Produced by' WHERE id IN (70943,70944);
UPDATE public.album_credits SET role='Remixed by' WHERE id=54479;
