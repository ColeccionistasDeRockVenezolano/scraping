import type { EntityKind, SearchEntityType } from "./types";

const ENTITY_ROUTE: Record<EntityKind, string> = {
  artist: "artistas", person: "personas", organization: "organizaciones", album: "discos", track: "discos",
};

/** Ruta de la ficha de una entidad. `track` no tiene página propia: se navega al disco. */
export function entityHref(kind: SearchEntityType, id: number, albumId?: number): string {
  if (kind === "track") return albumId !== undefined ? `/discos/${albumId}` : "#";
  return `/${ENTITY_ROUTE[kind]}/${id}`;
}
