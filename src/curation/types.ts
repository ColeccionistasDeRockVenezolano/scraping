// CRV · Detector de conflictos de Curaduría — tipos compartidos.
//
// El detector es puro sobre un `CatalogSnapshot` (lo que el catálogo tiene en
// este momento) y devuelve `Finding`s. La persistencia, la API y el vigilante
// de cambios viven aparte (scan.ts, repository.ts, watcher.ts) para que las
// reglas se prueben sin base de datos.

export type Severity = "high" | "medium" | "low";

export type FindingEntityKind =
  | "artist" | "person" | "organization" | "album" | "track"
  | "review" | "conflict";

export interface EntityRef {
  kind: FindingEntityKind;
  id: number | null;
  label: string;
}

/** Un problema concreto, con la evidencia que lo sostiene y qué hacer con él. */
export interface Finding {
  detector: string;
  /** Categoría de la taxonomía; una desconocida termina en «otros». */
  category: string;
  /** Subgrupo dentro del detector; por defecto, el propio detector. */
  signature: string;
  /** Nombre legible del subgrupo cuando no es el del detector. */
  signatureLabel?: string;
  severity: Severity;
  entity: EntityRef;
  field?: string;
  value?: string;
  title: string;
  suggestion?: string;
  /** Reemplazo determinista de `value` que una herramienta puede aplicar sin criterio humano adicional. */
  suggestedValue?: string;
  related: EntityRef[];
  /**
   * Hallazgo sobre un PAR de fichas del mismo tipo (duplicados): ids `[menor, mayor]`.
   * La huella sale del par, no del valor ni del resto del grupo, para que una
   * decisión sobre el par sobreviva a un renombrado o a un tercer miembro.
   */
  pair?: [number, number];
  /** Hechos verificables; `span` marca el tramo problemático de `value`. */
  evidence: Record<string, unknown>;
}

export interface SnapshotArtist { id: number; name: string; originCity: string | null; formedYear: number | null; disbandedYear: number | null; }
export interface SnapshotPerson { id: number; name: string; }
export interface SnapshotOrganization { id: number; name: string; type: string; }
export interface SnapshotAlbum { id: number; artistId: number; title: string; releaseYear: number | null; albumType: string; }
export interface SnapshotTrack { id: number; albumId: number; disc: number; number: number; title: string; durationSeconds: number | null; }
export interface SnapshotCreditRole { role: string; creditType: string; uses: number; }

export interface SnapshotReview {
  id: number;
  kind: string;
  status: string;
  priority: number;
  notes: string | null;
  payload: unknown;
  createdAt: string;
  refs: Partial<Record<"artistA" | "artistB" | "personA" | "personB" | "organizationA" | "organizationB" | "album" | "track" | "conflict", number>>;
}

export interface SnapshotConflict {
  id: number;
  entityKind: string;
  field: string;
  valueA: unknown;
  valueB: unknown;
  targetId: number | null;
  hasLiveReview: boolean;
}

export interface CatalogSnapshot {
  takenAt: Date;
  artists: SnapshotArtist[];
  persons: SnapshotPerson[];
  organizations: SnapshotOrganization[];
  albums: SnapshotAlbum[];
  tracks: SnapshotTrack[];
  creditRoles: SnapshotCreditRole[];
  /** Artistas con los que cada persona tiene vínculo (membresía o crédito). */
  personArtists: Map<number, Set<number>>;
  /** Cuántos vínculos tiene cada ficha (0 = huérfana). */
  personLinks: Map<number, number>;
  organizationLinks: Map<number, number>;
  artistLinks: Map<number, number>;
  /** Revisiones vivas de la cola (open/in_progress). */
  reviews: SnapshotReview[];
  /** Conflictos de campo abiertos. */
  conflicts: SnapshotConflict[];
  /** Pares ya tratados por otra herramienta o declarados distintos: `person:a-b`, `album:a-b` (a<b). */
  handledPairs: Set<string>;
  /** Solo los declarados distintos por una persona (`ingest.curation_distinct_pairs`), con la misma clave. */
  distinctPairs: Set<string>;
}

export interface CategoryDefinition {
  key: string;
  label: string;
  description: string;
}

export interface DetectorDefinition {
  key: string;
  category: string;
  label: string;
  description: string;
}
