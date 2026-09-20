// CRV · Un media query como estado de React: la misma condición que decide el
// CSS decide también qué se renderiza cuando no basta con esconder algo (las
// acciones de una tarjeta en móvil pasan a una hoja inferior, no se ocultan).
import { useEffect, useState } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const list = window.matchMedia(query);
    const onChange = () => setMatches(list.matches);
    onChange();
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
