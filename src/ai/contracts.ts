import { z } from "zod";

export const aiResolutionProposalSchema = z.object({
  same_entity_probability: z.number().min(0).max(1),
  recommended_action: z.enum(["MATCH", "KEEP_SEPARATE", "REVIEW"]),
  evidence_for: z.array(z.string().min(1).max(1_000)).max(30),
  evidence_against: z.array(z.string().min(1).max(1_000)).max(30),
  uncertainties: z.array(z.string().min(1).max(1_000)).max(30),
}).strict();

export const aiConflictProposalSchema = z.object({
  same_entity_probability: z.number().min(0).max(1),
  recommended_action: z.enum(["KEEP_A", "KEEP_B", "KEEP_BOTH", "REVIEW"]),
  evidence_for: z.array(z.string().min(1).max(1_000)).max(30),
  evidence_against: z.array(z.string().min(1).max(1_000)).max(30),
  uncertainties: z.array(z.string().min(1).max(1_000)).max(30),
}).strict();

export const aiNarrativeExtractionSchema = z.object({
  proposals: z.array(z.object({
    entity_kind: z.enum(["ARTIST", "PERSON", "ALBUM", "TRACK", "ORGANIZATION"]),
    field: z.string().min(1).max(80),
    value: z.unknown(),
    evidence_excerpt: z.string().min(1).max(2_000),
    uncertainty: z.string().max(1_000),
  }).strict()).max(100),
  uncertainties: z.array(z.string().min(1).max(1_000)).max(30),
}).strict();

export const aiSemanticNormalizationSchema = z.object({
  normalized_value: z.unknown(),
  rationale: z.string().min(1).max(2_000),
  uncertainties: z.array(z.string().min(1).max(1_000)).max(30),
}).strict();

export const aiBiographyDraftSchema = z.object({
  paragraphs: z.array(z.object({
    text: z.string().min(1).max(5_000),
    claim_ids: z.array(z.number().int().positive()).min(1).max(100),
  }).strict()).min(1).max(30),
  uncertainties: z.array(z.string().min(1).max(1_000)).max(30),
}).strict();

export type AiResolutionProposal = z.infer<typeof aiResolutionProposalSchema>;
export type AiConflictProposal = z.infer<typeof aiConflictProposalSchema>;
export type AiBiographyDraft = z.infer<typeof aiBiographyDraftSchema>;

