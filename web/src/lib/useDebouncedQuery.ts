import { useEffect, useState } from "react";

/** Pausa de tecleo compartida por los buscadores: una consulta por pausa, no por tecla. */
export const TYPING_DEBOUNCE_MS = 250;

/**
 * Borrador local para inputs de búsqueda: el input muestra lo tecleado al
 * instante y `commit` aplica el valor 250 ms después de la última tecla (quien
 * commitea decide si toca la URL con `replace`). Un cambio externo de la URL
 * —atrás/adelante, enlace compartido— manda y el borrador lo sigue.
 */
export function useDebouncedQuery(urlValue: string, commit: (value: string) => void): [string, (next: string) => void] {
  const [value, setValue] = useState(urlValue);

  useEffect(() => { setValue(urlValue); }, [urlValue]);

  useEffect(() => {
    if (value.trim() === urlValue.trim()) return;
    const timer = setTimeout(() => commit(value), TYPING_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [value, urlValue, commit]);

  return [value, setValue];
}
