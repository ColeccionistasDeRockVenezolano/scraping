// Catálogo sintético para probar el detector de conflictos sin base de datos.
// Es deliberadamente limpio: cada prueba le añade el caso que quiere ver.
import type { CatalogSnapshot, SnapshotAlbum, SnapshotArtist, SnapshotPerson, SnapshotTrack } from "../../src/curation/types.js";

const FIRST = ["Juan", "Carlos", "María", "Luis", "Ana", "Pedro", "Rosa", "Jorge", "Elena", "Miguel"];
const LAST = ["Pérez", "Rodríguez", "González", "Hernández", "Díaz", "Morales", "Rivas", "Castillo"];
const BAND_A = ["Trueno", "Sombra", "Relámpago", "Tormenta", "Ceniza", "Marea", "Fuego", "Hielo"];
const BAND_B = ["Negro", "Eléctrico", "Salvaje", "Nocturno", "Urbano", "Profundo", "Rojo", "Lejano"];
const ALBUM = ["Camino", "Ruido", "Silencio", "Ciudad", "Memoria", "Distancia", "Frontera", "Invierno"];
const SONG = ["Noche", "Calle", "Viento", "Lluvia", "Espejo", "Puerta", "Humo", "Sangre", "Cristal", "Tiempo"];

export function cleanSnapshot(): CatalogSnapshot {
  const artists: SnapshotArtist[] = [];
  for (const a of BAND_A) for (const b of BAND_B) {
    artists.push({ id: artists.length + 1, name: `${a} ${b}`, originCity: artists.length % 2 ? "Caracas" : "Valencia", formedYear: 1980, disbandedYear: null });
  }
  const persons: SnapshotPerson[] = [];
  for (const first of FIRST) for (const last of LAST) persons.push({ id: persons.length + 1, name: `${first} ${last}` });
  const albums: SnapshotAlbum[] = [];
  const tracks: SnapshotTrack[] = [];
  for (const artist of artists) {
    const album: SnapshotAlbum = {
      id: albums.length + 1, artistId: artist.id, albumType: "studio", releaseYear: 1990 + (artist.id % 20),
      title: `${ALBUM[artist.id % ALBUM.length]} ${SONG[(artist.id * 3) % SONG.length]}`,
    };
    albums.push(album);
    for (let number = 1; number <= 4; number += 1) {
      tracks.push({
        id: tracks.length + 1, albumId: album.id, disc: 1, number, durationSeconds: 180 + ((artist.id + number) % 60),
        title: `${SONG[(artist.id + number) % SONG.length]} ${ALBUM[(artist.id + number * 2) % ALBUM.length]}`,
      });
    }
  }
  const link = (ids: number[]) => new Map(ids.map((id) => [id, 1]));
  return {
    takenAt: new Date("2026-09-16T12:00:00Z"),
    artists, persons, albums, tracks,
    organizations: [{ id: 1, name: "Estudios Sonoros", type: "studio" }, { id: 2, name: "Discos Caribe", type: "label" }],
    creditRoles: [{ role: "Guitarra", creditType: "performer", uses: 40 }, { role: "Voz", creditType: "performer", uses: 60 }],
    personArtists: new Map(persons.map((person) => [person.id, new Set([((person.id - 1) % artists.length) + 1])])),
    personLinks: link(persons.map((person) => person.id)),
    organizationLinks: link([1, 2]),
    artistLinks: link(artists.map((artist) => artist.id)),
    reviews: [],
    conflicts: [],
    handledPairs: new Set(),
  };
}
