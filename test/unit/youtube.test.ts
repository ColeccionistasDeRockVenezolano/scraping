import { describe, expect, it } from "vitest";
import fixture from "../fixtures/youtube-video-Q-pRpO2sYSI.json" with { type: "json" };
import realFixture from "../fixtures/youtube-video-real-Q-pRpO2sYSI.json" with { type: "json" };
import { YouTubeDataApi, iso8601DurationToSeconds, youtubePublicationStatus, type YouTubeVideoPayload } from "../../src/youtube/api.js";
import { canonicalVideoUrl, classifyContentType, extractYouTubeVideoId } from "../../src/youtube/normalization.js";
import { parseCreditSections, parseYouTubeDescription, parseYouTubeTitle, timestampToSeconds } from "../../src/youtube/parsers.js";
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
    expect(parsed.sections.map((section) => section.kind)).toEqual(["tracklist", "recorded_at"]);
    expect(parsed.tracklist).toEqual([
      { title: "Apertura", startSeconds: 0, position: 0 },
      { title: "Segunda canción", startSeconds: 247, position: 1 },
      { title: "Final", startSeconds: 3734, position: 2 },
    ]);
    expect(timestampToSeconds("04:07")).toBe(247);
    expect(timestampToSeconds("1:02:14")).toBe(3734);
    expect(parseYouTubeTitle("Prueba - Álbum completo")).toMatchObject({ artist: "Prueba", isFullAlbum: true });
    // "Produced by:" no es un encabezado sino un crédito en línea: así
    // aparece en las 636 descripciones reales del canal (SOURCES.md §2.2).
    expect(parsed.credits).toEqual([
      { verbs: ["produced"], preposition: "by", value: "Productor de prueba", sectionKind: "tracklist",
        names: ["Productor de prueba"], venue: null, location: null },
    ]);
  });

  // Este es el payload real de videos.list, no una maqueta: protege la forma
  // que de verdad tiene el canal, medida sobre las 636 descripciones.
  it("parses the real Caramelos De Cianuro description", () => {
    const payload = realFixture as YouTubeVideoPayload;
    const parsed = parseYouTubeDescription(payload.snippet?.["description"] as string);
    expect(parsed.sections.map((section) => section.kind)).toEqual(["tracklist", "musicians", "other_credits"]);
    expect(parsed.tracklist).toEqual([
      { title: "Chan², Chaca², Chan²", startSeconds: 0, position: 0 },
      { title: "Tu Mamá Te Va a Pegar", startSeconds: 247, position: 1 },
      { title: "La Bruja", startSeconds: 475, position: 2 },
      { title: "Nadando a Través De La Galaxia", startSeconds: 615, position: 3 },
    ]);
    // "Recorded & Mixed by Boris Milan": el verbo compuesto se conserva
    // entero. Con el vocabulario anterior esta línea no casaba con nada.
    // La fecha de sesión queda fuera del nombre, pero el valor crudo se
    // conserva íntegro: lo derivado no borra lo que la fuente dijo.
    expect(parsed.credits).toContainEqual(
      { verbs: ["recorded", "mixed"], preposition: "by", value: "Boris Milan, August 1992",
        sectionKind: "other_credits", names: ["Boris Milan"], venue: null, location: null },
    );
    expect(parsed.credits).toContainEqual(
      { verbs: ["recorded", "mixed"], preposition: "at", value: "Mad Box's Studios (Caracas, Venezuela)",
        sectionKind: "other_credits", names: [], venue: "Mad Box's Studios", location: "Caracas, Venezuela" },
    );
    expect(parsed.credits.some((credit) => credit.preposition === "at")).toBe(true);
  });

  // Variantes de encabezado que el corpus del canal impuso: sinónimos y una
  // errata. Cada una vale pistas reales que antes se perdían.
  it("accepts the heading variants measured in the channel", () => {
    const pistas = (heading: string) => parseYouTubeDescription(`${heading}\n\n01 - Vuelo Para Dos 00:00\n02 - Obsesión 03:15`).tracklist;
    for (const heading of ["Tracklist:", "Trackslist:", "Tracks", "Timestamps:", "Track List"]) {
      expect(pistas(heading), heading).toEqual([
        { title: "Vuelo Para Dos", startSeconds: 0, position: 0 },
        { title: "Obsesión", startSeconds: 195, position: 1 },
      ]);
    }
    // Bonus Tracks continúa la numeración: son pistas del mismo video.
    const conBonus = parseYouTubeDescription("Tracklist:\n01 - A 00:00\n\nBonus Track:\n02 - B 01:00");
    expect(conBonus.tracklist.map((t) => t.title)).toEqual(["A", "B"]);
    expect(conBonus.sections.map((s) => s.kind)).toEqual(["tracklist", "bonus_tracks"]);
  });

  it("separates the person from the studio in a credit line", () => {
    const parsed = parseYouTubeDescription("Other Credits\n\nRecorded & Mixed by Jesús Jiménez at Optilaser (Caracas, Venezuela)");
    expect(parsed.credits).toHaveLength(1);
    expect(parsed.credits[0]).toMatchObject({
      verbs: ["recorded", "mixed"], preposition: "by",
      names: ["Jesús Jiménez"], venue: "Optilaser", location: "Caracas, Venezuela",
    });
  });

  it("keeps band names with digits and drops session dates and caveats", () => {
    // "Zapato 3" y "Candy66" son bandas reales: el dígito no descalifica.
    const conDigito = parseYouTubeDescription("Other Credits\n\nProduced by Zapato 3");
    expect(conDigito.credits[0]?.names).toEqual(["Zapato 3"]);
    // La fecha de sesión no es parte del nombre.
    const conFecha = parseYouTubeDescription("Other Credits\n\nRecorded by Boris Milan, August 1992");
    expect(conFecha.credits[0]?.names).toEqual(["Boris Milan"]);
    // Una salvedad abre una lista de excepciones: ya no habla del acreditado.
    const conSalvedad = parseYouTubeDescription("Other Credits\n\nProduced by Felipe Grüber & Walter Gangi, except;");
    expect(conSalvedad.credits[0]?.names).toEqual(["Felipe Grüber", "Walter Gangi"]);
  });

  it("extracts role, person and track scope from musician blocks", () => {
    const description = [
      "Musicians", "", "Lead Vocals & Bass: Asier Cazalis", "Drums: Pablo Martínez", "",
      "Guest Musicians", "", "Additional Vocals: Marcos Rodríguez (track 13)", "",
      "Guitars:", "-Jefrey Sánchez (tracks 01,02,04)", "-Walter Gangi (tracks 01,02)",
    ].join("\n");
    const creditos = parseCreditSections(parseYouTubeDescription(description).sections);
    expect(creditos).toEqual([
      { role: "Lead Vocals & Bass", name: "Asier Cazalis", trackNumbers: [], sectionKind: "musicians" },
      { role: "Drums", name: "Pablo Martínez", trackNumbers: [], sectionKind: "musicians" },
      { role: "Additional Vocals", name: "Marcos Rodríguez", trackNumbers: [13], sectionKind: "guest_musicians" },
      { role: "Guitars", name: "Jefrey Sánchez", trackNumbers: [1, 2, 4], sectionKind: "guest_musicians" },
      { role: "Guitars", name: "Walter Gangi", trackNumbers: [1, 2], sectionKind: "guest_musicians" },
    ]);
  });

  it("reads artist, album, format and year out of the real title", () => {
    expect(parseYouTubeTitle("Caramelos De Cianuro - Las Paticas De La Abuela [EP] (1992) || Full Album ||"))
      .toEqual({ artist: "Caramelos De Cianuro", title: "Las Paticas De La Abuela", year: 1992, format: "EP", isFullAlbum: true });
    expect(parseYouTubeTitle("Spiteri - Spiteri (1981) || Full Album ||"))
      .toEqual({ artist: "Spiteri", title: "Spiteri", year: 1981, format: null, isFullAlbum: true });
    expect(parseYouTubeTitle("Various Artists - Rock: \"El Compilado\" Vol. 2 (2003) || Full Album ||"))
      .toMatchObject({ artist: "Various Artists", year: 2003 });
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
