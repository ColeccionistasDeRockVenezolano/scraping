// CRV · Tipos que reflejan las respuestas de la API (src/api/routes/*.ts,
// src/api/schemas.ts). Un solo lugar para no repetir las formas en cada página.

export interface Page<T> {
  data: T[];
  pagination: { limit: number; offset: number; total: number };
}

export interface Alias {
  id: number;
  alias: string;
  aliasType: string;
  isPrimary: boolean;
}

export type SearchEntityType = "artist" | "person" | "album" | "track" | "organization";

export interface SearchHit {
  type: SearchEntityType;
  id: number;
  label: string;
  context: string | null;
  albumId: number | null;
}

export type SearchResults = Record<SearchEntityType, SearchHit[]>;

// ---------- artists ----------
export interface ArtistListItem {
  id: number;
  name: string;
  artistType: string;
  originCity: string | null;
  originCountry: string;
  formedYear: number | null;
  disbandedYear: number | null;
  pictureUrl: string | null;
}

export interface ArtistMember {
  id: number; personId: number; personName: string; role: string;
  fromYear: number | null; toYear: number | null; isCurrent: boolean;
}

export interface DiscographyItem {
  albumId: number; title: string; releaseYear: number | null; albumType: string; coverUrl: string | null;
}

export interface ArtistDetail extends ArtistListItem {
  biography: string | null;
  notes: string | null;
  members: ArtistMember[];
  discography: DiscographyItem[];
  aliases: Alias[];
}

// ---------- albums ----------
export interface AlbumListItem {
  id: number;
  title: string;
  releaseYear: number | null;
  albumType: string;
  artistId: number;
  artistName: string;
  coverUrl: string | null;
}

export interface Credit {
  id: number;
  creditType: string;
  role: string;
  personId: number | null; personName: string | null;
  artistId: number | null; artistName: string | null;
  organizationId: number | null; organizationName: string | null;
}

export interface Track {
  id: number;
  discNumber: number;
  trackNumber: number;
  title: string;
  durationSeconds: number | null;
  youtubeStartSeconds: number | null;
  credits: Credit[];
}

export interface AlbumFormat { id: number; format: string; quality: string | null; archiveStatus: string; }

export interface YoutubeLink { videoId: string; title: string | null; kind: string; isPrimaryLink: boolean; }

export interface AlbumDetail {
  id: number;
  title: string;
  releaseYear: number | null;
  albumType: string;
  genre: string | null;
  coverUrl: string | null;
  description: string | null;
  notes: string | null;
  youtubeUrl: string | null;
  youtubeStatus: string;
  instagramUrl: string | null;
  instagramStatus: string;
  wordpressUrl: string | null;
  wordpressStatus: string;
  artist: { id: number; name: string };
  label: { id: number; name: string } | null;
  tracklist: Track[];
  credits: Credit[];
  creditsByType: Record<string, Credit[]>;
  formats: AlbumFormat[];
  aliases: Alias[];
  youtubeLinks: YoutubeLink[];
}

// ---------- persons ----------
export interface PersonListItem {
  id: number;
  name: string;
  nationality: string | null;
  isVenezuelan: boolean;
  pictureUrl: string | null;
  /** Créditos de disco y de pista (E11.9). */
  creditCount: number;
  /** Membresías de banda (E11.9). */
  bandCount: number;
  /** Clasificación del nombre (E11.7): si no es `ok`, la ficha avisa y ofrece convertir o dividir. */
  nameClass: PersonNameClass;
  nameClassReason: string;
}

export type PersonNameClass = "ok" | "organization_like" | "duration" | "fragment" | "multiple_people";

export interface PersonBand {
  id: number; artistId: number; artistName: string; role: string;
  fromYear: number | null; toYear: number | null; isCurrent: boolean;
}
export interface PersonAlbumCredit { id: number; albumId: number; albumTitle: string; artistId: number; artistName: string; creditType: string; role: string; }
export interface PersonTrackCredit { id: number; trackId: number; trackTitle: string; albumId: number; albumTitle: string; creditType: string; role: string; }
export interface PersonOrganization { id: number; organizationId: number; organizationName: string; role: string; fromYear: number | null; toYear: number | null; }

export interface PersonDetail extends PersonListItem {
  biography: string | null;
  birthDate: string | null;
  deathDate: string | null;
  notes: string | null;
  bands: PersonBand[];
  albumCredits: PersonAlbumCredit[];
  trackCredits: PersonTrackCredit[];
  organizations: PersonOrganization[];
  aliases: Alias[];
}

