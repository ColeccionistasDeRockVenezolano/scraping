-- Restos de Nemesis de Barquisimeto en la ficha de Caracas (590) tras el run 16819: claims de MA 3540358739
-- (formada 1988, activa, 1988-1996/2024-, temas sociales, thrash), la ficha de Rock De Vzla (myspace nemesisbarquisimeto)
-- y su bio sintetizada, y los alias «Némesis» (Rock De Vzla) y «NEMESIS» (claim de Lara). Pasan a «Nemesis (Lara)» (1287).
UPDATE ingest.claims SET artist_id=1287, updated_at=now()
 WHERE artist_id=590 AND id IN (662531,662532,662533,662534,724909,189485,189486,189487,189488,637427);
UPDATE ingest.artist_aliases SET artist_id=1287 WHERE id IN (903,1864) AND artist_id=590;
UPDATE ingest.artist_genres SET status='rejected', decision_kind='human', decided_by='claude-code', updated_at=now() WHERE id=8711 AND artist_id=590;
UPDATE public.artists SET status='active', themes='Social issues, Anarchism', years_active='1988-1996, 2024-present' WHERE id=1287;
