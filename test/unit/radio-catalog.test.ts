import { describe, expect, it } from "vitest";
import { buildRadioTracks, livePlayableVideoIds, radioGenresOf, RADIO_CATALOG_VERSION, type RadioTrackRow } from "../../src/radio/catalog.js";
import { annotateRadioCatalog } from "../../src/radio/genres.js";
import type { YouTubeApiResponse, YouTubeVideoPayload } from "../../src/youtube/api.js";

const row = (overrides: Partial<RadioTrackRow> = {}): RadioTrackRow => ({
  video_id: "AAAAAAAAAAA",
  video_title: "Banda - Disco (2001) || Full Album ||",
  video_duration_seconds: 600,
  position: 0,
  track_title: "Primera",
  start_seconds: 0,
  ...overrides,
});

describe("catalogo de radio por canciones", () => {
  it("v3: cada canción lleva los géneros confirmados de SU álbum, no los del artista", () => {
    expect(RADIO_CATALOG_VERSION).toBe(3);
    const confirmed = radioGenresOf([
      { slug: "thrash-metal", name: "Thrash metal", family: "metal", role: "primary" },
      { slug: "heavy-metal", name: "Heavy metal", family: "metal", role: "secondary" },
    ], "Thrash metal");
    const rows = [
      row({ album_id: "10" }), row({ album_id: "10", position: 1, track_title: "Segunda", start_seconds: 180 }),
      row({ video_id: "BBBBBBBBBBB", album_id: 11 }), row({ video_id: "BBBBBBBBBBB", album_id: 11, position: 1, start_seconds: 200 }),
      row({ video_id: "CCCCCCCCCCC" }), row({ video_id: "CCCCCCCCCCC", position: 1, start_seconds: 200 }),
    ];
    const items = buildRadioTracks(rows, new Set(["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"]), new Map([[10, confirmed]]));
    expect(items[0]).toMatchObject({ albumId: 10, genres: {
      primaryGenre: { slug: "thrash-metal", family: "metal" }, secondaryGenres: [{ slug: "heavy-metal" }],
      families: ["metal"], genreOrigin: "album", genreStatus: "confirmed",
    } });
    // Álbum sin géneros confirmados: suena, pero sin clasificar (no entra en estaciones).
    expect(items.find((item) => item.videoId === "BBBBBBBBBBB")?.genres).toMatchObject({ primaryGenre: null, genreStatus: "unclassified" });
    // Video sin álbum enlazado: los campos opcionales no aparecen (compatible con v2).
    expect(items.find((item) => item.videoId === "CCCCCCCCCCC")).not.toHaveProperty("genres");
    // Texto de fuente sin principal confirmado: pendiente, sin géneros.
    expect(radioGenresOf([], "Heavy/Thrash")).toMatchObject({ genreStatus: "pending", families: [] });
  });

  it("corta cada capítulo y nunca exporta el álbum entero", () => {
    const items = buildRadioTracks([
      row(),
      row({ position: 1, track_title: "Segunda", start_seconds: 180 }),
      row({ position: 2, track_title: "Tercera", start_seconds: 420 }),
    ], new Set(["AAAAAAAAAAA"]));

    expect(items.map(item => [item.title, item.startSeconds, item.durationSeconds])).toEqual([
      ["Primera", 0, 180],
      ["Segunda", 180, 240],
      ["Tercera", 420, 180],
    ]);
    expect(items.every(item => item.available)).toBe(true);
  });

  it("descarta videos no verificados, capítulos rotos y videos sin capítulos", () => {
    const rows = [
      row(), row({ position: 1, start_seconds: 180 }),
      row({ video_id: "BBBBBBBBBBB", position: 0 }),
      row({ video_id: "CCCCCCCCCCC", position: 0 }),
      row({ video_id: "CCCCCCCCCCC", position: 1, start_seconds: 9999 }),
    ];
    expect(buildRadioTracks(rows, new Set(["BBBBBBBBBBB", "CCCCCCCCCCC"]))).toEqual([]);
  });

  it("omite videoclips, conciertos y documentales según la hoja, aunque tengan otro tipo", () => {
    const chapters = (video_id: string, sheet_types: string | null) => [
      row({ video_id, sheet_types }),
      row({ video_id, sheet_types, position: 1, track_title: "Segunda", start_seconds: 180 }),
    ];
    const rows = [
      ...chapters("AAAAAAAAAAA", "Solo Artist, Studio Album"),
      ...chapters("BBBBBBBBBBB", "Live Concert"),
      ...chapters("CCCCCCCCCCC", "Live Concert, Single"),
      ...chapters("DDDDDDDDDDD", "Music Video"),
      ...chapters("EEEEEEEEEEE", "Documentary"),
      ...chapters("FFFFFFFFFFF", null),
    ];
    const ids = new Set(rows.map(item => item.video_id));
    expect([...new Set(buildRadioTracks(rows, ids).map(item => item.videoId))]).toEqual(["AAAAAAAAAAA", "FFFFFFFFFFF"]);
  });

  it("considera indisponible un ID ausente, privado, no embebible, con edad o región restringida", async () => {
    const payload = (
      id: string, privacyStatus: string, embeddable: boolean, contentDetails: Record<string, unknown> = {},
    ): YouTubeVideoPayload => ({
      id, status: { privacyStatus, embeddable, uploadStatus: "processed" }, contentDetails,
    });
    const api = {
      listVideos: async (): Promise<YouTubeApiResponse<YouTubeVideoPayload>> => ({ items: [
        payload("AAAAAAAAAAA", "public", true, { regionRestriction: { blocked: [] } }),
        payload("BBBBBBBBBBB", "private", true),
        payload("CCCCCCCCCCC", "public", false),
        payload("EEEEEEEEEEE", "public", true, { contentRating: { ytRating: "ytAgeRestricted" } }),
        payload("FFFFFFFFFFF", "public", true, { regionRestriction: { blocked: ["VE"] } }),
        payload("GGGGGGGGGGG", "public", true, { regionRestriction: { allowed: ["VE"] } }),
        // Vetado en casi todo el mundo, aunque Venezuela no figure.
        payload("IIIIIIIIIII", "public", true, { regionRestriction: { blocked: Array.from({ length: 120 }, (_, i) => `R${i}`) } }),
        // Un veto puntual fuera de Venezuela no lo saca del aire.
        payload("HHHHHHHHHHH", "public", true, { regionRestriction: { blocked: ["DE"] } }),
      ] }),
    };
    const result = await livePlayableVideoIds(
      ["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC", "DDDDDDDDDDD", "EEEEEEEEEEE", "FFFFFFFFFFF", "GGGGGGGGGGG", "HHHHHHHHHHH", "IIIIIIIIIII"],
      api as never,
    );
    expect([...result]).toEqual(["AAAAAAAAAAA", "HHHHHHHHHHH"]);
  });
});

