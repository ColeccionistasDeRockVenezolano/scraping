// CRV · Espejo tipado (Drizzle) del CORE CANÓNICO en `public`.
//
// ADVERTENCIA: este archivo NO es fuente de verdad ni genera DDL. El único
// DDL del core es crv_simple_v1.sql, aplicado verbatim y verificado por
// hash (crv_simple_v1.sql.sha256) y por tests/run_all.sh (diff de pg_dump
// vacío). Este módulo solo describe las columnas para construir queries
// tipadas; nunca se ejecuta drizzle-kit push/generate contra `public`.
//
// Por la misma razón, el core no se toca desde la app salvo por el
// merge engine (CONTRACT §único escritor); el resto del código debe tratar
// estas tablas como de solo lectura.
import {
  bigint,
  boolean,
  date,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  timestamp,
  varchar,
} from "drizzle-orm/pg-core";

// --- Enums (crv_simple_v1.sql) ---
export const artistTypeEnum = pgEnum("artist_type", [
  "band", "solo_artist", "duo", "project", "group", "other",
]);

export const albumTypeEnum = pgEnum("album_type", [
  "studio_album", "live_album", "ep", "single", "compilation",
  "demo", "soundtrack", "collaboration_album", "remix", "other",
]);

export const publicationStatusEnum = pgEnum("publication_status", [
  "published", "unlisted", "unpublished", "copyright_blocked", "unknown",
]);

export const archiveQualityEnum = pgEnum("archive_quality", ["HQ", "LQ", "unknown"]);
export const archiveStatusEnum = pgEnum("archive_status", ["published", "unpublished", "unknown"]);

export const organizationTypeEnum = pgEnum("organization_type", [
  "record_label", "production_company", "recording_studio",
  "distributor", "management", "other",
]);

export const creditTypeEnum = pgEnum("credit_type", [
  "musician", "guest", "writer", "composer", "producer",
  "recording", "mixing", "mastering", "photography", "artwork", "other",
]);

// --- Tablas ---
export const artists = pgTable("artists", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 200 }).notNull(),
  artistType: artistTypeEnum("artist_type").notNull().default("band"),
  biography: text("biography"),
  pictureUrl: text("picture_url"),
  originCity: varchar("origin_city", { length: 120 }),
  originCountry: varchar("origin_country", { length: 120 }).notNull().default("Venezuela"),
  formedYear: smallint("formed_year"),
  disbandedYear: smallint("disbanded_year"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const persons = pgTable("persons", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 200 }).notNull(),
  biography: text("biography"),
  pictureUrl: text("picture_url"),
  nationality: varchar("nationality", { length: 120 }),
  isVenezuelan: boolean("is_venezuelan").notNull().default(false),
  birthDate: date("birth_date"),
  deathDate: date("death_date"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const artistMembers = pgTable("artist_members", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  artistId: bigint("artist_id", { mode: "number" }).notNull().references(() => artists.id, { onDelete: "cascade" }),
  personId: bigint("person_id", { mode: "number" }).notNull().references(() => persons.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 200 }).notNull(),
  fromYear: smallint("from_year"),
  toYear: smallint("to_year"),
  isCurrent: boolean("is_current").notNull().default(false),
  notes: text("notes"),
});

export const organizations = pgTable("organizations", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  name: varchar("name", { length: 200 }).notNull(),
  organizationType: organizationTypeEnum("organization_type").notNull().default("other"),
  biography: text("biography"),
  pictureUrl: text("picture_url"),
  websiteUrl: text("website_url"),
  country: varchar("country", { length: 120 }),
  notes: text("notes"),
});

export const personOrganizations = pgTable("person_organizations", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  personId: bigint("person_id", { mode: "number" }).notNull().references(() => persons.id, { onDelete: "cascade" }),
  organizationId: bigint("organization_id", { mode: "number" }).notNull().references(() => organizations.id, { onDelete: "cascade" }),
  role: varchar("role", { length: 200 }).notNull(),
  fromYear: smallint("from_year"),
  toYear: smallint("to_year"),
  notes: text("notes"),
});

export const albums = pgTable("albums", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  artistId: bigint("artist_id", { mode: "number" }).notNull().references(() => artists.id, { onDelete: "cascade" }),
  title: varchar("title", { length: 250 }).notNull(),
  releaseYear: smallint("release_year"),
  albumType: albumTypeEnum("album_type").notNull().default("other"),
  genre: varchar("genre", { length: 200 }),
  labelId: bigint("label_id", { mode: "number" }).references(() => organizations.id, { onDelete: "set null" }),
  coverUrl: text("cover_url"),
  description: text("description"),
  youtubeUrl: text("youtube_url"),
  youtubeStatus: publicationStatusEnum("youtube_status").notNull().default("unknown"),
  instagramUrl: text("instagram_url"),
  instagramStatus: publicationStatusEnum("instagram_status").notNull().default("unknown"),
  wordpressUrl: text("wordpress_url"),
  wordpressStatus: publicationStatusEnum("wordpress_status").notNull().default("unknown"),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const tracks = pgTable("tracks", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  albumId: bigint("album_id", { mode: "number" }).notNull().references(() => albums.id, { onDelete: "cascade" }),
  discNumber: smallint("disc_number").notNull().default(1),
  trackNumber: smallint("track_number").notNull(),
  title: varchar("title", { length: 250 }).notNull(),
  durationSeconds: integer("duration_seconds"),
  youtubeStartSeconds: integer("youtube_start_seconds"),
  notes: text("notes"),
});

export const albumCredits = pgTable("album_credits", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  albumId: bigint("album_id", { mode: "number" }).notNull().references(() => albums.id, { onDelete: "cascade" }),
  personId: bigint("person_id", { mode: "number" }).references(() => persons.id, { onDelete: "cascade" }),
  artistId: bigint("artist_id", { mode: "number" }).references(() => artists.id, { onDelete: "cascade" }),
  organizationId: bigint("organization_id", { mode: "number" }).references(() => organizations.id, { onDelete: "cascade" }),
  creditType: creditTypeEnum("credit_type").notNull(),
  role: varchar("role", { length: 200 }).notNull(),
  notes: text("notes"),
});

export const trackCredits = pgTable("track_credits", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  trackId: bigint("track_id", { mode: "number" }).notNull().references(() => tracks.id, { onDelete: "cascade" }),
  personId: bigint("person_id", { mode: "number" }).references(() => persons.id, { onDelete: "cascade" }),
  artistId: bigint("artist_id", { mode: "number" }).references(() => artists.id, { onDelete: "cascade" }),
  organizationId: bigint("organization_id", { mode: "number" }).references(() => organizations.id, { onDelete: "cascade" }),
  creditType: creditTypeEnum("credit_type").notNull(),
  role: varchar("role", { length: 200 }).notNull(),
  notes: text("notes"),
});

export const albumFormats = pgTable("album_formats", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  albumId: bigint("album_id", { mode: "number" }).notNull().references(() => albums.id, { onDelete: "cascade" }),
  format: varchar("format", { length: 50 }).notNull(),
  quality: archiveQualityEnum("quality"),
  archiveStatus: archiveStatusEnum("archive_status").notNull().default("unknown"),
  filePath: text("file_path"),
  notes: text("notes"),
});
