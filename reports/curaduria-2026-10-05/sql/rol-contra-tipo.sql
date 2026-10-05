-- Curaduría 2026-10-05: el tipo de crédito contradecía el rol escrito por la fuente (cosecha de Metal Archives
-- guardó como «musician» todo el bloque de créditos). El tipo pasa a ser el del rol; los roles compuestos
-- reciben un segundo crédito con el otro tipo; el «other/Lyrics» repetido se retira aparte con removeRelation (run siguiente).
UPDATE public.album_credits SET credit_type='artwork' WHERE id IN (20155,20164,20248,20320,20413,20418);
UPDATE public.album_credits SET credit_type='recording' WHERE id IN (20221,20382,20395);
UPDATE public.album_credits SET credit_type='producer' WHERE id IN (20247,20266,20274,20360,20425,20473,20455,20466);
UPDATE public.album_credits SET credit_type='writer' WHERE id IN (20285,20293,20296,20471,20472);
UPDATE public.album_credits SET credit_type='mixing' WHERE id=20498;
UPDATE public.album_credits SET credit_type='musician' WHERE id=22521;
-- Roles compuestos: segundo crédito.
INSERT INTO public.album_credits(album_id, person_id, credit_type, role)
SELECT album_id, person_id, t::credit_type, role FROM public.album_credits c
  JOIN (VALUES (20385,'writer'),(20429,'writer'),(20455,'writer'),(20466,'writer'),(21639,'producer'),(54479,'producer')) v(cid,t) ON v.cid=c.id;
