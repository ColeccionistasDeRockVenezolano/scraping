import { describe, expect, it } from "vitest";
import fixture from "../fixtures/youtube-video-Q-pRpO2sYSI.json" with { type: "json" };
import { YouTubeDataApi, iso8601DurationToSeconds, youtubePublicationStatus, type YouTubeVideoPayload } from "../../src/youtube/api.js";
import { canonicalVideoUrl, classifyContentType, extractYouTubeVideoId } from "../../src/youtube/normalization.js";
import { parseYouTubeDescription, parseYouTubeTitle, timestampToSeconds } from "../../src/youtube/parsers.js";
import { readYouTubeMasterSheet } from "../../src/youtube/pipeline.js";

describe("YouTube URL normalization", () => {
  it.each([
    "https://www.youtube.com/watch?v=Q-pRpO2sYSI",
    "https://youtube.com/watch?v=Q-pRpO2sYSI&t=11s",
    "https://www.youtube.com/watch?t=11&v=Q-pRpO2sYSI&feature=youtu.be",
    "https://youtu.be/Q-pRpO2sYSI?t=4",
    "youtu.be/Q-pRpO2sYSI?si=token",
    "https://www.youtube.com/shorts/Q-pRpO2sYSI?feature=share",
  ])("extracts canonical ID from %s", (url) => expect(extractYouTubeVideoId(url)).toBe("Q-pRpO2sYSI"));

  it("rejects unrelated and malformed URLs", () => {
    expect(extractYouTubeVideoId("https://example.test/watch?v=Q-pRpO2sYSI")).toBeNull();
    expect(extractYouTubeVideoId("https://youtube.com/watch?v=too-short")).toBeNull();
    expect(canonicalVideoUrl("Q-pRpO2sYSI")).toBe("https://www.youtube.com/watch?v=Q-pRpO2sYSI");
  });
});

describe("seed content classification", () => {
  it("distinguishes releases from media without making media albums", () => {
    expect(classifyContentType("Studio Album")).toMatchObject({ kind: "release", normalizedType: "studio_album" });
    expect(classifyContentType("Demos")).toMatchObject({ kind: "release", normalizedType: "demo" });
    expect(classifyContentType("Music Video")).toMatchObject({ kind: "media", normalizedType: "music_video" });
    expect(classifyContentType("Live Concert")).toMatchObject({ kind: "media", normalizedType: "live_concert" });
    expect(classifyContentType("Documentary")).toMatchObject({ kind: "media", normalizedType: "documentary" });
    expect(classifyContentType("B-Sides / Unplugged").kind).toBe("review");
  });
});

describe("YT Master Spreadsheet", () => {
  it("reads its named columns directly", async () => {
    const rows = await readYouTubeMasterSheet();
    expect(rows).toHaveLength(606);
    expect(rows[0]).toMatchObject({ uploadOrder: 350, artistName: "10MC", type: "Studio Album" });
  });
});

describe("deterministic description parser", () => {
  it("parses explicit sections and timestamps in seconds without AI", () => {
    const parsed = parseYouTubeDescription((fixture as YouTubeVideoPayload).snippet?.["description"] as string);
    expect(parsed.sections.map((section) => section.kind)).toEqual(["tracklist", "produced_by", "recorded_at"]);
    expect(parsed.tracklist).toEqual([
      { title: "Apertura", startSeconds: 0, position: 0 },
      { title: "Segunda canción", startSeconds: 247, position: 1 },
      { title: "Final", startSeconds: 3734, position: 2 },
    ]);
    expect(timestampToSeconds("04:07")).toBe(247);
    expect(timestampToSeconds("1:02:14")).toBe(3734);
    expect(parseYouTubeTitle("Prueba - Álbum completo")).toMatchObject({ artist: "Prueba", isFullAlbum: true });
  });

  it("maps the API fixture even without an API key", () => {
    expect(iso8601DurationToSeconds((fixture as YouTubeVideoPayload).contentDetails?.["duration"] as string)).toBe(3906);
    expect(youtubePublicationStatus((fixture as YouTubeVideoPayload).status)).toBe("unlisted");
  });

  it("refuses a live API call clearly when the key is absent", async () => {
    const client = new YouTubeDataApi("", async () => { throw new Error("no debe llamar HTTP sin clave"); });
    await expect(client.listVideos(["Q-pRpO2sYSI"])).rejects.toThrow(/YOUTUBE_API_KEY/);
  });
});
