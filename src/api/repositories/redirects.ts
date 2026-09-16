// CRV · Redirecciones en la capa HTTP (PHASES E11.2).
//
// La lógica de lectura vive en `src/merge/redirects.ts`, junto a `mergeInto`
// que es quien escribe la tabla; aquí solo se traduce a la respuesta HTTP: un
// 404 de una ficha fusionada lleva `movedTo` para que la web navegue a la
// ficha que quedó.
export {
  REDIRECT_KINDS, resolveRedirect, type RedirectKind, type RedirectTarget,
} from "../../merge/redirects.js";

import { resolveRedirect, type RedirectKind } from "../../merge/redirects.js";
import { notFound, type ApiError } from "../http-errors.js";

/** 404 de una ficha que no existe, con `movedTo` cuando su id fue fusionado. */
export async function notFoundEntity(kind: RedirectKind, id: number): Promise<ApiError> {
  const moved = await resolveRedirect(kind, id);
  return notFound(kind, id, moved ? { movedTo: moved } : undefined);
}
