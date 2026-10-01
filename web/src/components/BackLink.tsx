import type { MouseEvent } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";

/**
 * Vuelve a la página anterior del historial. Si no hay una (se abrió el enlace
 * directo o en otra pestaña), cae a `fallback`, que también es el href real
 * para abrir en pestaña nueva.
 */
export function BackLink({ fallback }: { fallback: string }) {
  const navigate = useNavigate();
  const location = useLocation();
  // "default" es la clave de la primera entrada: no hay nada a lo que volver dentro de la app.
  const hasPrevious = location.key !== "default";

  function onClick(e: MouseEvent<HTMLAnchorElement>) {
    if (!hasPrevious || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
    e.preventDefault();
    navigate(-1);
  }

  return (
    <Link to={fallback} className="back-link" onClick={onClick}>
      ← Volver
    </Link>
  );
}
