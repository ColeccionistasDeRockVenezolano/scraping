-- Nemesis (Caracas, 1999, heavy metal épico) tenía la alineación y la bio de Nemesis de Barquisimeto (1988-1996, 2024-),
-- que ya existe como «Nemesis (Lara)» (1287). Fuente: Metal Archives 93598 y 3540358739 («Not to be confused with…»).
UPDATE public.artist_members SET artist_id=1287, from_year=1988, to_year=1996, is_current=false WHERE id IN (2546,2548);
UPDATE public.artist_members SET artist_id=1287, from_year=1988, to_year=NULL, is_current=true WHERE id=2547;
UPDATE public.artist_members SET artist_id=1287, from_year=1992, to_year=NULL, is_current=true WHERE id=2549;
UPDATE public.artist_members SET artist_id=1287, from_year=1988, to_year=1992, is_current=false WHERE id=2550;
UPDATE public.artists SET formed_year=1988, biography='Banda venezolana de thrash metal formada en 1988 en Barquisimeto, estado Lara. La integraron Juancho (Juan Solano) en la guitarra, Robert (Robert Galban) en la voz y guitarra, Héctor (Hector Alvares) en el bajo y Jaime (Jaime Garrido) en la batería, con influencias de Metallica, Slayer, Exodus, Testament y Kreator. Estuvo activa entre 1988 y 1996; publicó la demo Anarkia en L.A. y un disco homónimo en 1994, y volvió en 2024 con grabaciones en vivo en Pertutti.'
 WHERE id=1287;
UPDATE public.artists SET biography='Banda venezolana de heavy metal de temática épica y fantástica, formada en Caracas en abril de 1999 por Arnaldo y Antonio Vivas junto al cantante Huaico Lovera y los guitarristas Darwin Abreu y Jorge «Épica». Hernán Albornoz le dio el nombre de Nemesis en octubre de 2000. Publicó un demo homónimo.'
 WHERE id=590;
