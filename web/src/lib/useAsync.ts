import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, CATALOG_DATA_CHANGED_EVENT } from "./api";

export interface AsyncState<T> {
  data: T | undefined;
  loading: boolean;
  error: string | undefined;
  /** El error original (ApiError incluida) para quien necesite sus detalles, p. ej. `movedTo`. */
  errorValue: unknown;
  reload: () => void;
}

/**
 * Carga de datos de solo lectura con estados loading/empty/error (FASE 8).
 * `deps` sigue la convención de useEffect: cambia la lista, se recarga.
 */
export function useAsync<T>(fetcher: (signal: AbortSignal) => Promise<T>, deps: unknown[]): AsyncState<T> {
  const [data, setData] = useState<T>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [errorValue, setErrorValue] = useState<unknown>();
  const generation = useRef(0);
  const controller = useRef<AbortController>();

  const load = useCallback(() => {
    const current = ++generation.current;
    controller.current?.abort();
    const nextController = new AbortController();
    controller.current = nextController;
    setLoading(true);
    setError(undefined);
    setErrorValue(undefined);
    fetcher(nextController.signal).then(
      (result) => { if (current === generation.current) { setData(result); setLoading(false); } },
      (err: unknown) => {
        if (nextController.signal.aborted) return;
        if (current !== generation.current) return;
        setError(err instanceof ApiError ? err.message : "No se pudo cargar la información.");
        setErrorValue(err);
        setLoading(false);
      },
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => { load(); }, [load]);
  useEffect(() => () => controller.current?.abort(), []);
  // Tras deshacer o rehacer un cambio, lo abierto se vuelve a leer: la ficha
  // restaurada reaparece y la retirada da su 404 sin recargar la página.
  useEffect(() => {
    window.addEventListener(CATALOG_DATA_CHANGED_EVENT, load);
    return () => window.removeEventListener(CATALOG_DATA_CHANGED_EVENT, load);
  }, [load]);

  return { data, loading, error, errorValue, reload: load };
}
