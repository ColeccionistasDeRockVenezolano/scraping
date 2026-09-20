// Foto congelada del catálogo de desarrollo (2026-09-16) para medir la
// precisión de los detectores sin base de datos (PLAN_CURADURIA E2.1).
//
// Por qué una foto y no el catálogo sintético: el vocabulario se aprende del
// catálogo entero (marcas de sello, nombres de pila, descriptores), así que un
// falso positivo real solo se reproduce con los mismos datos que lo produjeron.
// Se tomó con SELECT en REPEATABLE READ; sin la cola de revisión (no hay
// hallazgos de cola en el corpus), pero con sus pares ya tratados.
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import type {
  CatalogSnapshot, SnapshotAlias, SnapshotCredit, SnapshotMediaLink, SnapshotMembership, SnapshotRedirect,
} from "../../src/curation/types.js";

export const CATALOG_FIXTURE_PATH = new URL("../fixtures/curation/catalog-2026-09-16.json.gz", import.meta.url);
/**
 * Parte relacional de la misma foto (créditos, membresías, aliases,
 * redirecciones y enlaces de medios), congelada aparte para no mover las
 * etiquetas de E2 que ya cuelgan del archivo de fichas. Se genera con
 * `npm run curation:relations`.
 */
export const RELATIONS_FIXTURE_PATH = new URL("../fixtures/curation/relations-2026-09-20.json.gz", import.meta.url);

interface CatalogFixture {
  format: "crv-curation-catalog.v1";
  takenAt: string;
  artists: Array<[number, string, string | null, number | null, number | null]>;
  persons: Array<[number, string]>;
  organizations: Array<[number, string, string]>;
  albums: Array<[number, number, string, number | null, string]>;
  tracks: Array<[number, number, number, number, string, number | null]>;
  creditRoles: Array<[string, string, number]>;
  personArtists: Array<[number, number[]]>;
  personLinks: Array<[number, number]>;
  organizationLinks: Array<[number, number]>;
  artistLinks: Array<[number, number]>;
  handledPairs: string[];
}

type EntityKind = "artist" | "person" | "organization" | "album" | "track";

interface RelationsFixture {
  format: "crv-curation-relations.v1";
  takenAt: string;
  catalog: string;
  credits: Array<[number, "album" | "track", number, number | null, number | null, number | null, string, string]>;
  memberships: Array<[number, number, number, string, number | null, number | null, boolean]>;
  aliases: Array<[number, EntityKind, number, string, string]>;
  redirects: Array<[EntityKind, number, number]>;
  mediaLinks: Array<[number, string, number | null, number | null, number | null, number | null, string, string]>;
  albumLabels: Array<[number, number]>;
}

function readGzipJson<T>(url: URL): T {
  return JSON.parse(gunzipSync(readFileSync(url)).toString("utf8")) as T;
}

function loadRelationsFixture(): RelationsFixture {
  const fixture = readGzipJson<RelationsFixture>(RELATIONS_FIXTURE_PATH);
  if (fixture.format !== "crv-curation-relations.v1") throw new Error(`Formato de foto relacional desconocido: ${String(fixture.format)}`);
  return fixture;
}

/**
 * Devuelve la foto completa: fichas del 16/09 más la parte relacional. Con
 * `relations: false` se obtiene la foto sin relaciones, que es la que usan las
 * pruebas anteriores a E11.
 */
export function loadCatalogFixture(options: { relations?: boolean } = {}): CatalogSnapshot {
  const fixture = readGzipJson<CatalogFixture>(CATALOG_FIXTURE_PATH);
  if (fixture.format !== "crv-curation-catalog.v1") throw new Error(`Formato de foto desconocido: ${String(fixture.format)}`);
  const relations = options.relations === false ? null : loadRelationsFixture();
  const labelByAlbum = new Map<number, number>(relations?.albumLabels ?? []);
  const credits: SnapshotCredit[] = (relations?.credits ?? []).map(
    ([id, parentKind, parentId, personId, artistId, organizationId, creditType, role]) =>
      ({ id, parentKind, parentId, personId, artistId, organizationId, creditType, role }));
  const memberships: SnapshotMembership[] = (relations?.memberships ?? []).map(
    ([id, artistId, personId, role, fromYear, toYear, isCurrent]) =>
      ({ id, artistId, personId, role, fromYear, toYear, isCurrent }));
  const aliases: SnapshotAlias[] = (relations?.aliases ?? []).map(
    ([id, kind, entityId, alias, normalizedAlias]) => ({ id, kind, entityId, alias, normalizedAlias }));
  const redirects: SnapshotRedirect[] = (relations?.redirects ?? []).map(([kind, fromId, toId]) => ({ kind, fromId, toId }));
  const mediaLinks: SnapshotMediaLink[] = (relations?.mediaLinks ?? []).map(
    ([id, entityKind, artistId, personId, organizationId, albumId, url, mediaType]) =>
      ({ id, entityKind, artistId, personId, organizationId, albumId, url, mediaType }));
  return {
    takenAt: new Date(fixture.takenAt),
    artists: fixture.artists.map(([id, name, originCity, formedYear, disbandedYear]) => ({ id, name, originCity, formedYear, disbandedYear })),
    persons: fixture.persons.map(([id, name]) => ({ id, name })),
    organizations: fixture.organizations.map(([id, name, type]) => ({ id, name, type })),
    albums: fixture.albums.map(([id, artistId, title, releaseYear, albumType]) => ({ id, artistId, title, releaseYear, albumType, labelId: labelByAlbum.get(id) ?? null })),
    tracks: fixture.tracks.map(([id, albumId, disc, number, title, durationSeconds]) => ({ id, albumId, disc, number, title, durationSeconds })),
    credits, memberships, aliases, redirects, mediaLinks,
    creditRoles: fixture.creditRoles.map(([role, creditType, uses]) => ({ role, creditType, uses })),
    personArtists: new Map(fixture.personArtists.map(([id, artists]) => [id, new Set(artists)])),
    personLinks: new Map(fixture.personLinks),
    organizationLinks: new Map(fixture.organizationLinks),
    artistLinks: new Map(fixture.artistLinks),
    reviews: [],
    conflicts: [],
    handledPairs: new Set(fixture.handledPairs),
    distinctPairs: new Set(),
  };
}
