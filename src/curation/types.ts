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
export interface SnapshotAlbum { id: number; artistId: number; title: string; releaseYear: number | null; albumType: string; labelId?: number | null; }
export interface SnapshotTrack { id: number; albumId: number; disc: number; number: number; title: string; durationSeconds: number | null; }
export interface SnapshotCreditRole { role: string; creditType: string; uses: number; }

/** Filas relacionales que solo necesita el análisis completo de E11. */
export interface SnapshotCredit {
  id: number;
  parentKind: "album" | "track";
  parentId: number;
  personId: number | null;
  artistId: number | null;
  organizationId: number | null;
  creditType: string;
  role: string;
}
export interface SnapshotMembership {
  id: number;
  artistId: number;
  personId: number;
  role: string;
  fromYear: number | null;
  toYear: number | null;
  isCurrent: boolean;
}
export interface SnapshotAlias {
  id: number;
  kind: "artist" | "person" | "organization" | "album" | "track";
  entityId: number;
  alias: string;
  normalizedAlias: string;
}
export interface SnapshotRedirect {
  kind: "artist" | "person" | "organization" | "album" | "track";
  fromId: number;
  toId: number;
}
export interface SnapshotMediaLink {
  id: number;
  entityKind: string;
  artistId: number | null;
  personId: number | null;
  organizationId: number | null;
  albumId: number | null;
  url: string;
  mediaType: string;
}

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

/** Evidencia de un lado del conflicto: qué fuente lo afirma y con qué respaldo (PLAN_CURADURIA E7.1). */
export interface ConflictSourceEvidence {
  name: string;
  trustLevel: string;
  url: string | null;
  at: string;
}

export interface SnapshotConflict {
  id: number;
  entityKind: string;
  field: string;
  valueA: unknown;
  valueB: unknown;
  targetId: number | null;
  hasLiveReview: boolean;
  sourceA: ConflictSourceEvidence;
  sourceB: ConflictSourceEvidence;
}

export interface CatalogSnapshot {
  takenAt: Date;
  artists: SnapshotArtist[];
  persons: SnapshotPerson[];
  organizations: SnapshotOrganization[];
  albums: SnapshotAlbum[];
  tracks: SnapshotTrack[];
  creditRoles: SnapshotCreditRole[];
  /**
   * Relaciones globales de E11. Son opcionales para mantener pequeños los
   * fixtures y las fotos dirigidas de E9; los detectores E11 solo corren en
   * análisis completos y tratan la ausencia como conjunto vacío.
   */
  credits?: SnapshotCredit[];
  memberships?: SnapshotMembership[];
  aliases?: SnapshotAlias[];
  redirects?: SnapshotRedirect[];
  mediaLinks?: SnapshotMediaLink[];
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
  /**
   * Acciones de corrección que propone, por subgrupo (PLAN_CURADURIA E4.1):
   * clave = `signature`, o `*` para todos sus subgrupos. Claves del registro
   * `src/curation/actions/registry.ts`. Sin acciones = nivel 3 (manual).
   */
  actions?: Readonly<Record<string, readonly string[]>>;
}