// ---------- fusión de fichas (E11.3/E11.4/E11.5/E11.10) ----------
/** Fichas navegables con fusión con previsualización: persona, organización y artista. */
export type MergeableKind = "person" | "organization" | "artist";
/** Campos fusionables: dependen del kind (los publica la API en cada previsualización). */
export type PersonMergeField = string;

export interface PersonMergeSide {
  id: number;
  name: string;
  fields: Record<string, unknown>;
  aliases: string[];
  counts: { bands: number; albumCredits: number; trackCredits: number; organizations: number; claims: number };
}

export interface PersonMergeConflict {
  field: PersonMergeField;
  keepValue: unknown;
  dropValue: unknown;
}

export interface PersonMergePreview {
  kind: MergeableKind;
  keep: PersonMergeSide;
  drop: PersonMergeSide;
  recommendedKeepId: number;
  fieldConflicts: PersonMergeConflict[];
  fieldsFilledFromDrop: string[];
  sharedBands: Array<{ id: number; name: string }>;
  sharedAlbums: Array<{ id: number; title: string }>;
  aliasesToAdd: string[];
  reviewsBetween: number[];
  warnings: string[];
  previewHash: string;
}

export interface PersonMergeResult {
  kind: MergeableKind;
  keepId: number;
  dropId: number;
  auditId: number;
  moved: number;
  discarded: number;
  filled: string[];
  fieldsCorrected: string[];
  creditsMerged: number;
  membershipsMerged: number;
  runId: number;
}

export interface PersonDuplicateCandidate {
  reviewId: number;
  a: { id: number; name: string; creditCount: number };
  b: { id: number; name: string; creditCount: number };
  priority: number;
  score: number | null;
  features: Array<{ key: string; value: number; evidence: string }>;
  notes: string | null;
  createdAt: string;
}

export interface PersonConversionResult {
  op: string;
  status: "applied" | "skipped";
  detail: string;
  credits: number;
  targetKind: "organization" | "artist";
  targetId: number;
  runId: number;
}

export interface UnmergeResult {
  runId: number;
  mergeRunId: number;
  restored: Array<{ kind: string; id: number }>;
  /** Correcciones de campo del run de fusión: se informan, no se revierten. */
  fieldsNotReverted: string[];
}

// ---------- organizations ----------
export interface OrganizationListItem {
  id: number;
  name: string;
  organizationType: string;
  country: string | null;
}

export interface LabelAlbum { albumId: number; title: string; releaseYear: number | null; artistId: number; artistName: string; }
export interface CreditedArtist { artistId: number; artistName: string; }
export interface AssociatedPerson { id: number; personId: number; personName: string; role: string; fromYear: number | null; toYear: number | null; }

export interface OrganizationDetail extends OrganizationListItem {
  biography: string | null;
  pictureUrl: string | null;
  websiteUrl: string | null;
  notes: string | null;
  labelAlbums: LabelAlbum[];
  creditedArtists: CreditedArtist[];
  associatedPersons: AssociatedPerson[];
  aliases: Alias[];
}

// ---------- review queue ----------
export interface ReviewListItem {
  id: number;
  kind: string;
  status: string;
  priority: number;
  notes: string | null;
  createdAt: string;
}

export interface ReviewDetail extends ReviewListItem {
  claimAId: number | null; claimBId: number | null; conflictId: number | null;
  artistAId: number | null; artistBId: number | null;
  personAId: number | null; personBId: number | null;
  organizationAId: number | null; organizationBId: number | null;
  albumId: number | null; trackId: number | null; videoId: number | null;
  payload: unknown;
  resolvedAt: string | null; resolvedBy: string | null; resolutionNote: string | null;
  claims: Array<{
    id: number; field: string; rawValue: unknown; normalizedValue: unknown; confidence: string; status: string;
    sourceName: string; sourceUrl: string | null; evidenceUrl: string | null;
  }>;
}

export interface ReviewActionResult {
  reviewId: number; kind: string; action: "accepted" | "rejected" | "resolved"; runId: number; status: string; detail: string;
}

// ---------- sources / claims / audit / youtube ----------
export interface Source {
  id: number; slug: string; name: string; url: string | null; siteType: string;
  accessStrategy: string | null; requiresJs: boolean; trustLevel: string; enabled: boolean;
  publicDisplay: boolean; notes: string | null;
}

export interface Claim {
  id: number; entityKind: string; field: string; rawValue: unknown; normalizedValue: unknown;
  confidence: string; status: string; sourceId: number; sourceName: string; createdAt: string;
}

export interface AuditRow {
  id: number; runId: number | null; field: string; oldValue: unknown; newValue: unknown;
  reason: string; confidence: string; performedBy: string; at: string; claimIds: number[];
}

