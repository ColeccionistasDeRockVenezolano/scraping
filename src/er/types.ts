import { z } from "zod";

export const resolutionEntityKindSchema = z.enum(["ARTIST", "PERSON", "ALBUM", "TRACK", "ORGANIZATION"]);
export type ResolutionEntityKind = z.infer<typeof resolutionEntityKindSchema>;

export const aliasKindSchema = z.enum([
  "name_variant", "spelling_variant", "former_name", "stage_name", "nickname",
  "acronym", "misspelling", "alternate_title", "other",
]);

export interface ResolutionAlias {
  value: string;
  type?: z.infer<typeof aliasKindSchema>;
  confidence?: "high" | "medium" | "low";
}

export interface YearRange { from?: number; to?: number; }
export interface LocationContext { city?: string; country?: string; }
export interface ParentReference { id?: number; name?: string; artistName?: string; }

interface BaseResolutionInput {
  kind: ResolutionEntityKind;
  /** Nombre/titulo tal como llego. Nunca se reemplaza por una match-key. */
  name: string;
  aliases?: ResolutionAlias[];
}

export interface ArtistResolutionInput extends BaseResolutionInput {
  kind: "ARTIST";
  activeYears?: YearRange;
  origin?: LocationContext;
  members?: string[];
  discography?: string[];
}

export interface PersonResolutionInput extends BaseResolutionInput {
  kind: "PERSON";
  nicknames?: string[];
  bands?: string[];
  period?: YearRange;
  instruments?: string[];
  roles?: string[];
  albumCredits?: string[];
}

export interface AlbumResolutionInput extends BaseResolutionInput {
  kind: "ALBUM";
  artist?: ParentReference;
  year?: number;
  releaseType?: string;
  tracklist?: string[];
}

export interface TrackResolutionInput extends BaseResolutionInput {
  kind: "TRACK";
  album?: ParentReference;
  disc?: number;
  trackNumber?: number;
}

export interface OrganizationResolutionInput extends BaseResolutionInput {
  kind: "ORGANIZATION";
  organizationType?: string;
  location?: LocationContext;
  associatedAlbums?: string[];
  associatedPersons?: string[];
}

export type ResolutionInput =
  | ArtistResolutionInput
  | PersonResolutionInput
  | AlbumResolutionInput
  | TrackResolutionInput
  | OrganizationResolutionInput;

/** Un candidato usa el mismo contexto, mas su ID y nombre canonico. */
export type ResolutionCandidate = ResolutionInput & {
  id: number;
  canonicalName: string;
};

export type ResolutionAction = "AUTO_MATCH" | "POSSIBLE_MATCH" | "REVIEW" | "NO_MATCH";

export interface ResolutionThresholds {
  AUTO_MATCH: number;
  POSSIBLE_MATCH: number;
  REVIEW: number;
  NO_MATCH: number;
  minimumMargin: number;
}

export const resolutionThresholdsSchema = z.object({
  AUTO_MATCH: z.number().min(0).max(1),
  POSSIBLE_MATCH: z.number().min(0).max(1),
  REVIEW: z.number().min(0).max(1),
  NO_MATCH: z.number().min(0).max(1),
  minimumMargin: z.number().min(0).max(1),
}).strict().superRefine((value, ctx) => {
  if (!(value.AUTO_MATCH > value.POSSIBLE_MATCH
    && value.POSSIBLE_MATCH > value.REVIEW
    && value.REVIEW > value.NO_MATCH)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "los thresholds deben cumplir AUTO_MATCH > POSSIBLE_MATCH > REVIEW > NO_MATCH" });
  }
});

export const DEFAULT_RESOLUTION_THRESHOLDS: ResolutionThresholds = Object.freeze({
  AUTO_MATCH: 0.9,
  POSSIBLE_MATCH: 0.72,
  REVIEW: 0.5,
  NO_MATCH: 0,
  minimumMargin: 0.08,
});

export interface ScoreFeature {
  /** Clave estable para tests, auditoria y UI. */
  key: string;
  label: string;
  value: number;
  weight: number;
  contribution: number;
  polarity: "for" | "against" | "neutral";
  evidence: string;
}

export interface CandidateScore {
  candidateId: number;
  canonicalName: string;
  score: number;
  action: ResolutionAction;
  features: ScoreFeature[];
  hardConflicts: string[];
  nameBasis: "canonical_exact" | "alias_exact" | "article_variant" | "accent_only" | "fuzzy" | "none";
  hasContextSupport: boolean;
  autoEligible: boolean;
}

export interface AiResolutionProposal {
  same_entity_probability: number;
  recommended_action: "MATCH" | "KEEP_SEPARATE" | "REVIEW";
  evidence_for: string[];
  evidence_against: string[];
  uncertainties: string[];
}

export interface ResolutionDecision {
  kind: ResolutionEntityKind;
  inputOriginal: string;
  inputNormalized: string;
  action: ResolutionAction;
  score: number;
  candidateId?: number;
  features: ScoreFeature[];
  candidates: CandidateScore[];
  thresholds: ResolutionThresholds;
  explanation: string;
  deterministic: true;
  aiProposal?: AiResolutionProposal;
  aiRunId?: number;
  /** El arbitraje opcional fallo/rechazo; nunca cambia la accion determinista. */
  aiFailure?: string;
}
