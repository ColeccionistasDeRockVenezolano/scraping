import type { ClaimToPersist } from "../claims/persistence.js";

export type ResolvableClaimKind = "artist" | "person" | "album" | "track" | "organization";

export interface EntitySpec {
  kind: ResolvableClaimKind;
  erKind: "ARTIST" | "PERSON" | "ALBUM" | "TRACK" | "ORGANIZATION";
  table: string;
  targetColumn: "artist_id" | "person_id" | "album_id" | "track_id" | "organization_id";
  identityColumn: "name" | "title";
  aliasTable: string;
  aliasTargetColumn: "artist_id" | "person_id" | "album_id" | "track_id" | "organization_id";
  fields: Readonly<Record<string, string>>;
}

export const ENTITY_SPECS: Readonly<Record<ResolvableClaimKind, EntitySpec>> = {
  artist: {
    kind: "artist", erKind: "ARTIST", table: "public.artists", targetColumn: "artist_id", identityColumn: "name",
    aliasTable: "ingest.artist_aliases", aliasTargetColumn: "artist_id",
    fields: { name: "name", artist_type: "artist_type", biography: "biography", picture_url: "picture_url", origin_city: "origin_city", origin_country: "origin_country", formed_year: "formed_year", disbanded_year: "disbanded_year", notes: "notes" },
  },
  person: {
    kind: "person", erKind: "PERSON", table: "public.persons", targetColumn: "person_id", identityColumn: "name",
    aliasTable: "ingest.person_aliases", aliasTargetColumn: "person_id",
    fields: { name: "name", biography: "biography", picture_url: "picture_url", nationality: "nationality", is_venezuelan: "is_venezuelan", birth_date: "birth_date", death_date: "death_date", notes: "notes" },
  },
  album: {
    kind: "album", erKind: "ALBUM", table: "public.albums", targetColumn: "album_id", identityColumn: "title",
    aliasTable: "ingest.album_aliases", aliasTargetColumn: "album_id",
    fields: { title: "title", release_year: "release_year", album_type: "album_type", genre: "genre", label_id: "label_id", cover_url: "cover_url", description: "description", youtube_url: "youtube_url", youtube_status: "youtube_status", instagram_url: "instagram_url", instagram_status: "instagram_status", wordpress_url: "wordpress_url", wordpress_status: "wordpress_status", notes: "notes" },
  },
  track: {
    kind: "track", erKind: "TRACK", table: "public.tracks", targetColumn: "track_id", identityColumn: "title",
    aliasTable: "ingest.track_aliases", aliasTargetColumn: "track_id",
    fields: { title: "title", disc_number: "disc_number", track_number: "track_number", duration_seconds: "duration_seconds", youtube_start_seconds: "youtube_start_seconds", notes: "notes" },
  },
  organization: {
    kind: "organization", erKind: "ORGANIZATION", table: "public.organizations", targetColumn: "organization_id", identityColumn: "name",
    aliasTable: "ingest.organization_aliases", aliasTargetColumn: "organization_id",
    fields: { name: "name", organization_type: "organization_type", biography: "biography", picture_url: "picture_url", website_url: "website_url", country: "country", notes: "notes" },
  },
};

export function resolvableSpec(kind: ClaimToPersist["entityKind"]): EntitySpec | undefined {
  return kind === "artist" || kind === "person" || kind === "album" || kind === "track" || kind === "organization"
    ? ENTITY_SPECS[kind]
    : undefined;
}

export function claimTargetId(claim: ClaimToPersist, spec: EntitySpec): number | undefined {
  if (spec.kind === "artist") return claim.artistId;
  if (spec.kind === "person") return claim.personId;
  if (spec.kind === "album") return claim.albumId;
  if (spec.kind === "track") return claim.trackId;
  return claim.organizationId;
}