describe("anotación de géneros sobre el catálogo de herra", () => {
  const confirmed = radioGenresOf([{ slug: "pop-rock", name: "Pop rock", family: "pop", role: "primary" }], "Pop rock");
  const piece = (videoId: string, extra: Record<string, unknown> = {}) => ({
    videoId, title: "Canción", artist: "Banda", album: "Disco", year: 1999, trackNumber: 1, startSeconds: 0, durationSeconds: 200, available: true, ...extra,
  });

  it("anota sin agregar, quitar ni reordenar piezas y sube a v3", () => {
    const catalog = { version: 2, generatedAt: "g", availabilityCheckedAt: "a", channelId: "c",
      items: [piece("AAAAAAAAAAA"), piece("BBBBBBBBBBB"), piece("CCCCCCCCCCC", { albumId: 99, genres: confirmed })] };
    const { catalog: out, stats } = annotateRadioCatalog(catalog, new Map([["AAAAAAAAAAA", 5], ["BBBBBBBBBBB", 6]]),
      new Map([[5, confirmed], [6, radioGenresOf([], null)]]), "t");
    const items = out["items"] as Array<Record<string, unknown>>;
    expect(out).toMatchObject({ version: RADIO_CATALOG_VERSION, generatedAt: "g", availabilityCheckedAt: "a", channelId: "c", genresAnnotatedAt: "t" });
    expect(items.map((item) => item["videoId"])).toEqual(["AAAAAAAAAAA", "BBBBBBBBBBB", "CCCCCCCCCCC"]);
    expect(items[0]).toMatchObject({ albumId: 5, genres: { primaryGenre: { slug: "pop-rock" }, genreOrigin: "album" } });
    expect(items[1]).toMatchObject({ albumId: 6, genres: { genreStatus: "unclassified" } });
    // Sin álbum enlazado hoy: se quita la anotación vieja, la pieza sigue igual.
    expect(items[2]).toEqual(piece("CCCCCCCCCCC"));
    expect(stats).toEqual({ items: 3, linked: 2, confirmed: 1, pending: 0, unclassified: 1, unlinked: 1 });
  });
});
