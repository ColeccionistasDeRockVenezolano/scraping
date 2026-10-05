-- «Un Buen Perdedor» (Franco de Vita) con 4 s: dato erróneo de MusicBrainz; se deja sin duración y el claim se rechaza.
UPDATE public.tracks SET duration_seconds=NULL WHERE id=38887 AND duration_seconds=4;
UPDATE ingest.claims SET status='rejected', updated_at=now() WHERE track_id=38887 AND field='duration_seconds' AND raw_value::text IN ('4','"4"');