export interface VideoListItem {
  id: number; videoId: string; title: string | null; channelTitle: string | null;
  publishedAt: string | null; durationSeconds: number | null; publicationStatus: string;
}

export interface VideoDetail extends VideoListItem {
  url: string | null; description: string | null; channelId: string | null; thumbnailUrl: string | null;
  artists: Array<{ artistId: number; artistName: string; relationKind: string; confidence: string }>;
  albums: Array<{ albumId: number; title: string; albumKind: string; isPrimaryLink: boolean; confidence: string }>;
  tracks: Array<{ trackId: number; title: string; albumId: number; albumTitle: string; startSeconds: number; endSeconds: number | null; confidence: string }>;
}

// ---------- write results ----------
export interface FieldWrite { field: string; action: "applied" | "unchanged" | "corrected"; conflictsClosed: number[]; }
export interface EntityWriteResult { kind: string; id: number; runId: number; fields: FieldWrite[]; }
export interface RelationWriteResult { kind: string; id: number; runId: number; created: boolean; }
export interface RelationUpdateResult { kind: string; id: number; runId: number; fields: Array<{ field: string; action: "corrected" | "unchanged" }>; }
export interface RemovalResult { kind: string; id: number; runId: number; claimsRejected: number[]; parentAuditId: number | null; }
export interface AliasWriteResult extends Alias { entityId: number; runId: number; }

export type EntityKind = "artist" | "person" | "organization" | "album" | "track";

// ---------- curaduría: detector de conflictos ----------
export type CurationSeverity = "high" | "medium" | "low";
export type CurationFindingStatus = "open" | "ignored" | "resolved";
/** Por qué se resolvió un hallazgo (src/curation/resolution.ts). */
export type CurationResolution = "fixed_by_curation" | "changed_elsewhere" | "entity_removed" | "rules_changed" | "declared_distinct";
/** Por qué una persona dijo «no es un problema» (src/curation/repository.ts). */
export type CurationIgnoreReason = "falso_positivo" | "correcto_a_proposito" | "fuera_de_alcance";
export type CurationPairKind = "artist" | "person" | "organization" | "album" | "track";

export interface CurationEntityRef { kind: string; id: number | null; label: string; }

export interface CurationScan {
  id: number;
  status: string;
  trigger: string;
  requestedBy: string | null;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  counters: Record<string, unknown>;
}

export interface CurationSignatureSummary { key: string; label: string; open: number; }
export interface CurationDetectorSummary {
  key: string; label: string; description: string;
  open: number; ignored: number; resolved: number; newInLastScan: number;
  signatures: CurationSignatureSummary[];
}
export interface CurationCategorySummary {
  key: string; label: string; description: string;
  open: number; ignored: number; resolved: number; newInLastScan: number; chainedOpen: number;
  severity: Record<CurationSeverity, number>;
  detectors: CurationDetectorSummary[];
}
export interface CurationSummary {
  lastScan: CurationScan | null;
  lastCorrection: CurationScan | null;
  running: boolean;
  totals: { open: number; ignored: number; resolved: number; newInLastScan: number; chainedOpen: number };
  categories: CurationCategorySummary[];
}

export interface CurationFinding {
  id: number;
  category: string;
  detector: string;
  detectorLabel: string;
  signature: string;
  signatureLabel: string;
  severity: CurationSeverity;
  entity: CurationEntityRef;
  field: string | null;
  value: string | null;
  title: string;
  suggestion: string | null;
  suggestedValue: string | null;
  related: CurationEntityRef[];
  evidence: Record<string, unknown>;
  status: CurationFindingStatus;
  isNew: boolean;
  triggeredBy: Array<{ id: number; title: string; entityKind: string; entityId: number | null }>;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  ignoredAt: string | null;
  ignoredBy: string | null;
  ignoreNote: string | null;
  ignoreReason: CurationIgnoreReason | null;
  resolution: CurationResolution | null;
  resolvedByRunId: number | null;
  resolvedBy: string | null;
}

export interface CurationFixOutcome {
  id: number;
  ok: boolean;
  error: string | null;
}

export interface CurationFixBatchResult {
  outcomes: CurationFixOutcome[];
  fixed: number;
  failed: number;
  more?: boolean;
}

export interface CurationScanResult {
  scanId: number | null;
  /** partial = algún detector falló (sus hallazgos no se tocaron); skipped = otro proceso estaba analizando. */
  status: "ok" | "partial" | "skipped" | "failed";
  trigger: string;
  dryRun: boolean;
  durationMs: number;
  catalogSignature: string;
  total: number;
  inserted: number;
  reopened: number;
  resolved: number;
  chained: number;
  byCategory: Record<string, number>;
  failures: Array<{ detector: string; error: string }>;
  error?: string;
}
