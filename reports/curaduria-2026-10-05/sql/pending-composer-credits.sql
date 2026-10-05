-- Créditos de composición de Sincopa en espera cuya pista ya existe en el core (personas que estaban sin vínculos).
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 158827, 21497, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=158827 AND person_id=21497 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=3854 AND identity_key='melodies for the soul quintessence quincy jones' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 56627, 26770, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=56627 AND person_id=26770 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=5035 AND identity_key='gold ojos malvados c soladrigas' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 158854, 27489, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=158854 AND person_id=27489 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=5095 AND identity_key='conjunto ingeniería bajo la luna a uliches' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 68857, 33015, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=68857 AND person_id=33015 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=3676 AND identity_key='la onda nueva en méxico cucurrucucu tomás méndez' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 71390, 33015, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=71390 AND person_id=33015 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=3707 AND identity_key='la onda nueva en méxico cucurrucucu tomás méndez' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 158849, 33081, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=158849 AND person_id=33081 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=3691 AND identity_key='onda nueva vocal limón limonero h cordovil' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 158849, 33081, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=158849 AND person_id=33081 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=3697 AND identity_key='onda nueva vocal limón limonero h cordovil' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 18885, 36246, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=18885 AND person_id=36246 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=2572 AND identity_key='cuauhtemoc así eres tú resistencia cover' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 17559, 37208, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=17559 AND person_id=37208 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=2930 AND identity_key='memphis el caballo la mula y el perro memphis' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 18578, 37270, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=18578 AND person_id=37270 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=2952 AND identity_key='carita mimada o quizás simplemente le regale una rosa leonardo favio' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 18601, 37271, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=18601 AND person_id=37271 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=2953 AND identity_key='un vaso de vino un hombre un niño chelioque sarabia' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 3939, 38003, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=3939 AND person_id=38003 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=6107 AND identity_key='festival nuevas bandas la historia quién quiere ver luky grande' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 158886, 38535, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=158886 AND person_id=38535 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=5831 AND identity_key='noches de fantasía 34 grandes exitos serie 32 año nuevo vida nueva lino perez' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 158886, 38535, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=158886 AND person_id=38535 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=5835 AND identity_key='noches de fantasía 34 grandes exitos serie 32 año nuevo vida nueva lino perez' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 34343, 39008, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=34343 AND person_id=39008 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=816 AND identity_key='total blues fusion big boss man al smith' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 164082, 39014, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=164082 AND person_id=39014 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=938 AND identity_key='shindig till i met you mc nally' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 163740, 39022, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=163740 AND person_id=39022 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=1030 AND identity_key='the pets este es el fin mike jagger' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 163743, 39024, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=163743 AND person_id=39024 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=1030 AND identity_key='the pets hello i love you the doors' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 164969, 39045, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=164969 AND person_id=39045 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=1366 AND identity_key='gina y agny soledades lope de vega' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 163900, 39117, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=163900 AND person_id=39117 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=1671 AND identity_key='vuélvete esa canción ch chaltikis' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 163912, 39119, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=163912 AND person_id=39119 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=1674 AND identity_key='credulidades papá david lobato' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 30491, 39125, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=30491 AND person_id=39125 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=1703 AND identity_key='para la gente joven qué me has dado esther de bassega' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 163839, 39131, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=163839 AND person_id=39131 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=1772 AND identity_key='tu y yo canciones tristes sad songs written alessi' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 163975, 39132, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=163975 AND person_id=39132 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=1774 AND identity_key='en mis horas más intimas si yo fuera tu jimi tunnel' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 30478, 39361, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=30478 AND person_id=39361 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=2945 AND identity_key='el ultimo beso el ultimo beso eddie cochran' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 30872, 39361, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=30872 AND person_id=39361 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=2964 AND identity_key='grandes exitos de los 007 el ultimo beso eddie cochran' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
WITH tc AS (INSERT INTO public.track_credits(track_id, person_id, credit_type, role)
  SELECT 28605, 39394, 'composer', 'composer' WHERE NOT EXISTS (SELECT 1 FROM public.track_credits WHERE track_id=28605 AND person_id=39394 AND credit_type='composer') RETURNING id)
UPDATE ingest.claims SET track_credit_id=(SELECT id FROM tc), status='accepted', updated_at=now()
 WHERE source_id=7 AND raw_page_id=3011 AND identity_key='feedback oh carol sedaka arr baltodano' AND entity_kind='track_credit' AND status IN ('candidate','conflict') AND EXISTS (SELECT 1 FROM tc);
