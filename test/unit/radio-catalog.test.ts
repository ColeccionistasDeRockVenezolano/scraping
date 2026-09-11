import { describe, expect, it } from "vitest";
import { buildRadioTracks, livePlayableVideoIds, type RadioTrackRow } from "../../src/radio/catalog.js";
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
