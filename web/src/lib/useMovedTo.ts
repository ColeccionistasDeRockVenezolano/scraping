// CRV · Destino de un id fusionado (E11.2).
//
// La API responde 404 con `movedTo` cuando la ficha consultada se fusionó con
// otra. Este hook lleva a la ficha que quedó —con un aviso, no en silencio—
// para que un enlace guardado o una exportación no terminen en un error.
import { useEffect, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError } from "./api";
import { entityHref } from "./routes";
import { useToast } from "./ToastContext";
import type { SearchEntityType } from "./types";

interface MovedTo {
  kind: SearchEntityType;
  id: number;
}

const MOVED_KINDS = new Set<string>(["artist", "person", "organization", "album", "track"]);

/** `movedTo` del cuerpo de un 404, si la API lo trajo. */
export function movedToFrom(errorValue: unknown): MovedTo | undefined {
  if (!(errorValue instanceof ApiError)) return undefined;
  const moved = errorValue.details?.["movedTo"];
  if (typeof moved !== "object" || moved === null) return undefined;
  const { kind, id } = moved as { kind?: unknown; id?: unknown };
  if (typeof kind !== "string" || !MOVED_KINDS.has(kind)) return undefined;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) return undefined;
  return { kind: kind as SearchEntityType, id };
}

/** Navega a la ficha que quedó cuando la carga falló con `movedTo`. */
export function useMovedToRedirect(errorValue: unknown): void {
  const navigate = useNavigate();
  const { notify } = useToast();
  // Un mismo fallo se atiende una sola vez: en desarrollo React monta los
  // efectos dos veces (StrictMode) y sin esta guarda saldrían dos avisos y dos
  // navegaciones por la misma respuesta.
  const handled = useRef<unknown>(undefined);
  useEffect(() => {
    const moved = movedToFrom(errorValue);
    if (!moved || handled.current === errorValue) return;
    handled.current = errorValue;
    notify("info", "Esta ficha se fusionó con otra; te llevamos a la que quedó.");
    navigate(entityHref(moved.kind, moved.id), { replace: true });
  }, [errorValue, navigate, notify]);
}
