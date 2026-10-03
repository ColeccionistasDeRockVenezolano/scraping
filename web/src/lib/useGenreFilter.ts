import { useCallback, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import type { GenreListParams } from "./api";

/** Valor de `?genero=` que pide las fichas sin ningún género confirmado. */
export const WITHOUT_GENRE = "sin-genero";

export interface GenreSelection {
  /** Slug de la familia elegida, o `WITHOUT_GENRE`. */
  family: string | null;
  /** Slug del subgénero elegido dentro de la familia. */
  sub: string | null;
  /** Slug del estilo (tercer nivel: pasaje, galerón…) elegido dentro del subgénero. */
  style: string | null;
  /** Solo discos: sumar los que no tienen género propio por el de su artista. */
  related: boolean;
}

/**
 * Filtro por género de las listas, guardado en la URL como el resto de la
 * lista (`?genero=musica-venezolana&subgenero=joropo&estilo=pasaje&ampliar=1`): recargable,
 * compartible y con atrás/adelante. Cambiar el filtro vuelve a la página 1.
 */
export function useGenreFilter({ allowRelated }: { allowRelated: boolean }) {
  const [params, setParams] = useSearchParams();
  const family = params.get("genero") || null;
  const sub = family && family !== WITHOUT_GENRE ? params.get("subgenero") || null : null;
  const style = sub ? params.get("estilo") || null : null;
  const related = allowRelated && family !== null && family !== WITHOUT_GENRE && params.get("ampliar") === "1";

  const selection: GenreSelection = useMemo(() => ({ family, sub, style, related }), [family, sub, style, related]);

  const apiParams = useMemo<GenreListParams>(() => {
    if (family === WITHOUT_GENRE) return { withoutGenre: true };
    if (!family) return {};
    const genre = style ?? sub ?? family;
    return related ? { genre, relatedGenre: true } : { genre };
  }, [family, sub, style, related]);

  const update = useCallback((next: Partial<GenreSelection>) => {
    setParams((current) => {
      const nextParams = new URLSearchParams(current);
      const merged = { family, sub, style, related, ...next };
      const set = (key: string, value: string | null) => { if (value) nextParams.set(key, value); else nextParams.delete(key); };
      set("genero", merged.family);
      set("subgenero", merged.family && merged.family !== WITHOUT_GENRE ? merged.sub : null);
      set("estilo", merged.family && merged.family !== WITHOUT_GENRE && merged.sub ? merged.style : null);
      set("ampliar", allowRelated && merged.family && merged.family !== WITHOUT_GENRE && merged.related ? "1" : null);
      nextParams.delete("offset");
      return nextParams;
    });
  }, [setParams, family, sub, style, related, allowRelated]);

  return {
    selection,
    apiParams,
    /**
     * Elige una familia (o «sin género»). Pulsar la ya elegida la quita; si
     * tenía un subgénero, primero vuelve a la familia entera.
     */
    selectFamily: (slug: string | null) => update({ family: slug === family && !sub ? null : slug, sub: null, style: null }),
    /** Elige una familia sumando las fichas sin género que entran por la relación. */
    selectFamilyRelated: (slug: string) => update({ family: slug, sub: null, style: null, related: true }),
    /** Elige un subgénero de la familia indicada; `null` deja toda la familia. */
    selectSub: (familySlug: string, slug: string | null) => update({ family: familySlug, sub: slug, style: null }),
    /** Elige un estilo del subgénero indicado; `null` deja todo el subgénero. */
    selectStyle: (familySlug: string, subSlug: string, slug: string | null) => update({ family: familySlug, sub: subSlug, style: slug }),
    setRelated: (value: boolean) => update({ related: value }),
    clear: () => update({ family: null, sub: null, style: null, related: false }),
  };
}
