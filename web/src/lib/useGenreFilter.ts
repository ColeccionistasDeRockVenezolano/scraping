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
  /** Solo discos: sumar los que no tienen género propio por el de su artista. */
  related: boolean;
}

/**
 * Filtro por género de las listas, guardado en la URL como el resto de la
 * lista (`?genero=metal&subgenero=thrash-metal&ampliar=1`): recargable,
 * compartible y con atrás/adelante. Cambiar el filtro vuelve a la página 1.
 */
export function useGenreFilter({ allowRelated }: { allowRelated: boolean }) {
  const [params, setParams] = useSearchParams();
  const family = params.get("genero") || null;
  const sub = family && family !== WITHOUT_GENRE ? params.get("subgenero") || null : null;
  const related = allowRelated && family !== null && family !== WITHOUT_GENRE && params.get("ampliar") === "1";

  const selection: GenreSelection = useMemo(() => ({ family, sub, related }), [family, sub, related]);

  const apiParams = useMemo<GenreListParams>(() => {
    if (family === WITHOUT_GENRE) return { withoutGenre: true };
    if (!family) return {};
    return related ? { genre: sub ?? family, relatedGenre: true } : { genre: sub ?? family };
  }, [family, sub, related]);

  const update = useCallback((next: Partial<GenreSelection>) => {
    setParams((current) => {
      const nextParams = new URLSearchParams(current);
      const merged = { family, sub, related, ...next };
      const set = (key: string, value: string | null) => { if (value) nextParams.set(key, value); else nextParams.delete(key); };
      set("genero", merged.family);
      set("subgenero", merged.family && merged.family !== WITHOUT_GENRE ? merged.sub : null);
      set("ampliar", allowRelated && merged.family && merged.family !== WITHOUT_GENRE && merged.related ? "1" : null);
      nextParams.delete("offset");
      return nextParams;
    });
  }, [setParams, family, sub, related, allowRelated]);

  return {
    selection,
    apiParams,
    /**
     * Elige una familia (o «sin género»). Pulsar la ya elegida la quita; si
     * tenía un subgénero, primero vuelve a la familia entera.
     */
    selectFamily: (slug: string | null) => update({ family: slug === family && !sub ? null : slug, sub: null }),
    /** Elige una familia sumando las fichas sin género que entran por la relación. */
    selectFamilyRelated: (slug: string) => update({ family: slug, sub: null, related: true }),
    /** Elige un subgénero de la familia indicada; `null` deja toda la familia. */
    selectSub: (familySlug: string, slug: string | null) => update({ family: familySlug, sub: slug }),
    setRelated: (value: boolean) => update({ related: value }),
    clear: () => update({ family: null, sub: null, related: false }),
  };
}
