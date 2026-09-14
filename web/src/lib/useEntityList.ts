import { useSearchParams } from "react-router-dom";
import { useAsync } from "./useAsync";
import type { Page } from "./types";

const LIMIT = 30;

/** Lista paginada con `q`/`offset` reflejados en la URL (recargable, compartible). */
export function useEntityList<T>(fetcher: (params: { q?: string; limit: number; offset: number }) => Promise<Page<T>>) {
  const [params, setParams] = useSearchParams();
  const q = params.get("q") ?? "";
  const offset = Number(params.get("offset") ?? "0") || 0;

  const state = useAsync(
    () => fetcher({ ...(q.trim() ? { q: q.trim() } : {}), limit: LIMIT, offset }),
    [q, offset],
  );

  function setQuery(next: string) {
    const nextParams = new URLSearchParams(params);
    if (next.trim()) nextParams.set("q", next.trim()); else nextParams.delete("q");
    nextParams.delete("offset");
    setParams(nextParams);
  }

  function setOffset(next: number) {
    const nextParams = new URLSearchParams(params);
    nextParams.set("offset", String(next));
    setParams(nextParams);
  }

  return { ...state, q, offset, limit: LIMIT, setQuery, setOffset };
}
