// CRV · Enums del schema `ingest`, en módulo propio para romper el ciclo de
// imports entre ingest.ts (necesita media.youtubeVideos) y media.ts
// (necesita ingest.confidence_level para video_artists/video_albums/video_tracks).
import { pgSchema } from "drizzle-orm/pg-core";

export const ingestSchema = pgSchema("ingest");

export const trustLevelEnum = ingestSchema.enum("trust_level", ["high", "medium", "low", "api"]);
export const runKindEnum = ingestSchema.enum("run_kind", [
  "scrape_source", "seed_yt", "yt_api_sync", "enrich_artist", "merge_run", "manual",
]);
export const runStatusEnum = ingestSchema.enum("run_status", ["running", "ok", "partial", "failed"]);
export const confidenceLevelEnum = ingestSchema.enum("confidence_level", ["high", "medium", "low"]);

export const claimStatusEnum = ingestSchema.enum("claim_status", [
  "candidate", "accepted", "rejected", "conflict", "superseded",
]);
// 0008 añade `media_link`: el arte que no cabe en `albums.cover_url` ni en
// `artists.picture_url`, que son una sola imagen cada una.
export const claimEntityKindEnum = ingestSchema.enum("claim_entity_kind", [
  "artist", "person", "organization", "album", "track", "artist_membership",
  "person_organization", "album_credit", "track_credit", "album_format", "youtube_video",
  "media_link",
]);
export const actorKindEnum = ingestSchema.enum("actor_kind", ["system", "ai", "human"]);

// review_kind: 8 valores de 0003 + 8 de 0004 (CONTRACT §11.1).
export const reviewKindEnum = ingestSchema.enum("review_kind", [
  "possible_duplicate", "field_conflict", "ambiguous_alias", "album_match",
  "person_match", "organization_match", "youtube_match", "manual_review",
  "missing_url", "seed_incomplete", "media_type_no_album", "genre_unknown",
  "new_source", "low_confidence", "ai_biography", "ai_entity_resolution",
]);
export const reviewStatusEnum = ingestSchema.enum("review_status", ["open", "in_progress", "approved", "dismissed"]);
export const aliasTypeEnum = ingestSchema.enum("alias_type", [
  "name_variant", "spelling_variant", "former_name", "stage_name",
  "acronym", "misspelling", "alternate_title", "other",
]);
export const conflictStatusEnum = ingestSchema.enum("conflict_status", [
  "open", "resolved_a", "resolved_b", "both_kept", "dismissed",
]);
