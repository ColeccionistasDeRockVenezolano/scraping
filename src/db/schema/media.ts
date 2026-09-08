// CRV · Schema tipado (Drizzle) del schema auxiliar `media`.
// DDL real en migrations/0002_media.up.sql (+ columna claim_id añadida por
// 0003). Ver nota de sincronía manual en src/db/schema/ingest.ts.
import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgSchema,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";
import { albums, artists, tracks } from "./core.js";
import { publicationStatusEnum } from "./core.js";
import { confidenceLevelEnum } from "./ingest-enums.js";

export const media = pgSchema("media");

export const videoRelationKindEnum = media.enum("video_relation_kind", [
  "performer", "channel", "subject", "other",
]);
export const videoAlbumKindEnum = media.enum("video_album_kind", [
  "full_album", "music_video", "live_concert", "documentary", "other",
]);

export const youtubeVideos = media.table("youtube_videos", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  videoId: varchar("video_id", { length: 11 }).notNull(),
  url: text("url"),
  title: text("title"),
  description: text("description"),
  channelId: varchar("channel_id", { length: 80 }),
  channelTitle: varchar("channel_title", { length: 200 }),
  publishedAt: timestamp("published_at", { withTimezone: true }),
  durationSeconds: integer("duration_seconds"),
  thumbnailUrl: text("thumbnail_url"),
  publicationStatus: publicationStatusEnum("publication_status").notNull().default("unknown"),
  metadata: jsonb("metadata"),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  // seedUploadId: FK a ingest.seed_uploads — se omite aquí para no crear un
  // ciclo de import entre media.ts <-> ingest.ts; se referencia solo por id
  // sin período onDelete tipado (mismo patrón usado por claim_id abajo).
  seedUploadId: bigint("seed_upload_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const videoArtists = media.table("video_artists", {
  videoId: bigint("video_id", { mode: "number" }).notNull().references(() => youtubeVideos.id, { onDelete: "cascade" }),
  artistId: bigint("artist_id", { mode: "number" }).notNull().references(() => artists.id, { onDelete: "cascade" }),
  relationKind: videoRelationKindEnum("relation_kind").notNull().default("performer"),
  confidence: confidenceLevelEnum("confidence").notNull().default("medium"),
  sourceId: bigint("source_id", { mode: "number" }),
  claimId: bigint("claim_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const videoAlbums = media.table("video_albums", {
  videoId: bigint("video_id", { mode: "number" }).notNull().references(() => youtubeVideos.id, { onDelete: "cascade" }),
  albumId: bigint("album_id", { mode: "number" }).notNull().references(() => albums.id, { onDelete: "cascade" }),
  albumKind: videoAlbumKindEnum("album_kind").notNull().default("other"),
  isPrimaryLink: boolean("is_primary_link").notNull().default(false),
  confidence: confidenceLevelEnum("confidence").notNull().default("medium"),
  sourceId: bigint("source_id", { mode: "number" }),
  claimId: bigint("claim_id", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const videoTracks = media.table("video_tracks", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  videoId: bigint("video_id", { mode: "number" }).notNull().references(() => youtubeVideos.id, { onDelete: "cascade" }),
  trackId: bigint("track_id", { mode: "number" }).notNull().references(() => tracks.id, { onDelete: "cascade" }),
  startSeconds: integer("start_seconds").notNull(),
  endSeconds: integer("end_seconds"),
  confidence: confidenceLevelEnum("confidence").notNull().default("medium"),
  sourceId: bigint("source_id", { mode: "number" }),
  claimId: bigint("claim_id", { mode: "number" }),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const mediaLinks = media.table("media_links", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  entityKind: varchar("entity_kind", { length: 20 }).notNull(),
  artistId: bigint("artist_id", { mode: "number" }).references(() => artists.id, { onDelete: "cascade" }),
  personId: bigint("person_id", { mode: "number" }),
  organizationId: bigint("organization_id", { mode: "number" }),
  albumId: bigint("album_id", { mode: "number" }).references(() => albums.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  mediaType: varchar("media_type", { length: 20 }).notNull().default("other"),
  sourceId: bigint("source_id", { mode: "number" }),
  meta: jsonb("meta"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
