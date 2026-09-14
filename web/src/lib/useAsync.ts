import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api";

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  reload: () => void;
}

/**
 * Carga de datos de solo lectura con estados loading/empty/error (FASE 8).
 * `deps` sigue la convención de useEffect: cambia la lista, se recarga.
 */
export function useAsync<T>(fetcher: () => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const generation = useRef(0);

  const load = useCallback(() => {
    const current = ++generation.current;
    setLoading(true);
    setError(undefined);
    fetcher().then(
      (result) => { if (current === generation.current) { setData(result); setLoading(false); } },
      (err: unknown) => {
        if (current !== generation.current) return;
        setError(err instanceof ApiError ? err.message : "No se pudo cargar la información.");
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { load(); }, [load]);

  return { data, loading, error, reload: load };
}
