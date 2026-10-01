// CRV · «Fallecido/a» para las lecturas de la API (Brian, 2026-09-30).
//
// Una persona figura como fallecida si `is_deceased` es true o tiene
// `death_date` (migración 0032). Un artista lo es cuando su proyecto lo es:
// lo lidera un titular fallecido, o es de una sola persona y esa persona
// murió. Una banda con varios integrantes no «falleció» porque uno murió.

/** Condición SQL sobre la fila de persona con alias `alias`. */
export const personDeceasedSql = (alias: string): string =>
  `(COALESCE(${alias}.is_deceased, false) OR ${alias}.death_date IS NOT NULL)`;

/** Condición SQL sobre un artista, dada la expresión SQL de su id. */
export const artistDeceasedSql = (artistId: string): string => `(
  EXISTS (
    SELECT 1 FROM public.artist_members dm JOIN public.persons dp ON dp.id = dm.person_id
     WHERE dm.artist_id = ${artistId} AND dm.role = 'Titular del proyecto' AND ${personDeceasedSql("dp")})
  OR (
    (SELECT count(DISTINCT dm.person_id) FROM public.artist_members dm WHERE dm.artist_id = ${artistId}) = 1
    AND EXISTS (
      SELECT 1 FROM public.artist_members dm JOIN public.persons dp ON dp.id = dm.person_id
       WHERE dm.artist_id = ${artistId} AND ${personDeceasedSql("dp")})))`;
