import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";
import { useAsync } from "./useAsync";
import { useDebouncedQuery } from "./useDebouncedQuery";
import type { Page } from "./types";

const LIMIT = 30;

/**
 * Lista paginada con `q`/`offset` reflejados en la URL (recargable, compartible).
 *
 * `q` es el borrador que ve el input; la URL —y con ella la petición— se
 * actualiza 250 ms después de la última tecla y con `replace`, así teclear no
 * llena el historial ni dispara una consulta por letra.
 */
export function useEntityList<T>(fetcher: (params: { q?: string; limit: number; offset: number }) => Promise<Page<T>>) {
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get("q") ?? "";
  const offset = Number(params.get("offset") ?? "0") || 0;

  const applyQuery = useCallback((next: string) => {
    setParams((current) => {
      const nextParams = new URLSearchParams(current);
      if (next.trim()) nextParams.set("q", next.trim()); else nextParams.delete("q");
      nextParams.delete("offset");
      return nextParams;
    }, { replace: true });
  }, [setParams]);

  const [q, setQuery] = useDebouncedQuery(urlQuery, applyQuery);

  const state = useAsync(
    () => fetcher({ ...(urlQuery.trim() ? { q: urlQuery.trim() } : {}), limit: LIMIT, offset }),
    [urlQuery, offset],
  );

  function setOffset(next: number) {
    setParams((current) => {
      const nextParams = new URLSearchParams(current);
      nextParams.set("offset", String(next));
      return nextParams;
    });
  }

  return { ...state, q, offset, limit: LIMIT, setQuery, setOffset };
}
