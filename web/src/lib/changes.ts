// CRV · Cómo se nombra un cambio del catálogo en la web (Historial, barra de
// «Deshacer» y cambios de cada ficha). Solo presentación: los datos vienen de
// GET /changes.
import type { ChangeEntityKind, ChangeSummary, UndoStep } from "./types";

const KIND_LABEL: Record<string, string> = {
  artist: "artista", artists: "artista",
  person: "persona", persons: "persona",
  organization: "organización", organizations: "organización",
  album: "disco", albums: "disco",
  track: "pista", tracks: "pista",
  album_credit: "crédito de disco", "album-credits": "crédito de disco",
  track_credit: "crédito de pista", "track-credits": "crédito de pista",
  artist_member: "integrante", artist_membership: "integrante", "artist-members": "integrante",
  person_organization: "vínculo persona–organización", "person-organizations": "vínculo persona–organización",
  album_format: "formato de disco", "album-formats": "formato de disco",
  artist_alias: "alias de artista", person_alias: "alias de persona", organization_alias: "alias de organización",
  album_alias: "alias de disco", track_alias: "alias de pista",
  album_credits: "crédito de disco", track_credits: "crédito de pista", artist_members: "integrante",
  person_organizations: "vínculo persona–organización", album_formats: "formato de disco",
  artist_aliases: "alias de artista", person_aliases: "alias de persona", organization_aliases: "alias de organización",
  album_aliases: "alias de disco", track_aliases: "alias de pista",
};

const MERGE_LABEL: Record<string, string> = {
  artist: "Fusión de artistas", person: "Fusión de personas", organization: "Fusión de organizaciones",
  album: "Fusión de discos", track: "Fusión de pistas",
};

/** Acciones de procesos (CLI, ingesta, revisión) con nombre propio. */
const ACTION_LABEL: Record<string, string> = {
  approve: "Aprobación de revisión",
  dismiss: "Descarte de revisión",
  apply_review_decisions: "Decisiones de revisión aplicadas",
  merge_duplicates: "Fusión de duplicados",
  person_corrections: "Correcciones de personas",
  register_manual_evidence: "Evidencia manual",
  ambiguity_resolve: "Resolución de ambigüedades",
  ambiguity_apply: "Ambigüedades aplicadas",
  ambiguity_scan: "Búsqueda de ambigüedades",
  keep_repeated_tracks: "Pistas repetidas conservadas",
  seed_sources: "Registro de fuentes",
  youtube_import_sheet: "Importación de la hoja de YouTube",
  "api:merge:undo": "Deshacer fusión",
  "api:split:person": "División de persona",
  "api:convert:person": "Persona convertida en organización",
  "curation:resolve-conflict": "Conflicto resuelto",
};

const RUN_KIND_LABEL: Record<string, string> = {
  scrape_source: "Ingesta de una fuente",
  merge_run: "Proceso de fusión",
  seed_yt: "Carga de YouTube",
  yt_api_sync: "Sincronización con YouTube",
  manual: "Cambio manual",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind.replace(/[_-]/gu, " ");
}

/** «Edición de disco», «Fusión de personas», «Deshacer #812»… */
export function changeTitle(change: Pick<ChangeSummary, "action" | "kind" | "undoOf" | "redoOf">): string {
  if (change.redoOf !== null) return `Rehacer #${change.redoOf}`;
  if (change.undoOf !== null) return `Deshacer #${change.undoOf}`;
  const action = (change.action ?? "").replace(/:\d+$/u, "");
  if (ACTION_LABEL[action]) return ACTION_LABEL[action];
  const [origin, verb, kind] = action.split(":");
  if (origin === "api" && kind) {
    if (verb === "update") return `Edición de ${kindLabel(kind)}`;
    if (verb === "create") return `Alta de ${kindLabel(kind)}`;
    if (verb === "delete") return `Retiro de ${kindLabel(kind)}`;
    if (verb === "merge") return MERGE_LABEL[kind] ?? `Fusión de ${kindLabel(kind)}`;
  }
  if (action.startsWith("api:curation:fix")) return `Corrección de Curaduría${kind ? ` (${action.split(":").slice(3).join(":").replace(/_/gu, " ")})` : ""}`;
  if (action) return action.replace(/[_:-]+/gu, " ").replace(/^\w/u, (letter) => letter.toUpperCase());
  return RUN_KIND_LABEL[change.kind] ?? change.kind;
}

const ENTITY_PATH: Partial<Record<ChangeEntityKind, string>> = {
  artist: "/artistas", person: "/personas", organization: "/organizaciones", album: "/discos",
};

/** Enlace a la ficha, o null si no tiene página propia (pistas). */
export function entityHref(kind: string, id: number): string | null {
  const base = ENTITY_PATH[kind as ChangeEntityKind];
  return base ? `${base}/${id}` : null;
}

export const ENTITY_OP_LABEL = { created: "creada", removed: "retirada", changed: "modificada" } as const;
export const UNDO_STEP_LABEL: Record<UndoStep, string> = { restore: "vuelve", revert: "se revierte", remove: "se retira" };

/** Tablas del catálogo (core); el resto son filas internas: evidencia, revisión, conflictos. */
export const isCatalogTable = (table: string): boolean => table.startsWith("public.");

/** «1 edición · 2 bajas» contando solo el catálogo; lo interno aparte. */
export function countsSummary(change: Pick<ChangeSummary, "counts" | "total">): string {
  let created = 0, changed = 0, removed = 0, internal = 0;
  for (const [table, entry] of Object.entries(change.counts)) {
    if (!isCatalogTable(table)) { internal += entry.created + entry.changed + entry.removed; continue; }
    created += entry.created; changed += entry.changed; removed += entry.removed;
  }
  const parts = [
    created ? `${created} alta${created === 1 ? "" : "s"}` : "",
    changed ? `${changed} edición${changed === 1 ? "" : "es"}` : "",
    removed ? `${removed} baja${removed === 1 ? "" : "s"}` : "",
  ].filter(Boolean);
  if (!parts.length && internal) parts.push(`${internal} fila${internal === 1 ? "" : "s"} interna${internal === 1 ? "" : "s"}`);
  return parts.join(" · ");
}
