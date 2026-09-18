// CRV · Schema tipado (Drizzle) del schema auxiliar `ingest`.
//
// El DDL real vive en migrations/000N_*.up.sql (aplicado por
// src/db/migrate.ts, que conserva el harness ingest.schema_migrations).
// Este archivo describe las mismas columnas para queries tipadas; los
// nombres y tipos deben mantenerse en sincronía manual con las migraciones
// (no hay drizzle-kit push/generate en este proyecto: ver src/db/migrate.ts).
import {
  bigint,
  boolean,
  integer,
  jsonb,
  real,
  smallint,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { albums, artistMembers, artists, albumCredits, albumFormats, organizations, persons, personOrganizations, trackCredits, tracks } from "./core.js";
import { mediaLinks, youtubeVideos } from "./media.js";
import {
  ingestSchema as ingest,
  trustLevelEnum,
  runKindEnum,
  runStatusEnum,
  confidenceLevelEnum,
  claimStatusEnum,
  claimEntityKindEnum,
  actorKindEnum,
  reviewKindEnum,
  reviewStatusEnum,
  aliasTypeEnum,
  conflictStatusEnum,
} from "./ingest-enums.js";

// Los enums de ingest viven en ./ingest-enums.js (rompe el ciclo con media.ts,
// que también necesita confidence_level). Re-exportados aquí para que el
// resto del código pueda seguir importando "./ingest.js" como punto único.
export {
  ingest,
  trustLevelEnum, runKindEnum, runStatusEnum, confidenceLevelEnum,
  claimStatusEnum, claimEntityKindEnum, actorKindEnum, reviewKindEnum,
  reviewStatusEnum, aliasTypeEnum, conflictStatusEnum,
};

// --- Tablas (0001) ---
export const sources = ingest.table("sources", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  slug: varchar("slug", { length: 80 }).notNull(),
  name: varchar("name", { length: 200 }).notNull(),
  url: text("url"),
  siteType: varchar("site_type", { length: 40 }).notNull().default("website"),
  accessStrategy: text("access_strategy"),
  requiresJs: boolean("requires_js").notNull().default(false),
  trustLevel: trustLevelEnum("trust_level").notNull().default("low"),
  enabled: boolean("enabled").notNull().default(false),
  publicDisplay: boolean("public_display").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const rawPages = ingest.table("raw_pages", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  sourceId: bigint("source_id", { mode: "number" }).notNull().references(() => sources.id),
  url: text("url").notNull(),
  canonicalUrl: text("canonical_url"),
  httpStatus: smallint("http_status"),
  contentType: varchar("content_type", { length: 120 }),
  sha256: varchar("sha256", { length: 64 }).notNull(),
  byteSize: bigint("byte_size", { mode: "number" }),
  storedPath: text("stored_path").notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
  headers: jsonb("headers"),
  runId: bigint("run_id", { mode: "number" }).references(() => scrapeRuns.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scrapeRuns = ingest.table("scrape_runs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  kind: runKindEnum("kind").notNull(),
  sourceId: bigint("source_id", { mode: "number" }).references(() => sources.id, { onDelete: "set null" }),
  status: runStatusEnum("status").notNull().default("running"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  params: jsonb("params"),
  counters: jsonb("counters"),
  errorLog: text("error_log"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const scrapeErrors = ingest.table("scrape_errors", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  runId: bigint("run_id", { mode: "number" }).notNull().references(() => scrapeRuns.id, { onDelete: "cascade" }),
  rawPageId: bigint("raw_page_id", { mode: "number" }).references(() => rawPages.id, { onDelete: "set null" }),
  url: text("url").notNull(),
  errorKind: varchar("error_kind", { length: 40 }).notNull(),
  message: text("message").notNull(),
  retryCount: smallint("retry_count").notNull().default(0),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
});

export const seedUploads = ingest.table("seed_uploads", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  uploadOrder: smallint("upload_order").notNull(),
  artistNameRaw: varchar("artist_name_raw", { length: 200 }),
  albumNameRaw: varchar("album_name_raw", { length: 250 }),
  albumYearRaw: smallint("album_year_raw"),
  typeRaw: varchar("type_raw", { length: 200 }),
  urlRaw: text("url_raw"),
  statusRaw: varchar("status_raw", { length: 40 }),
  videoId: varchar("video_id", { length: 11 }),
  rowNumber: smallint("row_number"),
  rowHash: varchar("row_hash", { length: 64 }).notNull(),
  contentKind: varchar("content_kind", { length: 12 }),
  normalizedType: varchar("normalized_type", { length: 40 }),
  classificationReason: text("classification_reason"),
  runId: bigint("run_id", { mode: "number" }).references(() => scrapeRuns.id, { onDelete: "set null" }),
  importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
});

export const genres = ingest.table("genres", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 100 }).notNull(),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
});

// --- Tablas (0003): claims / evidencia / identidad / conflictos / review / auditoría ---
export const claims = ingest.table("claims", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  sourceId: bigint("source_id", { mode: "number" }).notNull().references(() => sources.id),
  rawPageId: bigint("raw_page_id", { mode: "number" }).references(() => rawPages.id, { onDelete: "set null" }),
  seedUploadId: bigint("seed_upload_id", { mode: "number" }).references(() => seedUploads.id, { onDelete: "set null" }),
  entityKind: claimEntityKindEnum("entity_kind").notNull(),
  artistId: bigint("artist_id", { mode: "number" }).references(() => artists.id, { onDelete: "cascade" }),
  personId: bigint("person_id", { mode: "number" }).references(() => persons.id, { onDelete: "cascade" }),
  organizationId: bigint("organization_id", { mode: "number" }).references(() => organizations.id, { onDelete: "cascade" }),
  albumId: bigint("album_id", { mode: "number" }).references(() => albums.id, { onDelete: "cascade" }),
  trackId: bigint("track_id", { mode: "number" }).references(() => tracks.id, { onDelete: "cascade" }),
  artistMembershipId: bigint("artist_membership_id", { mode: "number" }).references(() => artistMembers.id, { onDelete: "cascade" }),
  personOrganizationId: bigint("person_organization_id", { mode: "number" }).references(() => personOrganizations.id, { onDelete: "cascade" }),
  albumCreditId: bigint("album_credit_id", { mode: "number" }).references(() => albumCredits.id, { onDelete: "cascade" }),
  trackCreditId: bigint("track_credit_id", { mode: "number" }).references(() => trackCredits.id, { onDelete: "cascade" }),
  albumFormatId: bigint("album_format_id", { mode: "number" }).references(() => albumFormats.id, { onDelete: "cascade" }),
  videoId: bigint("video_id", { mode: "number" }).references(() => youtubeVideos.id, { onDelete: "cascade" }),
  mediaLinkId: bigint("media_link_id", { mode: "number" }).references(() => mediaLinks.id, { onDelete: "set null" }),
  field: varchar("field", { length: 80 }).notNull(),
  rawValue: jsonb("raw_value").notNull(),
  normalizedValue: jsonb("normalized_value"),
  rawHash: varchar("raw_hash", { length: 64 }).notNull(),
  extractor: varchar("extractor", { length: 80 }),
  extractorVersion: varchar("extractor_version", { length: 40 }),
  confidence: confidenceLevelEnum("confidence").notNull().default("low"),
  status: claimStatusEnum("status").notNull().default("candidate"),
  createdBy: actorKindEnum("created_by").notNull().default("system"),
  runId: bigint("run_id", { mode: "number" }).references(() => scrapeRuns.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  identityRaw: text("identity_raw"),
  identityKey: text("identity_key"),
  identitySecondaryKey: text("identity_secondary_key"),
});

export const claimEvidence = ingest.table("claim_evidence", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  claimId: bigint("claim_id", { mode: "number" }).notNull().references(() => claims.id, { onDelete: "cascade" }),
  rawPageId: bigint("raw_page_id", { mode: "number" }).references(() => rawPages.id, { onDelete: "set null" }),
  seedUploadId: bigint("seed_upload_id", { mode: "number" }).references(() => seedUploads.id, { onDelete: "set null" }),
  url: text("url"),
  excerpt: text("excerpt"),
  selector: varchar("selector", { length: 300 }),
  position: integer("position"),
  evidenceHash: varchar("evidence_hash", { length: 64 }).notNull(),
  capturedAt: timestamp("captured_at", { withTimezone: true }).notNull().defaultNow(),
});

export const artistAliases = ingest.table("artist_aliases", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  artistId: bigint("artist_id", { mode: "number" }).notNull().references(() => artists.id, { onDelete: "cascade" }),
  alias: varchar("alias", { length: 200 }).notNull(),
  aliasType: aliasTypeEnum("alias_type").notNull().default("name_variant"),
  normalizedAlias: varchar("normalized_alias", { length: 200 }).notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  confidence: confidenceLevelEnum("confidence").notNull().default("medium"),
  sourceId: bigint("source_id", { mode: "number" }).references(() => sources.id, { onDelete: "set null" }),
  rawPageId: bigint("raw_page_id", { mode: "number" }).references(() => rawPages.id, { onDelete: "set null" }),
  claimId: bigint("claim_id", { mode: "number" }).references(() => claims.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const personAliases = ingest.table("person_aliases", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  personId: bigint("person_id", { mode: "number" }).notNull().references(() => persons.id, { onDelete: "cascade" }),
  alias: varchar("alias", { length: 200 }).notNull(),
  aliasType: aliasTypeEnum("alias_type").notNull().default("name_variant"),
  normalizedAlias: varchar("normalized_alias", { length: 200 }).notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  confidence: confidenceLevelEnum("confidence").notNull().default("medium"),
  sourceId: bigint("source_id", { mode: "number" }).references(() => sources.id, { onDelete: "set null" }),
  rawPageId: bigint("raw_page_id", { mode: "number" }).references(() => rawPages.id, { onDelete: "set null" }),
  claimId: bigint("claim_id", { mode: "number" }).references(() => claims.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const organizationAliases = ingest.table("organization_aliases", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  organizationId: bigint("organization_id", { mode: "number" }).notNull().references(() => organizations.id, { onDelete: "cascade" }),
  alias: varchar("alias", { length: 200 }).notNull(),
  aliasType: aliasTypeEnum("alias_type").notNull().default("name_variant"),
  normalizedAlias: varchar("normalized_alias", { length: 200 }).notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  confidence: confidenceLevelEnum("confidence").notNull().default("medium"),
  sourceId: bigint("source_id", { mode: "number" }).references(() => sources.id, { onDelete: "set null" }),
  rawPageId: bigint("raw_page_id", { mode: "number" }).references(() => rawPages.id, { onDelete: "set null" }),
  claimId: bigint("claim_id", { mode: "number" }).references(() => claims.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const albumAliases = ingest.table("album_aliases", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  albumId: bigint("album_id", { mode: "number" }).notNull().references(() => albums.id, { onDelete: "cascade" }),
  alias: varchar("alias", { length: 250 }).notNull(),
  aliasType: aliasTypeEnum("alias_type").notNull().default("name_variant"),
  normalizedAlias: varchar("normalized_alias", { length: 250 }).notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  confidence: confidenceLevelEnum("confidence").notNull().default("medium"),
  sourceId: bigint("source_id", { mode: "number" }).references(() => sources.id, { onDelete: "set null" }),
  rawPageId: bigint("raw_page_id", { mode: "number" }).references(() => rawPages.id, { onDelete: "set null" }),
  claimId: bigint("claim_id", { mode: "number" }).references(() => claims.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const trackAliases = ingest.table("track_aliases", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  trackId: bigint("track_id", { mode: "number" }).notNull().references(() => tracks.id, { onDelete: "cascade" }),
  alias: varchar("alias", { length: 250 }).notNull(),
  aliasType: aliasTypeEnum("alias_type").notNull().default("name_variant"),
  normalizedAlias: varchar("normalized_alias", { length: 250 }).notNull(),
  isPrimary: boolean("is_primary").notNull().default(false),
  confidence: confidenceLevelEnum("confidence").notNull().default("medium"),
  sourceId: bigint("source_id", { mode: "number" }).references(() => sources.id, { onDelete: "set null" }),
  rawPageId: bigint("raw_page_id", { mode: "number" }).references(() => rawPages.id, { onDelete: "set null" }),
  claimId: bigint("claim_id", { mode: "number" }).references(() => claims.id, { onDelete: "set null" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conflicts = ingest.table("conflicts", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  claimAId: bigint("claim_a_id", { mode: "number" }).notNull().references(() => claims.id, { onDelete: "cascade" }),
  claimBId: bigint("claim_b_id", { mode: "number" }).notNull().references(() => claims.id, { onDelete: "cascade" }),
  entityKind: claimEntityKindEnum("entity_kind").notNull(),
  field: varchar("field", { length: 80 }).notNull(),
  valueA: jsonb("value_a").notNull(),
  valueB: jsonb("value_b").notNull(),
  status: conflictStatusEnum("status").notNull().default("open"),
  resolutionNote: text("resolution_note"),
  resolvedBy: actorKindEnum("resolved_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

export const reviewQueue = ingest.table("review_queue", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  kind: reviewKindEnum("kind").notNull(),
  status: reviewStatusEnum("status").notNull().default("open"),
  priority: smallint("priority").notNull().default(5),
  claimAId: bigint("claim_a_id", { mode: "number" }).references(() => claims.id, { onDelete: "set null" }),
  claimBId: bigint("claim_b_id", { mode: "number" }).references(() => claims.id, { onDelete: "set null" }),
  conflictId: bigint("conflict_id", { mode: "number" }).references(() => conflicts.id, { onDelete: "set null" }),
  artistAId: bigint("artist_a_id", { mode: "number" }).references(() => artists.id, { onDelete: "set null" }),
  artistBId: bigint("artist_b_id", { mode: "number" }).references(() => artists.id, { onDelete: "set null" }),
  personAId: bigint("person_a_id", { mode: "number" }).references(() => persons.id, { onDelete: "set null" }),
  personBId: bigint("person_b_id", { mode: "number" }).references(() => persons.id, { onDelete: "set null" }),
  organizationAId: bigint("organization_a_id", { mode: "number" }).references(() => organizations.id, { onDelete: "set null" }),
  organizationBId: bigint("organization_b_id", { mode: "number" }).references(() => organizations.id, { onDelete: "set null" }),
  albumId: bigint("album_id", { mode: "number" }).references(() => albums.id, { onDelete: "set null" }),
  trackId: bigint("track_id", { mode: "number" }).references(() => tracks.id, { onDelete: "set null" }),
  videoId: bigint("video_id", { mode: "number" }).references(() => youtubeVideos.id, { onDelete: "set null" }),
  payload: jsonb("payload"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  resolvedBy: actorKindEnum("resolved_by"),
  resolutionNote: text("resolution_note"),
});

export const mergeAudit = ingest.table("merge_audit", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  runId: bigint("run_id", { mode: "number" }).references(() => scrapeRuns.id, { onDelete: "set null" }),
  entityKind: claimEntityKindEnum("entity_kind").notNull(),
  artistId: bigint("artist_id", { mode: "number" }).references(() => artists.id, { onDelete: "cascade" }),
  personId: bigint("person_id", { mode: "number" }).references(() => persons.id, { onDelete: "cascade" }),
  organizationId: bigint("organization_id", { mode: "number" }).references(() => organizations.id, { onDelete: "cascade" }),
  albumId: bigint("album_id", { mode: "number" }).references(() => albums.id, { onDelete: "cascade" }),
  trackId: bigint("track_id", { mode: "number" }).references(() => tracks.id, { onDelete: "cascade" }),
  artistMembershipId: bigint("artist_membership_id", { mode: "number" }).references(() => artistMembers.id, { onDelete: "cascade" }),
  personOrganizationId: bigint("person_organization_id", { mode: "number" }).references(() => personOrganizations.id, { onDelete: "cascade" }),
  albumCreditId: bigint("album_credit_id", { mode: "number" }).references(() => albumCredits.id, { onDelete: "cascade" }),
  trackCreditId: bigint("track_credit_id", { mode: "number" }).references(() => trackCredits.id, { onDelete: "cascade" }),
  albumFormatId: bigint("album_format_id", { mode: "number" }).references(() => albumFormats.id, { onDelete: "cascade" }),
  field: varchar("field", { length: 80 }).notNull(),
  oldValue: jsonb("old_value"),
  newValue: jsonb("new_value"),
  reason: text("reason").notNull(),
  confidence: confidenceLevelEnum("confidence").notNull(),
  performedBy: actorKindEnum("performed_by").notNull().default("system"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

export const mergeAuditClaims = ingest.table("merge_audit_claims", {
  mergeAuditId: bigint("merge_audit_id", { mode: "number" }).notNull().references(() => mergeAudit.id, { onDelete: "cascade" }),
  claimId: bigint("claim_id", { mode: "number" }).notNull().references(() => claims.id, { onDelete: "restrict" }),
});

// --- Tablas (0007): decisiones ER explicables + gateway IA + narrativa ---
export const aiRuns = ingest.table("ai_runs", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  promptHash: varchar("prompt_hash", { length: 64 }).notNull(),
  taskKind: varchar("task_kind", { length: 40 }).notNull(),
  model: text("model").notNull(),
  schemaVersion: varchar("schema_version", { length: 30 }).notNull(),
  status: varchar("status", { length: 12 }).notNull(),
  inputSummary: jsonb("input_summary").notNull(),
  outputSummary: jsonb("output_summary"),
  requestPayload: jsonb("request_payload").notNull(),
  responsePayload: jsonb("response_payload"),
  rawResponse: text("raw_response"),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  errorMessage: text("error_message"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const entityResolutionDecisions = ingest.table("entity_resolution_decisions", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  decisionHash: varchar("decision_hash", { length: 64 }).notNull(),
  runId: bigint("run_id", { mode: "number" }).references(() => scrapeRuns.id, { onDelete: "set null" }),
  claimId: bigint("claim_id", { mode: "number" }).references(() => claims.id, { onDelete: "set null" }),
  aiRunId: bigint("ai_run_id", { mode: "number" }).references(() => aiRuns.id, { onDelete: "set null" }),
  entityKind: varchar("entity_kind", { length: 20 }).notNull(),
  artistId: bigint("artist_id", { mode: "number" }).references(() => artists.id, { onDelete: "set null" }),
  personId: bigint("person_id", { mode: "number" }).references(() => persons.id, { onDelete: "set null" }),
  albumId: bigint("album_id", { mode: "number" }).references(() => albums.id, { onDelete: "set null" }),
  trackId: bigint("track_id", { mode: "number" }).references(() => tracks.id, { onDelete: "set null" }),
  organizationId: bigint("organization_id", { mode: "number" }).references(() => organizations.id, { onDelete: "set null" }),
  inputNameOriginal: text("input_name_original").notNull(),
  inputNameNormalized: text("input_name_normalized").notNull(),
  inputContext: jsonb("input_context").notNull(),
  score: real("score").notNull(),
  action: varchar("action", { length: 20 }).notNull(),
  features: jsonb("features").notNull(),
  candidates: jsonb("candidates").notNull(),
  thresholds: jsonb("thresholds").notNull(),
  explanation: text("explanation").notNull(),
  decidedBy: varchar("decided_by", { length: 20 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // Retención (0022): la compactación marca la fila y guarda el conteo
  // original de candidatas, porque el dossier queda reducido a las mejores.
  compactedAt: timestamp("compacted_at", { withTimezone: true }),
  candidatesCount: integer("candidates_count"),
});

export const aiBiographies = ingest.table("ai_biographies", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entityKind: varchar("entity_kind", { length: 12 }).notNull(),
  artistId: bigint("artist_id", { mode: "number" }).references(() => artists.id, { onDelete: "cascade" }),
  personId: bigint("person_id", { mode: "number" }).references(() => persons.id, { onDelete: "cascade" }),
  aiRunId: bigint("ai_run_id", { mode: "number" }).notNull().references(() => aiRuns.id, { onDelete: "restrict" }),
  body: text("body").notNull(),
  factsSnapshot: jsonb("facts_snapshot").notNull(),
  model: text("model").notNull(),
  promptVersion: varchar("prompt_version", { length: 30 }).notNull(),
  status: varchar("status", { length: 12 }).notNull().default("draft"),
  reviewQueueId: bigint("review_queue_id", { mode: "number" }).references(() => reviewQueue.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const aiBiographyClaims = ingest.table("ai_biography_claims", {
  biographyId: bigint("biography_id", { mode: "number" }).notNull().references(() => aiBiographies.id, { onDelete: "cascade" }),
  claimId: bigint("claim_id", { mode: "number" }).notNull().references(() => claims.id, { onDelete: "restrict" }),
});

// Harness de migraciones (creado ad-hoc por migrate.sh / src/db/migrate.ts,
// no por un migrations/*.up.sql — es la tabla de control, no un dato del dominio).
export const schemaMigrations = ingest.table("schema_migrations", {
  version: text("version").primaryKey(),
  appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});
