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
import type { CatalogSnapshot } from "../../src/curation/types.js";

export const CATALOG_FIXTURE_PATH = new URL("../fixtures/curation/catalog-2026-09-16.json.gz", import.meta.url);

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

export function loadCatalogFixture(): CatalogSnapshot {
  const fixture = JSON.parse(gunzipSync(readFileSync(CATALOG_FIXTURE_PATH)).toString("utf8")) as CatalogFixture;
  if (fixture.format !== "crv-curation-catalog.v1") throw new Error(`Formato de foto desconocido: ${String(fixture.format)}`);
  return {
    takenAt: new Date(fixture.takenAt),
    artists: fixture.artists.map(([id, name, originCity, formedYear, disbandedYear]) => ({ id, name, originCity, formedYear, disbandedYear })),
    persons: fixture.persons.map(([id, name]) => ({ id, name })),
    organizations: fixture.organizations.map(([id, name, type]) => ({ id, name, type })),
    albums: fixture.albums.map(([id, artistId, title, releaseYear, albumType]) => ({ id, artistId, title, releaseYear, albumType })),
    tracks: fixture.tracks.map(([id, albumId, disc, number, title, durationSeconds]) => ({ id, albumId, disc, number, title, durationSeconds })),
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
